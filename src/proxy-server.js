import http from 'node:http';
import https from 'node:https';

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function createProxyServer({ accountManager, secretStore, config }) {
  const upstream = config.upstream || 'https://api.anthropic.com';

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/internal/health') {
        sendJson(res, 200, {
          ok: true,
          currentAccount: accountManager.getStatus().currentAccount,
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/internal/status') {
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/switch') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        accountManager.switchTo(body.account);
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      const body = await readBody(req);
      await forwardWithRotation({ req, res, body, upstream, accountManager, secretStore });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 502, {
          type: 'error',
          error: { type: 'proxy_error', message: error.message },
        });
      } else {
        res.destroy(error);
      }
    }
  });
}

async function forwardWithRotation({ req, res, body, upstream, accountManager, secretStore }) {
  const maxAttempts = Math.max(1, accountManager.accounts.length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = accountManager.getActiveAccount();
    if (!account) {
      sendJson(res, 429, {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'All configured accounts are unavailable.' },
      });
      return;
    }

    const secret = await secretStore.get(account.id);
    if (!secret) {
      account.status = 'error';
      continue;
    }

    const result = await forwardOnce({ req, res, body, upstream, account, secret, accountManager });
    if (result.retryNextAccount) continue;
    return;
  }

  if (!res.headersSent) {
    sendJson(res, 429, {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'No account could satisfy the request.' },
    });
  }
}

async function forwardOnce({ req, res, body, upstream, account, secret, accountManager }) {
  const target = new URL(req.url, upstream);
  const headers = buildUpstreamHeaders(req.headers, account, secret);

  const upstreamResponse = await requestUpstream({
    target,
    method: req.method,
    headers,
    body,
    onResponse(upstreamRes) {
      accountManager.updateQuota(account.id, upstreamRes.headers);

      if (upstreamRes.statusCode === 429) {
        const retryAfter = Number.parseInt(upstreamRes.headers['retry-after'], 10) || 60;
        accountManager.markRateLimited(account.id, retryAfter);
        upstreamRes.resume();
        return false;
      }

      const responseHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      return true;
    },
    onChunk(chunk) {
      if (!res.destroyed) res.write(chunk);
    },
  });

  if (upstreamResponse.statusCode === 429) {
    return { retryNextAccount: true };
  }

  if (upstreamResponse.body.length > 0) {
    extractUsage(upstreamResponse.body, account.id, accountManager);
  }

  if (!res.writableEnded) res.end();
  return { retryNextAccount: false };
}

function buildUpstreamHeaders(inputHeaders, account, secret) {
  const headers = {};
  for (const [key, value] of Object.entries(inputHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower)) continue;
    if (lower === 'x-api-key' || lower === 'authorization') continue;
    headers[key] = value;
  }

  if (account.type === 'apikey') {
    headers['x-api-key'] = secret.apiKey;
  } else {
    headers.authorization = `Bearer ${secret.accessToken}`;
  }
  return headers;
}

function requestUpstream({ target, method, headers, body, onResponse, onChunk }) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, upstreamRes => {
      const shouldStream = onResponse(upstreamRes);
      const chunks = [];
      upstreamRes.on('data', chunk => {
        chunks.push(chunk);
        if (shouldStream) onChunk(chunk);
      });
      upstreamRes.on('end', () => {
        resolve({
          statusCode: upstreamRes.statusCode,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    if (!['GET', 'HEAD'].includes(method) && body.length > 0) req.write(body);
    req.end();
  });
}

function extractUsage(body, accountId, accountManager) {
  const text = body.toString('utf8');
  try {
    const json = JSON.parse(text);
    if (json.usage) {
      accountManager.updateUsage(accountId, {
        inputTokens: json.usage.input_tokens || 0,
        outputTokens: json.usage.output_tokens || 0,
      });
    }
    return;
  } catch {
    // Continue with SSE parsing.
  }

  for (const event of text.split('\n\n')) {
    const dataLine = event.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    try {
      const data = JSON.parse(dataLine.slice(6));
      if (data.type === 'message_start' && data.message?.usage) {
        accountManager.updateUsage(accountId, {
          inputTokens: data.message.usage.input_tokens || 0,
        });
      } else if (data.type === 'message_delta' && data.usage) {
        accountManager.updateUsage(accountId, {
          outputTokens: data.usage.output_tokens || 0,
        });
      }
    } catch {
      // Ignore non-JSON SSE payloads.
    }
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
