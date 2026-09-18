import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import {
  familyQuotaExhaustedOnly,
  isAuthExpiredReason,
  isCredentialRefreshCooldown,
  isUnifiedQuotaExhaustion,
} from './account-manager.js';
import { readCurrentClaudeCredentials } from './claude-credentials.js';
import {
  DEFAULT_USAGE_POLL_INTERVAL_MS,
  DEFAULT_USAGE_REFRESH_CONCURRENCY,
  DEFAULT_USAGE_REFRESH_REQUEST_SPACING_MS,
} from './config.js';
import {
  createSingleFlightTokenRefresher,
  fetchProfile,
  fetchUsage,
  isOAuthTokenRefreshRateLimit,
  isTokenExpiringSoon,
  OAUTH_BETA_HEADER,
  refreshAccessToken,
} from './oauth.js';
import { createNativeClaudeRefresher } from './native-claude-refresher.js';
import { isFableScopeIdentity, parseRateLimitHeaders } from './quota.js';
import { duplicateRefreshTokenAccountIds } from './secret-store.js';
import { sessionKeyFrom, sidHash } from './session-key.js';
import {
  DEFAULT_OBSERVABILITY,
  normalizeObservability,
  observationLogFields,
  parseUsageObservation,
  upstreamAcceptEncoding,
} from './usage-observation.js';
import {
  buildBridgeLogMeta,
  claudeAllUnusable,
  claudeEarliestResetAt,
  claudeQuotaState,
  createGptPoolState,
  formatLogMeta,
  mapClaudeExhaustion,
} from './degrade-state.js';
import {
  DEFAULT_OPENAI_BRIDGE,
  forwardToOpenAiBridge,
  logDegradeMappingConfigNotice,
  resolveOpenAiBridgeSettings,
  shouldRouteToOpenAiBridge,
} from './openai-bridge.js';

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

const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 180000;
const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_UPSTREAM_CONNECT_RETRIES = 3;
const DEFAULT_UPSTREAM_CONNECT_RETRY_DELAY_MS = 250;
const REACTIVE_QUOTA_CONFIRM_TIMEOUT_MS = 5_000;
const REACTIVE_QUOTA_EXHAUSTION_THRESHOLD = 1;
const REACTIVE_QUOTA_SINGLE_FLIGHT_GRACE_MS = 250;
const SCOPED_USAGE_FIELD_PREFIX = 'scoped_weekly:';
const SCOPED_USAGE_SNAPSHOT_FIELD = 'scoped_weekly:*';
const SCOPED_USAGE_MERGE_FIELD = 'scoped_weekly_merge';
const SCOPED_USAGE_PRESERVE_PREFIX = 'scoped_weekly_preserve:';
const DEFAULT_RESET_CHECK_DELAY_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_USABLE_ACCESS_TOKEN_LIFETIME_MS = 60_000;
const guardedUpstreamSockets = new WeakSet();

export function createProxyServer({
  accountManager,
  secretStore,
  credentialAccountsReader = null,
  config,
  reloadAccounts = null,
  reloadOpenAiBridge = null,
  reloadObservability = null,
  allowLiveClaudeCodeCredentials = true,
  tokenRefresher = null,
  currentCredentialReader = readCurrentClaudeCredentials,
  currentProfileFetcher = fetchProfile,
  usageFetcher = fetchUsage,
  reactiveQuotaConfirmTimeoutMs = REACTIVE_QUOTA_CONFIRM_TIMEOUT_MS,
  logger = null,
  stateWriter = null,
  platform = process.platform,
  serviceGeneration = null,
}) {
  assertLoopbackProxyHost(config.proxy?.host || '127.0.0.1');
  const upstream = config.upstream || 'https://api.anthropic.com';
  const upstreamIdleTimeoutMs = config.proxy?.upstreamIdleTimeoutMs
    ?? config.upstreamIdleTimeoutMs
    ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  const upstreamConnectTimeoutMs = config.proxy?.upstreamConnectTimeoutMs
    ?? config.upstreamConnectTimeoutMs
    ?? DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS;
  const upstreamConnectRetries = config.proxy?.upstreamConnectRetries
    ?? config.upstreamConnectRetries
    ?? DEFAULT_UPSTREAM_CONNECT_RETRIES;
  const upstreamConnectRetryDelayMs = config.proxy?.upstreamConnectRetryDelayMs
    ?? config.upstreamConnectRetryDelayMs
    ?? DEFAULT_UPSTREAM_CONNECT_RETRY_DELAY_MS;
  const resolvedTokenRefresher = tokenRefresher || defaultTokenRefresher({
    platform,
    nativeOptions: {
      onCleanupError(error) {
        logger?.(`${new Date().toISOString()} credential-refresh-cleanup result=failed errorType=${error?.code || error?.name || 'unknown'}`);
      },
    },
  });
  const coordinatedTokenRefresher = createSingleFlightTokenRefresher(
    refreshTokenWithCredentialSafety,
    {
      // Credential writes and native handoffs are serialized by the secret
      // store. Do not let a completed refresh result cross a later account
      // relink that happens to present the old refresh token.
      retentionMs: 0,
      onSuccess({ context, refreshed, rotated }) {
        logger?.(`${new Date().toISOString()} credential-refresh account=${context?.accountId || 'unknown'} result=success rotated=${rotated} expiresAt=${formatCredentialExpiry(refreshed.expiresAt)}`);
      },
      onFailure({ context, error, deferred = false }) {
        const retry = error?.retryAfterMs
          ? ` retryAfterSec=${Math.ceil(error.retryAfterMs / 1000)}`
          : '';
        const retrySource = ['provider', 'fallback', 'fixed'].includes(error?.retryAfterSource)
          ? ` retrySource=${error.retryAfterSource}`
          : '';
        const result = deferred ? 'deferred' : 'failed';
        logger?.(`${new Date().toISOString()} credential-refresh account=${context?.accountId || 'unknown'} result=${result} errorType=${credentialRefreshErrorType(error)}${retry}${retrySource}`);
      },
    },
  );
  const duplicateRefreshAccountIds = new Set();
  const duplicateRefreshAccounts = new WeakSet();
  let credentialOwnershipRestartRequired = false;
  let operationalStateCheck = Promise.resolve();

  const usageObservationTracker = createUsageObservationTracker();
  const usageRequestOptions = {
    connectTimeoutMs: upstreamConnectTimeoutMs,
    connectRetries: upstreamConnectRetries,
    connectRetryDelayMs: upstreamConnectRetryDelayMs,
  };
  const usageRefresher = createUsageRefresher({
    accountManager,
    secretStore,
    tokenRefresher: coordinatedTokenRefresher,
    currentCredentialReader,
    currentProfileFetcher,
    usageFetcher,
    usageRequestOptions,
    usageObservationTracker,
    allowLiveClaudeCodeCredentials,
    usageRefreshConcurrency: usagePollingConcurrency(config, accountManager.accounts.length),
    usageRefreshRequestSpacingMs: usagePollingRequestSpacingMs(config),
    beforeRefresh: async () => {
      await operationalStateCheck;
      if (credentialOwnershipRestartRequired) throw credentialOwnershipRestartError();
    },
    duplicateRefreshAccountIds,
    logger,
  });
  const reactiveQuotaConfirmer = createReactiveQuotaConfirmer({
    accountManager,
    secretStore,
    currentCredentialReader,
    usageFetcher,
    usageRequestOptions,
    usageObservationTracker,
    allowLiveClaudeCodeCredentials,
    timeoutMs: positiveTimeoutOrDefault(
      reactiveQuotaConfirmTimeoutMs,
      REACTIVE_QUOTA_CONFIRM_TIMEOUT_MS,
    ),
    logger,
  });
  const usageScheduler = createUsageRefreshScheduler({
    config,
    usageRefresher,
    persistState,
  });
  let persistTail = Promise.resolve();
  function persistState() {
    if (!stateWriter) return;
    const snapshot = accountManager.exportState();
    const write = persistTail.then(() => stateWriter(snapshot));
    persistTail = write.catch(error => {
      logger?.(`state persist failed: ${shortErrorMessage(error)}`);
    });
    return persistTail;
  }
  const checkPersistedRefreshIntents = async () => {
    if (await reconcilePersistedRefreshIntents({ accountManager, secretStore, logger })) {
      await persistState();
    }
  };
  const checkInitialCredentialState = async () => {
    replaceSet(
      duplicateRefreshAccountIds,
      await withCredentialSetLock(
        secretStore,
        () => duplicateRefreshTokenAccountIds(accountManager.accounts, secretStore),
      ),
    );
    if (parkDuplicateRefreshTokenAccounts({
      accountManager,
      duplicateRefreshAccountIds,
      duplicateRefreshAccounts,
    })) {
      await persistState();
    }
    await checkPersistedRefreshIntents();
  };
  async function refreshTokenWithCredentialSafety(refreshToken, context = {}) {
    const beforeHandoff = context.beforeHandoff;
    return resolvedTokenRefresher(refreshToken, {
      ...context,
      beforeHandoff: async () => {
        const credentialAccounts = credentialAccountsReader
          ? await credentialAccountsReader()
          : accountManager.accounts;
        if (!Array.isArray(credentialAccounts)) {
          throw new Error('Credential account configuration is invalid');
        }
        const nextDuplicateIds = await duplicateRefreshTokenAccountIds(
          credentialAccounts,
          secretStore,
        );
        replaceSet(duplicateRefreshAccountIds, nextDuplicateIds);
        if (parkDuplicateRefreshTokenAccounts({
          accountManager,
          duplicateRefreshAccountIds,
          duplicateRefreshAccounts,
        })) {
          await persistState();
        }
        if (nextDuplicateIds.has(context.accountId)) {
          throw duplicateRefreshTokenError();
        }
        await beforeHandoff?.();
      },
    });
  }
  operationalStateCheck = checkInitialCredentialState();
  operationalStateCheck.catch(() => {});

  // openaiBridge の設定解決結果はここでキャッシュする（起動時に1回、以後は
  // POST /internal/reload のときだけ再計算する）。毎リクエスト resolveOpenAiBridgeSettings()
  // を呼び直すと正規表現の再コンパイルとログの洪水を招く。
  // キャッシュ観測の設定。openaiBridge と同じく、起動時に1回だけ解決して
  // POST /internal/reload のときだけ作り直す。
  let observabilitySettings = normalizeObservability(config.observability);
  let openaiBridgeSettings = resolveOpenAiBridgeSettings(config);
  if (openaiBridgeSettings.warning) {
    logger?.(`${new Date().toISOString()} openai-bridge config-warning ${openaiBridgeSettings.warning}`);
  }
  // degradeMapping の設定通知（設計書 §7.2・§7.3-4）。reload 時も同じ関数を呼ぶ。
  // degradeMapping を書いていない構成では1行も出ない。
  logDegradeMappingConfigNotice(openaiBridgeSettings, logger);

  // GPT プール状態（設計書 §11.1 R3-4・契約 §C10.2）。プロセス内メモリだけで持ち、
  // degradeMapping が無効な構成では生成しない（null＝forwardToOpenAiBridge へも渡らず、
  // 応答もログも現行と完全に同一になる＝§14.4）。
  // 設計判断: POST /internal/reload では設定を読み直すだけでなく、学習済みの
  // 状態も破棄して作り直す。ロールバック（無効化→reload→再有効化）で古い unusable が
  // 残ると、実際には回復しているのに最大 gptPoolUnusableTtlMs の間 403 で止めてしまう。
  // 未知（unknown）は「利用可能扱い」なので、破棄は常に安全側へ倒れる。
  const createGptPoolStateFor = settings => (settings.degradeMapping?.enabled === true
    ? createGptPoolState({
      unusableTtlMs: settings.degradeMapping.gptPoolUnusableTtlMs,
      // 層1（T2b・T6b・キャッシュ非学習）は recoveryWaitEnabled の配下に置く
      // （統合設計 v2.1 §2.1 案A）。層1 は 403 書換の条件③を通じて応答バイトを変えうる
      // ので、「フラグ off ＝現行とバイト互換」を保つには同じフラグで切る必要がある。
      recoveryWaitEnabled: settings.degradeMapping.recoveryWaitEnabled === true,
    })
    : null);
  let gptPoolState = createGptPoolStateFor(openaiBridgeSettings);

  // 設計書 §4.2 案b-2・契約 §C10.4: 「Claude の口座がもう使えない」として 429 を
  // 書き出す**すべての**経路（P-a〜P-g の7系統）が、書き出す直前に必ずここを通る。
  // 経路ごとの個別書換ロジックは書かない（1か所でも漏れると「ある条件でだけ退避
  // しない」という再現困難な不具合になるため）。
  //
  // degradeMapping が無効な構成では呼び出し側へ渡さない（下の forwardWithRotation
  // の条件つきスプレッド）ので、応答もログも現行とバイト単位で同一になる（§14.4）。
  // ここでも enabled をもう一度見るのは、POST /internal/reload で無効化された直後の
  // 進行中要求が古い判定へ落ちないようにするためである。
  const applyClaudeExhaustionMapping = (candidate, {
    mapPath = null,
    modelFamily = null,
    headersSent = false,
  } = {}) => {
    const mapping = openaiBridgeSettings.degradeMapping;
    if (mapping?.enabled !== true || !candidate) return candidate;
    // 判定根拠は accountManager の台帳（isAvailable）であって応答の見た目ではない
    // （設計書 §4.3・契約 §C10.4）。GPT 側は学習済みの (pool) 鍵だけを見る。
    const pool = gptPoolState ? gptPoolState.read().pool : null;
    const gptState = pool?.state || 'unknown';
    const allUnusable = claudeAllUnusable(accountManager, modelFamily);
    // 403（恒久拒否）へ昇格してよいかは**共通枠**（modelFamily 無し）で問い直す。
    // scopeMatchesModelFamily() は modelFamily=null のとき Fable 週次サブキャップを
    // 無視するので、「Fable のサブキャップだけが全口座で切れているが共通枠は残って
    // いる」状態はここで false になり、403 ではなく 529 のまま Opus へ退避できる
    // （§4.2。gpt-* 経路が最初から null で問うているのと同じ根拠）。
    // modelFamily が無い要求では同じ判定なので台帳を二度引かない。
    const commonAllUnusable = allUnusable
      ? (modelFamily ? claudeAllUnusable(accountManager, null) : true)
      : false;
    // 層2（recoveryWaitEnabled のときだけ）: 共通枠の空きを三値で問い直す。判定不能
    // （判定関数が無い・口座0件・判定中の例外）を「空きあり」へ丸めず、待機側へ倒す
    // （統合設計 v2.1 §3.5）。二値の commonAllUnusable は off 経路のためそのまま残す。
    const recoveryWaitEnabled = mapping.recoveryWaitEnabled === true;
    const commonQuota = recoveryWaitEnabled
      ? (allUnusable ? claudeQuotaState(accountManager, null) : 'available')
      : undefined;
    const mapped = mapClaudeExhaustion(candidate, {
      enabled: true,
      mapPath,
      headersSent,
      claudeAllUnusable: allUnusable,
      commonFamilyAllUnusable: commonAllUnusable,
      recoveryWaitEnabled,
      commonFamilyQuotaState: commonQuota,
      gptPoolState: gptState,
      bothUnusableStatus: mapping.bothUnusableStatus,
      gptResetAt: pool?.resetAt || null,
      // 403 の本文へ載せる「最早回復時刻」にしか使わない（§8.7）。判定には使わない
      // ので、403 になりうる組み合わせのときだけ台帳を引く。403 の根拠は**共通枠**の
      // 枯渇なので、回復時刻も共通枠（modelFamily 無し）で問う。要求系列で引くと、
      // Fable 週次サブキャップのように共通枠より遠いリセットを表示してしまう。
      claudeResetAt: (commonAllUnusable || commonQuota === 'indeterminate') && gptState === 'unusable'
        ? claudeEarliestResetAt(accountManager, null)
        : null,
    });
    // R4-5: 痕跡（degradeLog）はここでは書き出さない。呼び出し側が mapped.degradeLog を
    // そのまま recordProxyRequest へ渡し、**その要求の既存の proxy ログ行**へ併記する
    // （設計書 §9.1・§9.5(c)・受入条件7）。行を増やさないので、写像しなかった要求と
    // degradeMapping を書いていない構成ではログは1文字も変わらない（§14.4）。
    return mapped;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!isTrustedLocalHttpRequest(req)) {
        sendJson(res, 403, {
          type: 'error',
          error: { type: 'forbidden', message: 'Cross-site proxy requests are not allowed' },
        });
        return;
      }
      // /internal/health must stay a cheap liveness probe: reconciling
      // persisted refresh intents (below) can take up to the account lock's
      // full acquire timeout per account, which would otherwise make
      // install/reinstall's bounded health poll (see waitForMacosHealth)
      // time out and roll back the install whenever any account's lock is
      // briefly held by a concurrent refresh.
      if (req.method === 'GET' && req.url === '/internal/health') {
        sendJson(res, 200, {
          ok: true,
          currentAccount: accountManager.getStatus().currentAccount,
          ...(serviceGeneration ? { serviceGeneration } : {}),
        });
        return;
      }
      await operationalStateCheck;

      if (req.method === 'GET' && req.url === '/internal/status') {
        if (
          !credentialOwnershipRestartRequired
          && usagePollingEnabled(config)
          && !usageScheduler.hasAttempted()
        ) {
          await usageScheduler.refreshNow();
        }
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/switch') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        accountManager.switchTo(body.account);
        await persistState();
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/reload') {
        invalidateLiveClaudeCodeCache();
        if (reloadAccounts) {
          const reloadResult = normalizeReloadAccountsResult(
            await reloadAccounts(),
            allowLiveClaudeCodeCredentials,
          );
          if (
            credentialOwnershipRestartRequired
            || reloadResult.allowLiveClaudeCodeCredentials !== allowLiveClaudeCodeCredentials
          ) {
            credentialOwnershipRestartRequired = true;
            sendCredentialOwnershipRestartRequired(res, 409);
            return;
          }
          const { accounts } = reloadResult;
          if (reloadResult.validationError) throw reloadResult.validationError;
          const nextDuplicateIds = await withCredentialSetLock(
            secretStore,
            () => duplicateRefreshTokenAccountIds(accounts, secretStore),
          );
          const ownedDuplicateIds = duplicateRefreshErrorAccountIds(accountManager, duplicateRefreshAccounts);
          let duplicateStateChanged = clearResolvedDuplicateRefreshErrors({
            accountManager,
            duplicateRefreshAccountIds: nextDuplicateIds,
            duplicateRefreshAccounts,
          });
          accountManager.replaceAccounts(accounts);
          replaceSet(duplicateRefreshAccountIds, nextDuplicateIds);
          duplicateStateChanged = parkDuplicateRefreshTokenAccounts({
            accountManager,
            duplicateRefreshAccountIds,
            duplicateRefreshAccounts,
            ownedDuplicateIds,
          }) || duplicateStateChanged;
          if (duplicateStateChanged) await persistState();
        }
        // 既存の口座再読込に続けて openaiBridge を再読込する（仕様書 4.2.6 節）。
        // 口座再読込のロジックには一切触れない。
        if (reloadOpenAiBridge) {
          const nextOpenaiBridge = await reloadOpenAiBridge();
          // openaiBridge セクションが無い、または config.json 自体が無い場合
          // （reloadOpenAiBridge が undefined を返す）は既定（オフ）へ戻す。
          // 旧実装は falsy を「変更なし」と誤認し、削除後も古い（有効な）
          // 設定を保持し続けるバグがあった。
          config.openaiBridge = nextOpenaiBridge !== undefined
            ? nextOpenaiBridge
            : { ...DEFAULT_OPENAI_BRIDGE };
          openaiBridgeSettings = resolveOpenAiBridgeSettings(config);
          // 学習済みの GPT プール状態を破棄して作り直す（無効化されたときは
          // 破棄だけを行う）。reload 後は必ず学習前＝unknown から始まる。
          gptPoolState = createGptPoolStateFor(openaiBridgeSettings);
          logger?.(
            `${new Date().toISOString()} openai-bridge reload enabled=${openaiBridgeSettings.enabled} `
            + `url=${openaiBridgeSettings.url}${openaiBridgeSettings.warning ? ` warning="${openaiBridgeSettings.warning}"` : ''}`,
          );
          logDegradeMappingConfigNotice(openaiBridgeSettings, logger);
        }
        // キャッシュ観測の再読込。セクションが無い・config.json 自体が無い
        // （reloadObservability が undefined を返す）ときは既定へ戻す。
        // **毎回 normalizeObservability() を通し直すこと。** 起動時の1回きりの
        // 正規化を使い回すと、reload で入ってきた値にクランプが効かない。
        if (reloadObservability) {
          const nextObservability = await reloadObservability();
          config.observability = nextObservability;
          observabilitySettings = normalizeObservability(nextObservability);
        }
        // Reconcile in the background instead of awaiting it (or replacing
        // the shared operationalStateCheck gate other requests await): each
        // account's reconcile can block on that account's file lock for up
        // to its full acquire timeout, and every other in-flight request
        // (including /internal/status and proxied /v1/messages calls) would
        // otherwise stall behind this single reload until it finishes.
        checkPersistedRefreshIntents().catch(error => {
          logger?.(`${new Date().toISOString()} reload-reconcile result=failed error=${shortErrorMessage(error)}`);
        });
        if (usagePollingEnabled(config)) {
          await usageScheduler.refreshNow({ afterCurrent: true });
        }
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/refresh-usage') {
        if (credentialOwnershipRestartRequired) {
          sendCredentialOwnershipRestartRequired(res, 503);
          return;
        }
        sendJson(res, 200, await usageScheduler.refreshNow());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/prepare-resume') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (body.refreshUsage && credentialOwnershipRestartRequired) {
          sendCredentialOwnershipRestartRequired(res, 503);
          return;
        }
        if (body.refreshUsage) await usageScheduler.refreshNow();
        const result = accountManager.prepareResumeTarget();
        await persistState();
        sendJson(res, 200, {
          ...result,
          status: accountManager.getStatus(),
        });
        return;
      }

      if (credentialOwnershipRestartRequired) {
        sendCredentialOwnershipRestartRequired(res, 503);
        return;
      }

      try {
        configuredUpstreamTarget(req.url, upstream);
      } catch {
        sendJson(res, 400, {
          type: 'error',
          error: { type: 'invalid_request_target', message: 'Invalid request target' },
        });
        return;
      }
      const body = await readBody(req);
      // openaiBridgeSettings はキャッシュ済み（起動時・reload 時にのみ再計算）。
      // config-warning のログもここでは出さず、起動時・reload 時に1回だけ出す。
      const openaiBridgeRouting = shouldRouteToOpenAiBridge(body, openaiBridgeSettings);
      if (openaiBridgeRouting.route) {
        // 経路はここで OpenAI 宛に固定される。以後どのような失敗でも
        // forwardWithRotation()（Anthropic 宛）へは迂回しない（仕様書 4.2.2 節 c）。
        await forwardToOpenAiBridge({
          req,
          res,
          body,
          model: openaiBridgeRouting.model,
          settings: openaiBridgeSettings,
          logger,
          // degradeMapping.enabled が真のときだけ渡す（未指定＝現行と同一の経路）。
          ...(gptPoolState ? {
            gptPoolState,
            // 関数で渡すのは、要求の開始時点ではなく bridge の応答ヘッダを受け取った
            // 時点の台帳で判定するためである（設計書 §11.1 R4-1 の補足）。
            // gpt-* の要求に Claude の modelFamily は無いので null（＝共通枠）で問う
            // （§4.2）。Fable 週次サブキャップだけの枯渇では「Claude は使える」と判定され、
            // 403 で止めずに 529 のまま Opus へ退避させる。
            claudeAllUnusable: () => claudeAllUnusable(accountManager, null),
            // 三値版（統合設計 v2.1 §3.5）。二値版を残したまま隣に足す。引数は共通枠
            // （modelFamily = null）で揃える——契約の条件2 が参照するのと同じ引数であり、
            // 系列付きにすると契約と実装がずれる。
            claudeQuotaState: () => claudeQuotaState(accountManager, null),
            // 403 の本文へ載せる「最早回復時刻」の Claude 側の候補（§8.7）。
            // 全枯渇と判定したときだけ呼ばれる。判定そのものには使わない。
            claudeResetAt: () => claudeEarliestResetAt(accountManager, null),
          } : {}),
        });
        return;
      }
      // 本文が空（HEAD/GET 等）の要求は JSON パース失敗と区別できないため無ログに
      // する。実際に本文があってパースに失敗した場合、または
      // modelPattern コンパイル失敗で分岐が無効化された場合だけを記録する。
      if (
        openaiBridgeRouting.reason === 'parse-error'
        && body.length > 0
        && (openaiBridgeSettings.enabled || openaiBridgeSettings.warning)
      ) {
        logger?.(
          `${new Date().toISOString()} openai-bridge model=- method=${req.method} `
          + `path=${safeRequestPath(req.url)} status=- durationMs=0 outcome=parse-error-fallback`,
        );
      }
      if (usagePollingEnabled(config) && !usageScheduler.hasAttempted()) {
        await usageScheduler.refreshNow();
      }
      await forwardWithRotation({
        req,
        res,
        body,
        upstream,
        accountManager,
        secretStore,
        tokenRefresher: coordinatedTokenRefresher,
        currentCredentialReader,
        currentProfileFetcher,
        reactiveQuotaConfirmer,
        allowLiveClaudeCodeCredentials,
        logger,
        upstreamIdleTimeoutMs,
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
        // degradeMapping.enabled が真のときだけ渡す（未指定＝現行と完全に同一の経路。
        // 設計書 §14.4「exhaustionMapper を渡さない forwardOnce が現行と同一に振る舞う」）。
        ...(openaiBridgeSettings.degradeMapping?.enabled === true
          ? { exhaustionMapper: applyClaudeExhaustionMapping }
          : {}),
        observability: observabilitySettings,
      });
      await persistState();
    } catch (error) {
      const message = shortErrorMessage(error);
      logger?.(`${new Date().toISOString()} proxy-error method=${req.method} path=${safeRequestPath(req.url)} error=${message}`);
      if (!res.headersSent) {
        sendJson(res, 502, {
          type: 'error',
          error: { type: 'proxy_error', message },
        });
      } else {
        res.destroy(error);
      }
    }
  });

  usageScheduler.start(server);
  return server;
}

async function reconcilePersistedRefreshIntents({ accountManager, secretStore, logger }) {
  let changed = false;
  for (const account of accountManager.accounts) {
    if (
      account.type === 'apikey'
      || account.id === 'current'
      || account.credentialSource === 'claude-code-current'
    ) continue;
    try {
      await getOperationalSecret(secretStore, account.id);
    } catch (error) {
      if (error?.code !== 'NATIVE_REFRESH_OUTCOME_UNKNOWN') {
        logger?.(`${new Date().toISOString()} credential-state-check account=${account.id} result=failed errorType=${error?.code || error?.name || 'unknown'}`);
        continue;
      }
      if (account.errorReason?.type !== 'oauth_refresh_failed') {
        accountManager.markError(
          account.id,
          'oauth_refresh_failed',
          'OAuth token refresh failed',
          authErrorDetails(credentialRefreshErrorType(error), accountManager.now()),
        );
        changed = true;
      }
    }
  }
  return changed;
}

function replaceSet(target, values) {
  target.clear();
  for (const value of values) target.add(value);
}

function duplicateRefreshErrorAccountIds(accountManager, duplicateRefreshAccounts) {
  return new Set(
    accountManager.accounts
      .filter(account => duplicateRefreshAccounts.has(account))
      .map(account => account.id),
  );
}

function parkDuplicateRefreshTokenAccounts({
  accountManager,
  duplicateRefreshAccountIds,
  duplicateRefreshAccounts,
  ownedDuplicateIds = new Set(),
}) {
  let changed = false;
  for (const account of accountManager.accounts) {
    if (!duplicateRefreshAccountIds.has(account.id)) continue;
    if (ownedDuplicateIds.has(account.id)) duplicateRefreshAccounts.add(account);
    if (account.errorReason?.type === 'oauth_refresh_failed') continue;
    // No error object here: the account is parked because it shares a refresh
    // credential with another account, which is detected rather than thrown.
    accountManager.markError(
      account.id,
      'oauth_refresh_failed',
      'OAuth token refresh failed',
      authErrorDetails('DUPLICATE_REFRESH_TOKEN', accountManager.now()),
    );
    duplicateRefreshAccounts.add(account);
    changed = true;
  }
  return changed;
}

function clearResolvedDuplicateRefreshErrors({
  accountManager,
  duplicateRefreshAccountIds,
  duplicateRefreshAccounts,
}) {
  let changed = false;
  for (const account of accountManager.accounts) {
    if (!duplicateRefreshAccounts.has(account) || duplicateRefreshAccountIds.has(account.id)) continue;
    accountManager.markAuthenticated(account);
    changed = true;
  }
  return changed;
}

function normalizeReloadAccountsResult(result, currentAllowLiveClaudeCodeCredentials) {
  if (Array.isArray(result)) {
    return {
      accounts: result,
      allowLiveClaudeCodeCredentials: currentAllowLiveClaudeCodeCredentials,
    };
  }
  if (
    !result
    || !Array.isArray(result.accounts)
    || typeof result.allowLiveClaudeCodeCredentials !== 'boolean'
  ) {
    throw new Error('Reloaded credential configuration is invalid');
  }
  return result;
}

async function withCredentialSetLock(secretStore, operation) {
  if (typeof secretStore?.runCredentialSetExclusive === 'function') {
    return secretStore.runCredentialSetExclusive(operation);
  }
  return operation();
}

function duplicateRefreshTokenError() {
  const error = new Error('OAuth refresh token is linked to multiple accounts');
  error.code = 'DUPLICATE_REFRESH_TOKEN';
  return error;
}

function credentialOwnershipRestartError() {
  const error = new Error('Credential ownership changed; restart claude-rotator before continuing.');
  error.code = 'CREDENTIAL_OWNERSHIP_RESTART_REQUIRED';
  return error;
}

function sendCredentialOwnershipRestartRequired(res, statusCode) {
  sendJson(res, statusCode, {
    type: 'error',
    error: {
      type: 'restart_required',
      message: 'Credential ownership changed; restart claude-rotator before continuing.',
    },
  });
}

export function defaultTokenRefresher({
  platform = process.platform,
  nativeRefresherFactory = createNativeClaudeRefresher,
  directRefresher = refreshAccessToken,
  nativeOptions = {},
} = {}) {
  if (platform === 'linux' || platform === 'darwin') {
    return nativeRefresherFactory({ ...nativeOptions, platform });
  }
  return directRefresher;
}

function usagePollingEnabled(config) {
  return config.usagePolling?.enabled === true;
}

function createUsageRefreshScheduler({
  config,
  usageRefresher,
  now = () => Date.now(),
  persistState = async () => {},
}) {
  let timer = null;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const scheduleFromStatus = status => {
    if (!usagePollingEnabled(config)) return;
    stop();
    const delayMs = nextUsageRefreshDelay(status, config, now());
    if (delayMs == null) return;
    timer = setTimeout(() => {
      timer = null;
      refreshNow().catch(() => {
        scheduleFromStatus(null);
      });
    }, delayMs);
    timer.unref?.();
  };

  const refreshNow = async (options = {}) => {
    const result = await usageRefresher.refreshAll(options);
    await persistState();
    scheduleFromStatus(result.status);
    return result;
  };

  const start = server => {
    if (!usagePollingEnabled(config)) return;
    refreshNow().catch(() => {
      scheduleFromStatus(null);
    });
    server.on('close', stop);
  };

  return {
    start,
    refreshNow,
    hasAttempted: usageRefresher.hasAttempted,
  };
}

function nextUsageRefreshDelay(status, config, nowMs) {
  const delays = [];
  const resetCheckDelayMs = Number(config.usagePolling?.resetCheckDelayMs) || DEFAULT_RESET_CHECK_DELAY_MS;
  const resetAt = nextExhaustedQuotaResetAt(status);
  if (resetAt != null) {
    delays.push(Math.max(0, resetAt - nowMs) + resetCheckDelayMs);
  }
  const retryAt = nextTemporaryRetryAt(status);
  if (retryAt != null) {
    delays.push(Math.max(0, retryAt - nowMs) + resetCheckDelayMs);
  }

  const intervalMs = usagePollingIntervalMs(config);
  if (intervalMs != null) delays.push(intervalMs);

  if (delays.length === 0) return null;
  return clampTimerDelay(Math.min(...delays));
}

function usagePollingIntervalMs(config) {
  const raw = config.usagePolling?.intervalMs;
  const value = raw == null ? DEFAULT_USAGE_POLL_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function usagePollingConcurrency(config, accountCount) {
  const parsed = Number(config.usagePolling?.concurrency);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(1, Math.min(accountCount || 1, DEFAULT_USAGE_REFRESH_CONCURRENCY));
  return Math.max(1, Math.min(accountCount || 1, Math.floor(parsed)));
}

function usagePollingRequestSpacingMs(config) {
  const raw = config.usagePolling?.requestSpacingMs;
  const value = raw == null ? DEFAULT_USAGE_REFRESH_REQUEST_SPACING_MS : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function nextExhaustedQuotaResetAt(status) {
  const resetTimes = [];
  for (const account of status?.accounts || []) {
    const reason = account.unavailableReason;
    if (!isUnifiedQuotaExhaustion(reason) || !reason.resetAt) continue;
    const resetAt = Date.parse(reason.resetAt);
    if (Number.isFinite(resetAt)) resetTimes.push(resetAt);
  }
  if (resetTimes.length === 0) return null;
  return Math.min(...resetTimes);
}

function nextTemporaryRetryAt(status) {
  const retryTimes = [];
  for (const account of status?.accounts || []) {
    const retryAt = Date.parse(account.rateLimitedUntil || account.unavailableReason?.retryAt || '');
    if (Number.isFinite(retryAt)) retryTimes.push(retryAt);
  }
  if (retryTimes.length === 0) return null;
  return Math.min(...retryTimes);
}

function clampTimerDelay(delayMs) {
  if (!Number.isFinite(delayMs)) return DEFAULT_RESET_CHECK_DELAY_MS;
  return Math.max(0, Math.min(delayMs, MAX_TIMER_DELAY_MS));
}

function createUsageRefresher({
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  currentProfileFetcher,
  usageFetcher,
  allowLiveClaudeCodeCredentials,
  usageRequestOptions,
  usageObservationTracker,
  usageRefreshConcurrency,
  usageRefreshRequestSpacingMs,
  beforeRefresh,
  duplicateRefreshAccountIds,
  logger,
}) {
  let inFlight = null;
  let attempted = false;
  const refreshAll = async ({ afterCurrent = false } = {}) => {
    await beforeRefresh?.();
    if (inFlight) {
      if (!afterCurrent) return inFlight;
      const current = inFlight;
      try {
        await current;
      } catch {}
      return refreshAll();
    }
    inFlight = refreshAllOnce({
      accountManager,
      secretStore,
      tokenRefresher,
      currentCredentialReader,
      currentProfileFetcher,
      usageFetcher,
      allowLiveClaudeCodeCredentials,
      usageRequestOptions,
      usageObservationTracker,
      usageRefreshConcurrency,
      usageRefreshRequestSpacingMs,
      duplicateRefreshAccountIds,
      logger,
    }).finally(() => {
      attempted = true;
      inFlight = null;
    });
    return inFlight;
  };
  return {
    refreshAll,
    hasAttempted: () => attempted,
  };
}

function createUsageObservationTracker() {
  let nextGeneration = 0;
  const states = new WeakMap();

  const stateFor = account => {
    let state = states.get(account);
    if (!state) {
      state = {
        latestStarted: 0,
        latestSuccessful: 0,
        pending: new Set(),
        fieldGenerations: new Map(),
        fieldEvidence: new Map(),
        deferredFailures: [],
      };
      states.set(account, state);
    }
    return state;
  };

  const settleDeferredFailures = state => {
    const remaining = [];
    for (const deferred of state.deferredFailures) {
      if (state.latestSuccessful > deferred.generation) continue;
      if ([...state.pending].some(generation => generation > deferred.generation)) {
        remaining.push(deferred);
        continue;
      }
      deferred.applyFailure();
    }
    state.deferredFailures = remaining;
  };

  return {
    start(account, accessToken = null) {
      nextGeneration += 1;
      const state = stateFor(account);
      state.latestStarted = nextGeneration;
      state.pending.add(nextGeneration);
      return {
        account,
        generation: nextGeneration,
        credentialFingerprint: usageCredentialFingerprint(accessToken),
        completed: false,
      };
    },
    bindCredential(observation, accessToken) {
      if (observation.completed) return;
      observation.credentialFingerprint = usageCredentialFingerprint(accessToken);
    },
    apply(observation, usage, applyUsage) {
      if (observation.completed) return observation.result;
      const state = stateFor(observation.account);
      const fields = usageObservationFields(usage);
      const acceptedFields = new Set();
      const scopedSnapshotGeneration = state.fieldGenerations.get(
        SCOPED_USAGE_SNAPSHOT_FIELD,
      ) || 0;
      const newerScopedFields = [...state.fieldGenerations.entries()]
        .filter(([field, generation]) => (
          isScopedUsageField(field) && generation > observation.generation
        ))
        .map(([field]) => field);
      for (const [field, evidence] of fields) {
        if (field === SCOPED_USAGE_SNAPSHOT_FIELD) continue;
        if (
          isScopedUsageField(field)
          && observation.generation < scopedSnapshotGeneration
        ) continue;
        if (observation.generation < (state.fieldGenerations.get(field) || 0)) continue;
        acceptedFields.add(field);
      }
      if (
        fields.has(SCOPED_USAGE_SNAPSHOT_FIELD)
        && observation.generation >= scopedSnapshotGeneration
      ) {
        acceptedFields.add(SCOPED_USAGE_SNAPSHOT_FIELD);
        if (newerScopedFields.length > 0) {
          acceptedFields.add(SCOPED_USAGE_MERGE_FIELD);
          for (const field of newerScopedFields) {
            acceptedFields.add(
              `${SCOPED_USAGE_PRESERVE_PREFIX}${scopedUsageIdentityFromField(field)}`,
            );
          }
        }
      }
      if (acceptedFields.size > 0) applyUsage(acceptedFields);
      if (acceptedFields.has(SCOPED_USAGE_SNAPSHOT_FIELD)) {
        const preserved = new Set(newerScopedFields);
        for (const field of state.fieldGenerations.keys()) {
          if (
            isScopedUsageField(field)
            && !preserved.has(field)
            && !acceptedFields.has(field)
          ) state.fieldGenerations.delete(field);
        }
        for (const field of state.fieldEvidence.keys()) {
          if (
            isScopedUsageField(field)
            && !preserved.has(field)
            && !acceptedFields.has(field)
          ) state.fieldEvidence.delete(field);
        }
      }
      for (const field of acceptedFields) {
        if (!fields.has(field)) continue;
        state.fieldGenerations.set(field, observation.generation);
        state.fieldEvidence.set(field, {
          generation: observation.generation,
          credentialFingerprint: observation.credentialFingerprint,
          evidence: fields.get(field),
        });
      }
      state.latestSuccessful = Math.max(state.latestSuccessful, observation.generation);
      state.pending.delete(observation.generation);
      observation.completed = true;
      observation.result = { acceptedFields };
      settleDeferredFailures(state);
      return observation.result;
    },
    fail(observation) {
      if (observation.completed) return;
      const state = stateFor(observation.account);
      state.pending.delete(observation.generation);
      observation.completed = true;
      settleDeferredFailures(state);
    },
    deferFailure(observation, applyFailure) {
      const state = stateFor(observation.account);
      if (state.latestSuccessful > observation.generation) return true;
      if ([...state.pending].some(generation => generation > observation.generation)) {
        state.deferredFailures.push({
          generation: observation.generation,
          applyFailure,
        });
        return true;
      }
      return false;
    },
    hasNewerStarted(observation) {
      return observation.generation < stateFor(observation.account).latestStarted;
    },
    newerSuccessfulEvidence(observation) {
      const state = stateFor(observation.account);
      if (
        state.latestSuccessful <= observation.generation
        || state.latestSuccessful !== state.latestStarted
      ) return null;
      const fieldEvidence = [...state.fieldEvidence.entries()]
        .filter(([, value]) => value.generation === state.latestSuccessful);
      if (
        !observation.credentialFingerprint
        || fieldEvidence.some(([, value]) => (
          value.credentialFingerprint !== observation.credentialFingerprint
        ))
      ) return null;
      return {
        generation: state.latestSuccessful,
        evidence: fieldEvidence.map(([field, value]) => [field, value.evidence]),
      };
    },
    currentSuccessfulEvidence(account, generation, credentialFingerprint = null) {
      const state = stateFor(account);
      if (state.latestStarted !== generation || state.latestSuccessful !== generation) return [];
      return [...state.fieldEvidence.entries()]
        .filter(([, value]) => (
          value.generation === generation
          && (!credentialFingerprint || value.credentialFingerprint === credentialFingerprint)
        ))
        .map(([field, value]) => [field, value.evidence]);
    },
  };
}

function createReactiveQuotaConfirmer({
  accountManager,
  secretStore,
  currentCredentialReader,
  usageFetcher,
  usageRequestOptions,
  usageObservationTracker,
  allowLiveClaudeCodeCredentials = true,
  timeoutMs,
  logger,
}) {
  const inFlight = new WeakMap();

  const fetchAndApply = ({ account, accessToken }) => {
    let accountFlights = inFlight.get(account);
    if (!accountFlights) {
      accountFlights = new Map();
      inFlight.set(account, accountFlights);
    }
    const existing = accountFlights.get(accessToken);
    if (existing) return existing;

    const observation = usageObservationTracker.start(account, accessToken);
    const entry = {
      abortController: new AbortController(),
      completed: false,
      deadline: null,
      expired: false,
      request: null,
      waiters: 0,
    };
    entry.request = Promise.resolve()
      .then(() => {
        if (!accountManager.accounts.includes(account)) {
          const error = new Error('Reactive quota account changed before usage confirmation');
          error.code = 'REACTIVE_QUOTA_ACCOUNT_STALE';
          throw error;
        }
        return Promise.all([
          usageFetcher(accessToken, {
            ...usageRequestOptions,
            timeoutMs,
            connectTimeoutMs: Math.min(
              Number(usageRequestOptions.connectTimeoutMs) || timeoutMs,
              timeoutMs,
            ),
            connectRetries: 0,
            connectRetryDelayMs: 0,
            signal: entry.abortController.signal,
          }),
          snapshotKnownAvailableAlternates({
            accountManager,
            account,
            secretStore,
            currentCredentialReader,
            allowLiveClaudeCodeCredentials,
            signal: entry.abortController.signal,
          }),
        ]);
      })
      .then(([usage, replayTargets]) => {
        if (entry.expired || !accountManager.accounts.includes(account)) {
          usageObservationTracker.fail(observation);
          return { applied: false, stale: true };
        }
        const safeUsage = safeUsageObservation(
          usage,
          accountManager.switchThreshold,
          accountManager.now(),
        );
        const result = usageObservationTracker.apply(observation, safeUsage, acceptedFields => {
          accountManager.applyUsage(
            account.id,
            usagePayloadForFields(safeUsage, acceptedFields, account),
          );
        });
        return {
          observation,
          safeUsage,
          result,
          replayTargets,
          stale: false,
        };
      }, error => {
        usageObservationTracker.fail(observation);
        entry.abortController.abort();
        throw error;
      });
    accountFlights.set(accessToken, entry);
    entry.expire = () => {
      if (entry.completed || entry.expired) return;
      entry.expired = true;
      if (accountFlights.get(accessToken) === entry) accountFlights.delete(accessToken);
      if (accountFlights.size === 0 && inFlight.get(account) === accountFlights) {
        inFlight.delete(account);
      }
      usageObservationTracker.fail(observation);
      entry.abortController.abort();
    };
    entry.deadline = withDeadline(entry.request, timeoutMs, entry.expire);
    const cleanup = () => {
      entry.completed = true;
      if (accountFlights.get(accessToken) === entry) accountFlights.delete(accessToken);
      if (accountFlights.size === 0 && inFlight.get(account) === accountFlights) {
        inFlight.delete(account);
      }
    };
    entry.request.then(
      () => {
        entry.completed = true;
        const timer = setTimeout(cleanup, REACTIVE_QUOTA_SINGLE_FLIGHT_GRACE_MS);
        timer.unref?.();
      },
      cleanup,
    );
    return entry;
  };

  return {
    async confirm({
      account,
      accessToken,
      requestBody,
      clientRequest = null,
      clientResponse = null,
    }) {
      const modelFamily = requestModelFamily(requestBody);
      let clientAborted = false;
      let entry = null;
      try {
        entry = fetchAndApply({ account, accessToken });
        entry.waiters += 1;
        const result = await waitForClientOrPromise(
          entry.deadline,
          clientRequest,
          clientResponse,
          () => { clientAborted = true; },
        );
        if (
          entry.expired
          || result.stale
          || !accountManager.accounts.includes(account)
        ) return { confirmed: false, replayTargets: new Set() };
        const directEvidence = !usageObservationTracker.hasNewerStarted(result.observation)
          && usageEvidenceConfirmsRequest(
            usageObservationFields(result.safeUsage),
            REACTIVE_QUOTA_EXHAUSTION_THRESHOLD,
            modelFamily,
            accountManager.now(),
          );
        const newerObservation = usageObservationTracker.newerSuccessfulEvidence(
          result.observation,
        );
        const newerEvidence = usageEvidenceConfirmsRequest(
          newerObservation?.evidence || [],
          REACTIVE_QUOTA_EXHAUSTION_THRESHOLD,
          modelFamily,
          accountManager.now(),
        );
        const authorizationGeneration = directEvidence
          ? result.observation.generation
          : (newerEvidence ? newerObservation.generation : null);
        const replayTargets = authorizationGeneration == null
          ? new Map()
          : result.replayTargets;
        const confirmed = replayTargets.size > 0;
        logger?.(`${new Date().toISOString()} reactive-quota-confirmation account=${account.id} model=${modelFamily || 'unknown'} result=${confirmed ? 'confirmed' : 'not-confirmed'}`);
        return {
          confirmed,
          replayTargets,
          replayAuthorization: confirmed ? {
            source: account,
            generation: authorizationGeneration,
            credentialFingerprint: result.observation.credentialFingerprint,
            modelFamily,
          } : null,
        };
      } catch (error) {
        logger?.(`${new Date().toISOString()} reactive-quota-confirmation account=${account.id} model=${modelFamily || 'unknown'} result=failed errorType=${error?.code || error?.name || 'unknown'}`);
        return { confirmed: false, replayTargets: new Map(), replayAuthorization: null };
      } finally {
        if (entry) {
          entry.waiters = Math.max(0, entry.waiters - 1);
          if (clientAborted && entry.waiters === 0) entry.expire();
        }
      }
    },
    isReplayAuthorized(authorization) {
      if (!authorization || !accountManager.accounts.includes(authorization.source)) return false;
      const nowMs = accountManager.now();
      const evidence = usageObservationTracker.currentSuccessfulEvidence(
        authorization.source,
        authorization.generation,
        authorization.credentialFingerprint,
      );
      return usageEvidenceConfirmsRequest(
        evidence,
        REACTIVE_QUOTA_EXHAUSTION_THRESHOLD,
        authorization.modelFamily,
        nowMs,
      ) && accountQuotaConfirmsModelFamily(
        authorization.source,
        authorization.modelFamily,
        REACTIVE_QUOTA_EXHAUSTION_THRESHOLD,
        nowMs,
      );
    },
  };
}

function waitForClientOrPromise(promise, req, res, onClientAbort) {
  if (!req || !res) return promise;
  if (req.aborted || res.destroyed) {
    onClientAbort?.();
    return Promise.reject(clientRequestAbortedError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      onClientAbort?.();
      settle(clientRequestAbortedError());
    };
    const close = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', close);
    if (req.aborted || res.destroyed) {
      abort();
      return;
    }
    promise.then(value => settle(null, value), error => settle(error));
  });
}

function clientRequestAbortedError() {
  const error = new Error('Client request aborted');
  error.code = 'CLIENT_REQUEST_ABORTED';
  return error;
}

function withDeadline(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      const error = new Error(`Reactive quota confirmation timed out after ${timeoutMs}ms`);
      error.code = 'REACTIVE_QUOTA_CONFIRM_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function positiveTimeoutOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, fallback)
    : fallback;
}

function requestModelFamily(body) {
  try {
    const model = JSON.parse(body.toString('utf8'))?.model;
    return isCanonicalFableModelId(model) ? 'fable' : null;
  } catch {
    return null;
  }
}

// Exact canonical id match only (no trim/lowercase/regex). Used to gate
// reactive Usage confirmation (a second network round trip that mutates
// quota state), which must stay conservative: see 'requires the exact
// canonical Fable model id for reactive Usage confirmation'
// (test/proxy-server.test.js). Fable 5 and Fable 5.1 share the same weekly
// sub-cap, so both canonical ids are listed; a date- or build-suffixed id
// (e.g. `claude-fable-5-20260818`, `claude-fable-5-1-20260901`) is
// deliberately excluded.
const CANONICAL_FABLE_MODEL_IDS = new Set(['claude-fable-5', 'claude-fable-5-1']);
function isCanonicalFableModelId(value) {
  return CANONICAL_FABLE_MODEL_IDS.has(value);
}

// Lenient prefix match for account-selection ROUTING only (never for
// confirmation/evidence gating above). Anthropic-issued Fable ids may carry a
// dated or numbered suffix (e.g. `claude-fable-5-20260818`,
// `claude-fable-5-1-20260901`); rejecting those as non-Fable would route
// them straight at a Fable-exhausted account and surface as a 429 to the
// caller.
function isFableRoutingModelId(value) {
  if (typeof value !== 'string') return false;
  return /^claude-fable-\d/.test(value.trim().toLowerCase());
}

function routingModelFamily(body) {
  try {
    const model = JSON.parse(body.toString('utf8'))?.model;
    return isFableRoutingModelId(model) ? 'fable' : null;
  } catch {
    return null;
  }
}

function safeUsageObservation(usage, threshold, nowMs) {
  const safe = {};
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'five_hour')) {
    const fiveHour = safeUsageBucket(usage.five_hour, threshold, nowMs);
    if (fiveHour.accepted) safe.five_hour = fiveHour.value;
  }
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'seven_day')) {
    const sevenDay = safeUsageBucket(usage.seven_day, threshold, nowMs);
    if (sevenDay.accepted) safe.seven_day = sevenDay.value;
  }
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'scoped_weekly')) {
    const scopedIsArray = Array.isArray(usage.scoped_weekly);
    const scopedResults = (scopedIsArray ? usage.scoped_weekly : [])
      .map(limit => safeScopedUsageBucket(limit, threshold, nowMs));
    const acceptedScopedResults = scopedResults.filter(result => result.accepted);
    if (
      scopedIsArray
      && (usage.scoped_weekly.length === 0 || acceptedScopedResults.length > 0)
    ) {
      safe.scopedWeeklyFields = acceptedScopedResults.map(result => ({
        field: scopedUsageField(result.limit),
        value: result.value,
      }));
      safe.scoped_weekly = acceptedScopedResults
        .map(result => result.value)
        .filter(Boolean);
      safe.scopedWeeklyComplete = scopedResults.every(result => result.accepted);
    }
  }
  return safe;
}

function safeUsageBucket(bucket, threshold, nowMs) {
  if (bucket == null) return { accepted: true, value: null };
  const utilization = typeof bucket?.utilization === 'number'
    ? bucket.utilization
    : Number.NaN;
  if (!Number.isFinite(utilization)) return { accepted: false, value: null };
  const resetAt = Date.parse(bucket?.resets_at);
  if (utilization >= threshold && (!Number.isFinite(resetAt) || resetAt <= nowMs)) {
    return { accepted: true, value: null };
  }
  return {
    accepted: true,
    value: {
      utilization,
      resets_at: Number.isFinite(resetAt) ? new Date(resetAt).toISOString() : null,
    },
  };
}

function safeScopedUsageBucket(limit, threshold, nowMs) {
  if (!limit || typeof limit !== 'object') return { accepted: false, value: null };
  const bucket = safeUsageBucket(limit, threshold, nowMs);
  if (!bucket.accepted) return { accepted: false, value: null };
  if (bucket.value == null) return { accepted: true, limit, value: null };
  return {
    accepted: true,
    limit,
    value: {
      key: limit?.key,
      label: limit?.label,
      ...bucket.value,
    },
  };
}

function usageObservationFields(usage) {
  const fields = new Map([['auth', true]]);
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'five_hour')) {
    fields.set('five_hour', usage.five_hour);
  }
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'seven_day')) {
    fields.set('seven_day', usage.seven_day);
  }
  for (const scopedField of usage?.scopedWeeklyFields || []) {
    fields.set(scopedField.field, scopedField.value);
  }
  if (usage?.scopedWeeklyComplete) {
    fields.set(SCOPED_USAGE_SNAPSHOT_FIELD, usage.scoped_weekly);
  }
  return fields;
}

function usagePayloadForFields(usage, acceptedFields, account = null) {
  const payload = {};
  if (acceptedFields.has('five_hour')) payload.five_hour = usage.five_hour;
  if (acceptedFields.has('seven_day')) payload.seven_day = usage.seven_day;
  const acceptedScopedFields = [...acceptedFields].filter(isScopedUsageField);
  if (
    acceptedFields.has(SCOPED_USAGE_SNAPSHOT_FIELD)
    && !acceptedFields.has(SCOPED_USAGE_MERGE_FIELD)
  ) {
    payload.scoped_weekly = usage.scoped_weekly;
  } else if (
    acceptedScopedFields.length > 0
    || acceptedFields.has(SCOPED_USAGE_MERGE_FIELD)
  ) {
    payload.scoped_weekly = mergeAcceptedScopedUsage({
      existing: account?.quota?.weeklyScoped,
      observedFields: usage.scopedWeeklyFields,
      acceptedFields,
      replace: acceptedFields.has(SCOPED_USAGE_SNAPSHOT_FIELD),
    });
  }
  return payload;
}

function mergeAcceptedScopedUsage({ existing, observedFields, acceptedFields, replace }) {
  const merged = new Map();
  if (!replace) {
    for (const limit of Array.isArray(existing) ? existing : []) {
      merged.set(scopedUsageIdentity(limit), limit);
    }
  }
  for (const observed of observedFields || []) {
    if (!acceptedFields.has(observed.field)) continue;
    const identity = scopedUsageIdentityFromField(observed.field);
    if (observed.value == null) merged.delete(identity);
    else merged.set(identity, observed.value);
  }
  if (replace && acceptedFields.has(SCOPED_USAGE_MERGE_FIELD)) {
    for (const limit of Array.isArray(existing) ? existing : []) {
      const identity = scopedUsageIdentity(limit);
      if (acceptedFields.has(`${SCOPED_USAGE_PRESERVE_PREFIX}${identity}`)) {
        merged.set(identity, limit);
      }
    }
  }
  return [...merged.values()];
}

function scopedUsageField(limit) {
  return `${SCOPED_USAGE_FIELD_PREFIX}${scopedUsageIdentity(limit)}`;
}

function isScopedUsageField(field) {
  return typeof field === 'string'
    && field.startsWith(SCOPED_USAGE_FIELD_PREFIX)
    && field !== SCOPED_USAGE_SNAPSHOT_FIELD;
}

function scopedUsageIdentityFromField(field) {
  return field.slice(SCOPED_USAGE_FIELD_PREFIX.length);
}

function scopedUsageIdentity(limit) {
  const value = String(limit?.key || limit?.label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return isFableScopeIdentity(value) ? 'fable' : (value || 'scoped');
}

function usageEvidenceConfirmsRequest(fields, threshold, modelFamily, nowMs) {
  for (const [field, evidence] of fields) {
    if (
      (field === 'five_hour' || field === 'seven_day')
      && usageBucketConfirmsQuota(evidence, threshold, nowMs)
    ) return true;
    if (
      isScopedUsageField(field)
      && modelFamily
      && scopedUsageMatchesModelFamily(evidence, modelFamily)
      && usageBucketConfirmsQuota(evidence, threshold, nowMs)
    ) return true;
  }
  return false;
}

function usageBucketConfirmsQuota(bucket, threshold, nowMs) {
  const utilization = Number(bucket?.utilization);
  const rawResetAt = bucket?.resets_at ?? bucket?.resetAt;
  const resetAt = typeof rawResetAt === 'number' ? rawResetAt : Date.parse(rawResetAt);
  return Number.isFinite(utilization)
    && utilization >= threshold
    && Number.isFinite(resetAt)
    && resetAt > nowMs;
}

function accountQuotaConfirmsModelFamily(account, modelFamily, threshold, nowMs) {
  const quota = account?.quota || {};
  if (usageBucketConfirmsQuota({
    utilization: quota.unified5h,
    resetAt: quota.unified5hReset,
  }, threshold, nowMs)) return true;
  if (usageBucketConfirmsQuota({
    utilization: quota.unified7d,
    resetAt: quota.unified7dReset,
  }, threshold, nowMs)) return true;
  return modelFamily === 'fable'
    && Array.isArray(quota.weeklyScoped)
    && quota.weeklyScoped.some(limit => (
      scopedUsageMatchesModelFamily(limit, modelFamily)
      && usageBucketConfirmsQuota(limit, threshold, nowMs)
    ));
}

function scopedUsageMatchesModelFamily(limit, modelFamily) {
  if (modelFamily !== 'fable') return false;
  const key = String(limit?.key || '').trim().toLowerCase();
  if (key) return isFableScopeIdentity(key);
  const label = String(limit?.label || '').trim().toLowerCase();
  return isFableScopeIdentity(label);
}

function unifiedQuotaHeaderEvidence(headers, threshold, nowMs) {
  const parsed = parseRateLimitHeaders(headers);
  const windows = [
    [parsed.unified5h, parsed.unified5hReset],
    [parsed.unified7d, parsed.unified7dReset],
  ];
  const confirmsExhaustion = windows.some(([utilization, resetAt]) => (
    Number.isFinite(utilization)
    && utilization >= threshold
    && Number.isFinite(resetAt)
    && resetAt > nowMs
  ));
  const hasIncompleteExhaustion = windows.some(([utilization, resetAt]) => (
    Number.isFinite(utilization)
    && utilization >= threshold
    && (!Number.isFinite(resetAt) || resetAt <= nowMs)
  ));
  return { confirmsExhaustion, hasIncompleteExhaustion };
}

async function snapshotKnownAvailableAlternates({
  accountManager,
  account,
  secretStore,
  currentCredentialReader,
  allowLiveClaudeCodeCredentials = true,
  signal = null,
}) {
  throwIfOperationAborted(signal);
  // This confirmer only ever runs for a Fable request (gated by
  // `requestModelFamily(body) === 'fable'` before it is invoked), so the final
  // gate here must judge candidates as Fable requests too — otherwise a
  // Fable-exhausted candidate would incorrectly look available (isAvailable's
  // default modelFamily is null / non-Fable).
  const candidates = accountManager.accounts.filter(candidate => (
    candidate !== account
    && accountManager.isAvailable(candidate, 'fable')
    && accountManager.switchTargetScore(candidate, 'fable') != null
  ));
  const snapshots = await Promise.all(candidates.map(async candidate => {
    const secret = await resolveReactiveReplaySecret({
      account: candidate,
      secretStore,
      currentCredentialReader,
      allowLiveClaudeCodeCredentials,
      signal,
    });
    throwIfOperationAborted(signal);
    if (!stableReactiveReplaySecret(candidate, secret)) return null;
    return [candidate, {
      credentialRevision: candidate.credentialRevision,
      credentialFingerprint: replayCredentialFingerprint(candidate, secret),
    }];
  }));
  return new Map(snapshots.filter(Boolean));
}

async function resolveReactiveReplaySecret({
  account,
  secretStore,
  currentCredentialReader,
  allowLiveClaudeCodeCredentials = true,
  signal = null,
}) {
  throwIfOperationAborted(signal);
  if (account.id === 'current' || account.credentialSource === 'claude-code-current') {
    if (!allowLiveClaudeCodeCredentials) {
      throw new Error('Live current account is unavailable while Claude login is overridden');
    }
    const secret = await liveClaudeCodeSecret(currentCredentialReader);
    throwIfOperationAborted(signal);
    return secret;
  }
  const secret = await getOperationalSecret(secretStore, account.id);
  throwIfOperationAborted(signal);
  return secret;
}

function validReactiveReplayTarget({
  accountManager,
  reactiveQuotaConfirmer,
  authorization,
  source,
  targets,
  candidate,
  secret = null,
}) {
  const snapshot = targets?.get(candidate);
  // Same reasoning as snapshotKnownAvailableAlternates: this replay path is
  // Fable-only, so judge the candidate as a Fable request here too.
  return Boolean(
    source
    && candidate
    && snapshot
    && accountManager.accounts.includes(source)
    && accountManager.accounts.includes(candidate)
    && accountManager.isAvailable(candidate, 'fable')
    && accountManager.switchTargetScore(candidate, 'fable') != null
    && candidate.credentialRevision === snapshot.credentialRevision
    && (!secret || (
      stableReactiveReplaySecret(candidate, secret)
      && replayCredentialFingerprint(candidate, secret) === snapshot.credentialFingerprint
    ))
    && reactiveQuotaConfirmer?.isReplayAuthorized(authorization)
  );
}

function stableReactiveReplaySecret(account, secret) {
  if (account.type === 'apikey') return Boolean(secret?.apiKey);
  return hasUsableAccessToken(secret)
    && !(canRefreshSecret(account, secret) && isTokenExpiringSoon(secret.expiresAt));
}

function replayCredentialFingerprint(account, secret) {
  return credentialFingerprint(
    account.type === 'apikey' ? 'apikey' : 'oauth',
    account.type === 'apikey' ? secret?.apiKey : secret?.accessToken,
  );
}

async function refreshAllOnce({
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  currentProfileFetcher,
  usageFetcher,
  allowLiveClaudeCodeCredentials,
  usageRequestOptions,
  usageObservationTracker,
  usageRefreshConcurrency,
  usageRefreshRequestSpacingMs,
  duplicateRefreshAccountIds,
  logger,
}) {
  const results = await mapWithConcurrency(
    accountManager.accounts,
    usageRefreshConcurrency,
    usageRefreshRequestSpacingMs,
    account => refreshAccountUsage({
      account,
      accountManager,
      secretStore,
      tokenRefresher,
      currentCredentialReader,
      currentProfileFetcher,
      usageFetcher,
      allowLiveClaudeCodeCredentials,
      usageRequestOptions,
      usageObservationTracker,
      duplicateRefreshAccountIds,
      logger,
    }),
  );
  rebalanceAfterUsageRefresh(accountManager);
  return {
    ok: results.every(result => result.ok),
    refreshedAt: new Date().toISOString(),
    accounts: results,
    status: accountManager.getStatus(),
  };
}

async function mapWithConcurrency(items, concurrency, requestSpacingMs, mapper) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(items.length, Math.floor(Number(concurrency) || items.length)));
  const results = new Array(items.length);
  let nextIndex = 0;
  let lastStartedAt = 0;
  let spacingTail = Promise.resolve();

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      if (requestSpacingMs > 0) {
        spacingTail = spacingTail.then(async () => {
          const waitMs = Math.max(0, lastStartedAt + requestSpacingMs - Date.now());
          if (waitMs > 0) await sleep(waitMs);
          lastStartedAt = Date.now();
        });
        await spacingTail;
      }
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

async function refreshAccountUsage({
  account,
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  currentProfileFetcher,
  usageFetcher,
  allowLiveClaudeCodeCredentials,
  usageRequestOptions,
  usageObservationTracker,
  duplicateRefreshAccountIds,
  logger,
}) {
  if (account.type === 'apikey') return { account: account.id, ok: true, skipped: 'apikey' };
  if (duplicateRefreshAccountIds?.has(account.id)) {
    return { account: account.id, ok: false, skipped: 'duplicate-refresh-token' };
  }
  const observation = usageObservationTracker.start(account);

  try {
    const secret = await resolveSecretForAccount({
      account,
      secretStore,
      currentCredentialReader,
      currentProfileFetcher,
      allowLiveClaudeCodeCredentials,
      logger,
    });
    if (!accountManager.accounts.includes(account)) {
      usageObservationTracker.fail(observation);
      return { account: account.id, ok: true, stale: true };
    }
    if (!secret?.accessToken) throw new Error('OAuth access token is missing');
    const credentialCooldown = accountManager.hasCredentialRefreshCooldown(account);
    if (credentialCooldown && !hasUsableAccessToken(secret)) {
      usageObservationTracker.fail(observation);
      return { account: account.id, ok: false, skipped: 'credential-refresh-cooldown' };
    }
    const freshSecret = credentialCooldown && hasUsableAccessToken(secret)
      ? secret
      : await refreshSecretIfExpiring({
        account,
        secret,
        secretStore,
        tokenRefresher,
        logger,
      });
    usageObservationTracker.bindCredential(observation, freshSecret.accessToken);
    if (!accountManager.accounts.includes(account)) {
      usageObservationTracker.fail(observation);
      return { account: account.id, ok: true, stale: true };
    }
    const usage = await usageFetcher(freshSecret.accessToken, usageRequestOptions);
    if (!accountManager.accounts.includes(account)) {
      usageObservationTracker.fail(observation);
      return { account: account.id, ok: true, stale: true };
    }
    const safeUsage = safeUsageObservation(
      usage,
      accountManager.switchThreshold,
      accountManager.now(),
    );
    const result = usageObservationTracker.apply(observation, safeUsage, acceptedFields => {
      accountManager.applyUsage(
        account.id,
        usagePayloadForFields(safeUsage, acceptedFields, account),
      );
    });
    return {
      account: account.id,
      ok: true,
      ...(result.acceptedFields.size > 0 ? {} : { stale: true }),
    };
  } catch (caught) {
    const message = shortErrorMessage(caught);
    logger?.(`${new Date().toISOString()} usage-refresh account=${account.id} result=failed errorType=${usageRefreshErrorType(caught)}`);
    usageObservationTracker.fail(observation);
    if (!accountManager.accounts.includes(account)) {
      return { account: account.id, ok: false, stale: true, error: message };
    }
    // Captured here, not inside `applyFailure`: the failure below can be held
    // back until every newer in-flight observation settles, so reading the clock
    // at apply time would stamp the account with the settle time instead of the
    // moment the credential was actually seen to fail.
    const detectedAt = accountManager.now();
    const applyFailure = () => {
      if (!accountManager.accounts.includes(account)) return;
      const refreshUnavailable = markOAuthRefreshUnavailable(accountManager, account.id, caught);
      if (!refreshUnavailable && isOAuthCredentialError(message, caught)) {
        accountManager.markError(
          account.id,
          'oauth_refresh_failed',
          'OAuth token refresh failed',
          authErrorDetails(usageRefreshErrorType(caught), detectedAt),
        );
      }
    };
    const deferred = usageObservationTracker.deferFailure(observation, applyFailure);
    if (!deferred) applyFailure();
    return {
      account: account.id,
      ok: false,
      ...(deferred ? { stale: true } : {}),
      error: message,
    };
  }
}

function rebalanceAfterUsageRefresh(accountManager) {
  accountManager.rebalanceActiveAccount();
}

function isOAuthCredentialError(message, error = null) {
  return error?.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN'
    || error?.code === 'NATIVE_REFRESH_REAUTH_REQUIRED'
    || /OAuth access token is missing|Token refresh failed|Usage fetch failed \(401\)/.test(String(message || ''));
}

function markOAuthRefreshUnavailable(accountManager, accountId, error) {
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(error?.retryAfterMs) / 1000) || 1);
  if (isOAuthTokenRefreshRateLimit(error)) {
    accountManager.markCredentialRefreshRateLimited(accountId, retryAfterSeconds, {
      retryAfterSource: error.retryAfterSource,
    });
    return true;
  }
  if (!(Number.isFinite(Number(error?.retryAfterMs)) && Number(error.retryAfterMs) > 0)) return false;
  accountManager.markCredentialRefreshDeferred(accountId, retryAfterSeconds, {
    retryAfterSource: error.retryAfterSource,
  });
  return true;
}

async function forwardWithRotation({
  req,
  res,
  body,
  upstream,
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  currentProfileFetcher,
  reactiveQuotaConfirmer,
  allowLiveClaudeCodeCredentials,
  logger,
  upstreamIdleTimeoutMs,
  upstreamConnectTimeoutMs,
  upstreamConnectRetries,
  upstreamConnectRetryDelayMs,
  exhaustionMapper = null,
  observability = DEFAULT_OBSERVABILITY,
}) {
  const maxAttempts = Math.max(1, accountManager.accounts.length);
  const attemptedAccountIds = new Set();
  let lastRetryableResponse = null;
  // 再生する応答を作った口座（P-b の replay 行の account= に使う。写像したときだけ読む）。
  let lastRetryableAccountId = null;
  let reactiveQuotaRetryUsed = false;
  let reactiveQuotaSource = null;
  let reactiveReplayTargets = null;
  let reactiveReplayAuthorization = null;

  // Routing uses the lenient matcher (M3): a dated/numbered Fable id
  // suffix must still route away from a Fable-exhausted account, unlike the
  // strict `requestModelFamily` used to gate reactive Usage confirmation.
  const modelFamily = routingModelFamily(body);
  // 設計書 §4.2: 7系統すべてが通る単一の判定点。modelFamily をここで束ねてから
  // 下位（P-a / P-c〜P-g）へ渡す。null なら下位も一切受け取らない＝現行と同一。
  const mapExhaustion = exhaustionMapper
    ? (candidate, options) => exhaustionMapper(candidate, { modelFamily, ...options })
    : null;
  // P-b: 直前の上流応答の再生（R-20 の 11 か所）。再生する候補を必ずこの1関数へ通す。
  const sendLastRetryable = () => {
    const mapped = mapExhaustion
      ? mapExhaustion(lastRetryableResponse, { mapPath: 'b', headersSent: res.headersSent })
      : lastRetryableResponse;
    // R4-5: 再生元の 429 の proxy 行は、この写像が起きる前に
    // 書き終わっている（forwardOnce の recordProxyRequest）。そのままでは 529 / 403 を
    // 返した事実がログのどこにも残らないので、**写像したときだけ**1行足す。
    // 台帳（accountManager.recordProxyRequest）は経由しないのでイベントは増えない。
    // 写像しなかった再生と degradeMapping を書いていない構成では1行も増えない（§14.4）。
    if (mapped?.degradeLog?.mapReason) {
      logger?.(
        `${new Date().toISOString()} claude-exhaustion-replay`
        + ` account=${lastRetryableAccountId || '-'}`
        + ` method=${req.method}`
        + ` path=${new URL(req.url, 'http://claude-rotator.local').pathname}`
        + ` status=${mapped.statusCode}`
        + ' durationMs=0'
        + ' outcome=quota-exhausted-replay'
        + `${degradeLogFields(mapped.degradeLog)}`,
      );
    }
    sendBufferedResponse(res, mapped);
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (req.aborted || res.destroyed) return;
    const reactiveSelection = reactiveQuotaRetryUsed
      ? accountManager.bestAvailableSwitchCandidate({
        excludeCurrent: false,
        allowedAccounts: new Set(reactiveReplayTargets?.keys() || []),
        modelFamily,
      })
      : null;
    const account = reactiveQuotaRetryUsed
      ? reactiveSelection?.account
      : accountManager.getActiveAccount(modelFamily, { trigger: 'request' });
    if (!account) {
      if (reactiveQuotaRetryUsed && lastRetryableResponse) {
        sendLastRetryable();
        return;
      }
      if (sendCurrentQuotaUnavailableResponse({
        req,
        res,
        accountManager,
        logger,
        modelFamily,
        exhaustionMapper: mapExhaustion,
      })) return;
      if (lastRetryableResponse) {
        sendLastRetryable();
        return;
      }
      if (await forwardCurrentUnavailableAccount({
        req,
        res,
        body,
        upstream,
        accountManager,
        secretStore,
        tokenRefresher,
        currentCredentialReader,
        currentProfileFetcher,
        allowLiveClaudeCodeCredentials,
        logger,
        upstreamIdleTimeoutMs,
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
        modelFamily,
        exhaustionMapper: mapExhaustion,
        observability,
      })) return;
      sendUnavailableAccounts(res, accountManager, mapExhaustion);
      return;
    }

    if (
      reactiveQuotaRetryUsed
      && !validReactiveReplayTarget({
        accountManager,
        reactiveQuotaConfirmer,
        authorization: reactiveReplayAuthorization,
        source: reactiveQuotaSource,
        targets: reactiveReplayTargets,
        candidate: account,
      })
    ) {
      if (lastRetryableResponse) sendLastRetryable();
      else sendUnavailableAccounts(res, accountManager, mapExhaustion);
      return;
    }

    let secret;
    try {
      secret = reactiveQuotaRetryUsed
        ? await resolveReactiveReplaySecret({
          account,
          secretStore,
          currentCredentialReader,
          allowLiveClaudeCodeCredentials,
        })
        : await resolveSecretForAccount({
          account,
          secretStore,
          currentCredentialReader,
          currentProfileFetcher,
          allowLiveClaudeCodeCredentials,
          logger,
        });
    } catch (error) {
      if (reactiveQuotaRetryUsed && lastRetryableResponse) {
        if (req.aborted || res.destroyed) return;
        sendLastRetryable();
        return;
      }
      if (error?.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN') {
        if (!markOAuthRefreshUnavailable(accountManager, account.id, error)) {
          accountManager.markError(
            account.id,
            'oauth_refresh_failed',
            'OAuth token refresh failed',
            authErrorDetails(credentialRefreshErrorType(error), accountManager.now()),
          );
        }
        continue;
      }
      throw error;
    }
    if (req.aborted || res.destroyed) return;
    if (!accountManager.accounts.includes(account)) {
      if (reactiveQuotaRetryUsed && lastRetryableResponse) {
        sendLastRetryable();
        return;
      }
      continue;
    }
    if (
      reactiveQuotaRetryUsed
      && !validReactiveReplayTarget({
        accountManager,
        reactiveQuotaConfirmer,
        authorization: reactiveReplayAuthorization,
        source: reactiveQuotaSource,
        targets: reactiveReplayTargets,
        candidate: account,
        secret,
      })
    ) {
      sendLastRetryable();
      return;
    }
    if (!secret) {
      accountManager.markError(account.id, 'credential_missing', 'No stored credential for account');
      continue;
    }

    let freshSecret = secret;
    if (!reactiveQuotaRetryUsed) {
      try {
        freshSecret = await refreshSecretIfExpiring({
          account,
          secret,
          secretStore,
          tokenRefresher,
          logger,
        });
      } catch (caught) {
        if (!accountManager.accounts.includes(account)) continue;
        if (!markOAuthRefreshUnavailable(accountManager, account.id, caught)) {
          accountManager.markError(
            account.id,
            'oauth_refresh_failed',
            'OAuth token refresh failed',
            authErrorDetails(credentialRefreshErrorType(caught), accountManager.now()),
          );
        }
        continue;
      }
    }

    if (req.aborted || res.destroyed) return;
    if (!accountManager.accounts.includes(account)) {
      if (reactiveQuotaRetryUsed && lastRetryableResponse) {
        sendLastRetryable();
        return;
      }
      continue;
    }
    if (
      reactiveQuotaRetryUsed
      && !validReactiveReplayTarget({
        accountManager,
        reactiveQuotaConfirmer,
        authorization: reactiveReplayAuthorization,
        source: reactiveQuotaSource,
        targets: reactiveReplayTargets,
        candidate: account,
        secret: freshSecret,
      })
    ) {
      sendLastRetryable();
      return;
    }
    if (attemptedAccountIds.has(account.id)) {
      if (lastRetryableResponse) sendLastRetryable();
      else sendUnavailableAccounts(res, accountManager, mapExhaustion);
      return;
    }
    attemptedAccountIds.add(account.id);
    // 設計書 §5.1（D-54-12）: 系統枠だけが枯れた 429 では currentIndex を動かさない。
    // その口座は他の系統では現役のままなので、先回り経路（getActiveAccount の
    // `leave currentIndex untouched`）と同じく、この要求の送信先としてだけ候補を使う。
    // 判定するのは **429 を返した口座**（reactiveQuotaSource）であって切替先の候補ではない。
    // 切替先で判定すると、枯れていない新候補を見て「共通枠は無事」と読み、
    // 系統枠由来でもグローバル切替を実行してしまう（是正が逆に効く）。
    // reactiveQuotaSource が無いときは述語が偽になり、従来どおり切り替える。
    if (
      reactiveQuotaRetryUsed
      && !familyQuotaExhaustedOnly(
        reactiveQuotaSource,
        accountManager.switchThreshold,
        modelFamily,
        accountManager.now(),
      )
    ) {
      accountManager.switchToCandidate(reactiveSelection, 'quota-threshold', '429');
    }

    const result = await forwardOnce({
      req,
      res,
      body,
      upstream,
      account,
      secret: freshSecret,
      accountManager,
      reactiveQuotaConfirmer,
      allowReactiveQuotaConfirmation: !reactiveQuotaRetryUsed,
      allowQuotaRetry: !reactiveQuotaRetryUsed,
      allowAuthRefreshRetry: !reactiveQuotaRetryUsed,
      logger,
      upstreamIdleTimeoutMs,
      upstreamConnectTimeoutMs,
      upstreamConnectRetries,
      upstreamConnectRetryDelayMs,
      exhaustionMapper: mapExhaustion,
      observability,
    });
    if (!accountManager.accounts.includes(account)) {
      finishStaleAccountResponse(res, result.passthroughResponse, mapExhaustion);
      return;
    }
    if (result.retryAfterRefresh) {
      if (req.aborted || res.destroyed) return;
      if (!accountManager.accounts.includes(account)) continue;
      let refreshedSecret;
      try {
        refreshedSecret = await refreshAndStoreSecret({
          account,
          secret: freshSecret,
          secretStore,
          tokenRefresher,
          logger,
        });
      } catch (caught) {
        if (!accountManager.accounts.includes(account)) continue;
        if (!markOAuthRefreshUnavailable(accountManager, account.id, caught)) {
          accountManager.markError(
            account.id,
            'oauth_refresh_failed',
            'OAuth token refresh failed',
            authErrorDetails(credentialRefreshErrorType(caught), accountManager.now()),
          );
        }
        continue;
      }
      if (req.aborted || res.destroyed) return;
      if (!accountManager.accounts.includes(account)) continue;
      const retryResult = await forwardOnce({
        req,
        res,
        body,
        upstream,
        account,
        secret: refreshedSecret,
        accountManager,
        reactiveQuotaConfirmer,
        allowReactiveQuotaConfirmation: !reactiveQuotaRetryUsed,
        allowQuotaRetry: !reactiveQuotaRetryUsed,
        allowAuthRefreshRetry: !reactiveQuotaRetryUsed,
        logger,
        upstreamIdleTimeoutMs,
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
        exhaustionMapper: mapExhaustion,
        observability,
      });
      if (!accountManager.accounts.includes(account)) {
        finishStaleAccountResponse(res, retryResult.passthroughResponse, mapExhaustion);
        return;
      }
      if (retryResult.retryAfterRefresh) {
        if (!accountManager.accounts.includes(account)) continue;
        accountManager.markError(account.id, 'authentication_error', 'OAuth token rejected');
        continue;
      }
      if (retryResult.retryNextAccount) {
        if (retryResult.reactiveQuotaRetry) {
          reactiveQuotaRetryUsed = true;
          reactiveQuotaSource = retryResult.reactiveQuotaSource;
          reactiveReplayTargets = retryResult.reactiveReplayTargets;
          reactiveReplayAuthorization = retryResult.reactiveReplayAuthorization;
        }
        const retryReplacement = retryResult.passthroughResponse || retryResult.syntheticResponse;
        if (retryReplacement) {
          lastRetryableResponse = retryReplacement;
          lastRetryableAccountId = account?.id || null;
        }
        if (req.aborted || res.destroyed) return;
        continue;
      }
      return;
    }
    if (result.retryNextAccount) {
      if (result.reactiveQuotaRetry) {
        reactiveQuotaRetryUsed = true;
        reactiveQuotaSource = result.reactiveQuotaSource;
        reactiveReplayTargets = result.reactiveReplayTargets;
        reactiveReplayAuthorization = result.reactiveReplayAuthorization;
      }
      const replacement = result.passthroughResponse || result.syntheticResponse;
      if (replacement) {
        lastRetryableResponse = replacement;
        lastRetryableAccountId = account?.id || null;
      }
      if (req.aborted || res.destroyed) return;
      continue;
    }
    return;
  }

  if (!res.headersSent) {
    if (reactiveQuotaRetryUsed && lastRetryableResponse) {
      sendLastRetryable();
      return;
    }
    if (sendCurrentQuotaUnavailableResponse({
      req,
      res,
      accountManager,
      logger,
      modelFamily,
      exhaustionMapper: mapExhaustion,
    })) return;
    if (lastRetryableResponse) {
      sendLastRetryable();
      return;
    }
    if (await forwardCurrentUnavailableAccount({
      req,
      res,
      body,
      upstream,
      accountManager,
      secretStore,
      tokenRefresher,
      currentCredentialReader,
      currentProfileFetcher,
      allowLiveClaudeCodeCredentials,
      logger,
      upstreamIdleTimeoutMs,
      upstreamConnectTimeoutMs,
      upstreamConnectRetries,
      upstreamConnectRetryDelayMs,
      modelFamily,
      exhaustionMapper: mapExhaustion,
      observability,
    })) return;
    sendUnavailableAccounts(res, accountManager, mapExhaustion);
  }
}

async function forwardCurrentUnavailableAccount({
  req,
  res,
  body,
  upstream,
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  currentProfileFetcher,
  allowLiveClaudeCodeCredentials,
  logger,
  upstreamIdleTimeoutMs,
  upstreamConnectTimeoutMs,
  upstreamConnectRetries,
  upstreamConnectRetryDelayMs,
  modelFamily = null,
  exhaustionMapper = null,
  observability = DEFAULT_OBSERVABILITY,
}) {
  if (sendCurrentQuotaUnavailableResponse({
    req,
    res,
    accountManager,
    logger,
    modelFamily,
    exhaustionMapper,
  })) return true;

  const account = accountManager.getFallbackAccount();
  if (!account) return false;

  let secret;
  try {
    secret = await resolveSecretForAccount({
      account,
      secretStore,
      currentCredentialReader,
      currentProfileFetcher,
      allowLiveClaudeCodeCredentials,
      logger,
    });
  } catch (caught) {
    if (caught?.code !== 'NATIVE_REFRESH_OUTCOME_UNKNOWN') throw caught;
    if (!markOAuthRefreshUnavailable(accountManager, account.id, caught)) {
      accountManager.markError(
        account.id,
        'oauth_refresh_failed',
        'OAuth token refresh failed',
        authErrorDetails(credentialRefreshErrorType(caught), accountManager.now()),
      );
    }
    return false;
  }
  if (req.aborted || res.destroyed || !accountManager.accounts.includes(account)) return false;
  if (!secret) return false;

  if (secret.liveClaudeCodeCredential && hasUsableAccessToken(secret)) {
    accountManager.markAuthenticated(account.id);
  }
  if (
    accountManager.hasCredentialRefreshCooldown(account)
    || isCredentialUnavailable(accountManager.unavailableReason(account))
  ) return false;

  let freshSecret;
  try {
    freshSecret = await refreshSecretIfExpiring({
      account,
      secret,
      secretStore,
      tokenRefresher,
      logger,
    });
  } catch {
    return false;
  }
  if (req.aborted || res.destroyed || !accountManager.accounts.includes(account)) return false;

  await forwardOnce({
    req,
    res,
    body,
    upstream,
    account,
    secret: freshSecret,
    accountManager,
    passthroughErrors: true,
    logger,
    upstreamIdleTimeoutMs,
    upstreamConnectTimeoutMs,
    upstreamConnectRetries,
    upstreamConnectRetryDelayMs,
    exhaustionMapper,
    observability,
  });
  return true;
}

async function refreshSecretIfExpiring({ account, secret, secretStore, tokenRefresher, logger }) {
  if (!canRefreshSecret(account, secret)) return secret;
  if (!isTokenExpiringSoon(secret.expiresAt)) return secret;
  try {
    return await refreshAndStoreSecret({ account, secret, secretStore, tokenRefresher, logger });
  } catch (error) {
    if (error?.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN') throw error;
    if (!hasUsableAccessToken(secret)) throw error;
    const expiresAt = normalizeCredentialExpiry(secret.expiresAt);
    const remainingSec = expiresAt == null ? 'unknown' : Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    logger?.(`${new Date().toISOString()} credential-refresh-fallback account=${account.id} remainingSec=${remainingSec} errorType=${credentialRefreshErrorType(error)}`);
    return secret;
  }
}

async function refreshAndStoreSecret({ account, secret, secretStore, tokenRefresher, logger }) {
  const refreshIfUnchanged = requireSecretStoreRefreshIfUnchanged(secretStore);
  try {
    const result = await refreshIfUnchanged(account.id, secret, async (currentSecret, transaction) => ({
      ...currentSecret,
      ...(await tokenRefresher(
        currentSecret.refreshToken,
        tokenRefreshContext(account, currentSecret, transaction),
      )),
    }));
    if (!result.updated) {
      logger?.(`${new Date().toISOString()} credential-refresh account=${account.id} result=discarded reason=credential-changed`);
      if (result.secret?.accessToken) return result.secret;
      throw new Error('Stored OAuth credential changed while token refresh was in flight');
    }
    return result.secret;
  } catch (error) {
    logger?.(`${new Date().toISOString()} credential-store account=${account.id} result=failed errorType=${error?.code || error?.name || 'unknown'}`);
    throw error;
  }
}

function tokenRefreshContext(account, secret, transaction = {}) {
  return {
    accountId: account.id,
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken,
    expiresAt: secret.expiresAt,
    scopes: secret.scopes,
    refreshTokenExpiresAt: secret.refreshTokenExpiresAt,
    clientId: secret.clientId,
    subscriptionType: secret.subscriptionType,
    rateLimitTier: secret.rateLimitTier,
    beforeHandoff: transaction.beforeHandoff,
    retractHandoff: transaction.retractHandoff,
    protectChildPid: transaction.protectChildPid,
    clearChildPid: transaction.clearChildPid,
  };
}

function credentialRefreshErrorType(error) {
  const message = String(error?.message || '');
  if (/invalid_grant/i.test(message)) return 'invalid_grant';
  const status = message.match(/Token refresh failed \((\d+)\)/)?.[1];
  return status ? `http-${status}` : (error?.code || error?.name || 'unknown');
}

function usageRefreshErrorType(error) {
  const status = String(error?.message || '').match(/Usage fetch failed \((\d+)\)/)?.[1];
  return status ? `http-${status}` : credentialRefreshErrorType(error);
}

/**
 * The `{ cause, at }` detail stored with an auth error, so `claude-rotator
 * status` can say why an account fell out and when that was seen instead of
 * only that it fell out.
 *
 * `cause` is the same short classification the server.log `errorType=` field
 * already carries, which keeps the screen and the log talking about one value.
 * It is deliberately never the raw message: messages can quote credential
 * material, and this value is both persisted and printed.
 *
 * A classification that names nothing is stored as no cause at all, so the
 * screen stays silent instead of printing `cause=unknown` or `cause=Error`
 * (the latter is what a plain `new Error(...)` degrades to, e.g. the stored
 * credential having no access token at all).
 *
 * `detectedAtMs` is read from the account manager's clock by the caller, at the
 * point the failure is seen - never inside a deferred apply callback.
 */
const UNINFORMATIVE_ERROR_TYPES = new Set(['unknown', 'Error']);

function authErrorDetails(errorType, detectedAtMs) {
  return {
    cause: errorType && !UNINFORMATIVE_ERROR_TYPES.has(errorType) ? errorType : null,
    at: detectedAtMs,
  };
}

function canRefreshSecret(account, secret) {
  if (secret.liveClaudeCodeCredential) return false;
  return account.type !== 'apikey' && !secret.apiKey && Boolean(secret.refreshToken);
}

async function resolveSecretForAccount({
  account,
  secretStore,
  currentCredentialReader,
  currentProfileFetcher,
  signal = null,
  liveCredentialLoader = null,
  allowLiveClaudeCodeCredentials = true,
  logger,
}) {
  throwIfOperationAborted(signal);
  if (account.type === 'apikey') {
    const secret = await secretStore.get(account.id);
    throwIfOperationAborted(signal);
    return secret;
  }
  if (account.id === 'current' || account.credentialSource === 'claude-code-current') {
    if (!allowLiveClaudeCodeCredentials) {
      throw new Error('Live current account is unavailable while Claude login is overridden');
    }
    const secret = await liveClaudeCodeSecret(currentCredentialReader);
    throwIfOperationAborted(signal);
    return secret;
  }

  const stored = await getOperationalSecret(secretStore, account.id);
  throwIfOperationAborted(signal);
  if (!allowLiveClaudeCodeCredentials || !account.accountUuid) return stored;

  const current = await (liveCredentialLoader
    ? liveCredentialLoader()
    : liveClaudeCodeCredentialWithProfile({
      currentCredentialReader,
      currentProfileFetcher,
      signal,
    }))
    .catch(() => null);
  throwIfOperationAborted(signal);
  const matchesStoredCredential = Boolean(
    current?.secret
    && stored
    && (
      stored.accessToken === current.secret.accessToken
      || stored.refreshToken === current.secret.refreshToken
    )
  );
  if (!matchesStoredCredential && current?.profile?.accountUuid !== account.accountUuid) return stored;
  await mirrorLiveClaudeCodeCredential({
    account,
    stored,
    live: current.secret,
    secretStore,
    signal,
    logger,
  });
  throwIfOperationAborted(signal);
  return current.secret;
}

async function mirrorLiveClaudeCodeCredential({
  account,
  stored,
  live,
  secretStore,
  signal = null,
  logger,
}) {
  throwIfOperationAborted(signal);
  if (!live?.accessToken || !live.refreshToken) return;
  const mirrored = {
    ...(stored || {}),
    ...live,
  };
  for (const field of ['clientId', 'scopes']) {
    if (!(field in live)) delete mirrored[field];
  }
  delete mirrored.liveClaudeCodeCredential;
  if (credentialsMatch(stored, mirrored)) return;

  try {
    const compareAndSet = requireSecretStoreCompareAndSet(secretStore);
    throwIfOperationAborted(signal);
    if (!await compareAndSet(account.id, stored, mirrored)) {
      logger?.(`${new Date().toISOString()} credential-sync-discarded account=${account.id} reason=credential-changed`);
      return;
    }
    logger?.(`${new Date().toISOString()} credential-sync account=${account.id} source=claude-code-current expiresAt=${formatCredentialExpiry(live.expiresAt)}`);
  } catch (error) {
    logger?.(`${new Date().toISOString()} credential-sync-failed account=${account.id} error=${shortErrorMessage(error)}`);
  }
}

function requireSecretStoreCompareAndSet(secretStore) {
  if (typeof secretStore?.compareAndSet !== 'function') {
    const error = new Error('Secret store does not support atomic compare-and-set');
    error.code = 'SECRET_STORE_CAS_UNAVAILABLE';
    throw error;
  }
  return secretStore.compareAndSet.bind(secretStore);
}

function requireSecretStoreRefreshIfUnchanged(secretStore) {
  if (typeof secretStore?.refreshIfUnchanged !== 'function') {
    const error = new Error('Secret store does not support conditional refresh transaction');
    error.code = 'SECRET_STORE_TRANSACTION_UNAVAILABLE';
    throw error;
  }
  return secretStore.refreshIfUnchanged.bind(secretStore);
}

function getOperationalSecret(secretStore, accountId) {
  if (typeof secretStore?.getOperational === 'function') {
    return secretStore.getOperational(accountId);
  }
  return secretStore.get(accountId);
}

function credentialsMatch(left, right) {
  return left?.accessToken === right?.accessToken
    && left?.refreshToken === right?.refreshToken
    && normalizeCredentialExpiry(left?.expiresAt) === normalizeCredentialExpiry(right?.expiresAt)
    && normalizeCredentialExpiry(left?.refreshTokenExpiresAt)
      === normalizeCredentialExpiry(right?.refreshTokenExpiresAt)
    && JSON.stringify(left?.scopes || null) === JSON.stringify(right?.scopes || null)
    && left?.clientId === right?.clientId
    && left?.subscriptionType === right?.subscriptionType
    && left?.rateLimitTier === right?.rateLimitTier;
}

function normalizeCredentialExpiry(expiresAt) {
  const value = Number(expiresAt);
  if (!Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function hasUsableAccessToken(secret, now = Date.now()) {
  if (!secret?.accessToken) return false;
  const expiresAt = normalizeCredentialExpiry(secret.expiresAt);
  return expiresAt == null || expiresAt - now > MIN_USABLE_ACCESS_TOKEN_LIFETIME_MS;
}

function isCredentialUnavailable(reason) {
  // The expired-login half of this predicate is shared with the status screen
  // (D-72), so the two lists cannot drift apart.
  return isCredentialRefreshCooldown(reason) || isAuthExpiredReason(reason);
}

function formatCredentialExpiry(expiresAt) {
  const value = normalizeCredentialExpiry(expiresAt);
  return value == null ? 'unknown' : new Date(value).toISOString();
}

async function liveClaudeCodeSecret(currentCredentialReader) {
  return {
    ...(await currentCredentialReader()),
    liveClaudeCodeCredential: true,
  };
}

const LIVE_CLAUDE_CODE_CACHE_TTL_MS = 60_000;
let liveClaudeCodeCache = null;

function invalidateLiveClaudeCodeCache() {
  liveClaudeCodeCache = null;
}

async function liveClaudeCodeCredentialWithProfile({
  currentCredentialReader,
  currentProfileFetcher,
  signal = null,
}) {
  throwIfOperationAborted(signal);
  const now = Date.now();
  if (
    liveClaudeCodeCache
    && liveClaudeCodeCache.currentCredentialReader === currentCredentialReader
    && liveClaudeCodeCache.currentProfileFetcher === currentProfileFetcher
    && liveClaudeCodeCache.expiresAt > now
  ) {
    throwIfOperationAborted(signal);
    return liveClaudeCodeCache.value;
  }

  const secret = await liveClaudeCodeSecret(currentCredentialReader);
  throwIfOperationAborted(signal);
  let profile = null;
  if (secret.accessToken) {
    try {
      profile = await currentProfileFetcher(secret.accessToken, { signal });
    } catch {}
  }
  throwIfOperationAborted(signal);
  const value = { secret, profile };
  liveClaudeCodeCache = {
    currentCredentialReader,
    currentProfileFetcher,
    expiresAt: now + LIVE_CLAUDE_CODE_CACHE_TTL_MS,
    value,
  };
  return value;
}

function usageCredentialFingerprint(accessToken) {
  return credentialFingerprint('oauth', accessToken);
}

function credentialFingerprint(type, credential) {
  if (!credential) return null;
  return createHash('sha256').update(JSON.stringify([type, credential])).digest('hex');
}

function throwIfOperationAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

async function forwardOnce({
  req,
  res,
  body,
  upstream,
  account,
  secret,
  accountManager,
  passthroughErrors = false,
  reactiveQuotaConfirmer = null,
  allowReactiveQuotaConfirmation = false,
  allowQuotaRetry = true,
  allowAuthRefreshRetry = true,
  logger = null,
  upstreamIdleTimeoutMs,
  upstreamConnectTimeoutMs,
  upstreamConnectRetries,
  upstreamConnectRetryDelayMs,
  exhaustionMapper = null,
  observability = DEFAULT_OBSERVABILITY,
}) {
  const target = configuredUpstreamTarget(req.url, upstream);
  const headers = buildUpstreamHeaders(req.headers, account, secret, observability);
  const startedAt = Date.now();
  let outcome = 'ok';
  let bufferedPassthrough = false;
  let reactiveQuotaRetry = false;
  let reactiveQuotaSource = null;
  let reactiveReplayTargets = null;
  let reactiveReplayAuthorization = null;

  // R4-5: この要求で実際に写像が起きたときの痕跡。下の recordProxyRequest へ渡し、
  // **この要求の proxy ログ行**へ §9.3 のフィールドを併記する（設計書 §9.5(c)）。
  // 写像しなければ null のままなので、ログ行は現行と1文字も変わらない（§14.4）。
  let degradeLog = null;

  // 応答ヘッダ送出点（P-c :writeUpstreamResponseHead / P-e / P-g1）の単一の判定。
  // 写像したときは自分で本文まで書き切り、`false` を返して上流チャンクを流さない
  // （流すと 529 の本文の後ろへ上流 429 の本文が継ぎ足され、Content-Length も壊れる）。
  const writeMappedOrHead = (upstreamRes, mapPath) => {
    if (exhaustionMapper && upstreamRes.statusCode === 429) {
      const mapped = exhaustionMapper(
        { statusCode: upstreamRes.statusCode, headers: upstreamRes.headers, body: null },
        { mapPath, headersSent: res.headersSent },
      );
      if (mapped && mapped.statusCode !== upstreamRes.statusCode) {
        if (mapped.degradeLog?.mapReason) degradeLog = mapped.degradeLog;
        sendBufferedResponse(res, mapped);
        return false;
      }
    }
    writeUpstreamResponseHead(res, upstreamRes);
    return true;
  };

  let upstreamResponse;
  try {
    upstreamResponse = await requestUpstreamWithConnectRetries({
      target,
      method: req.method,
      headers,
      body,
      idleTimeoutMs: upstreamIdleTimeoutMs,
      connectTimeoutMs: upstreamConnectTimeoutMs,
      connectRetries: upstreamConnectRetries,
      connectRetryDelayMs: upstreamConnectRetryDelayMs,
      clientRequest: req,
      clientResponse: res,
      onRetry(error, attempt, maxAttempts) {
        logger?.(`${new Date().toISOString()} upstream-connect-retry account=${account.id} method=${req.method} path=${target.pathname} attempt=${attempt}/${maxAttempts} errorType=${error.code || error.name}`);
      },
      onResponse(upstreamRes) {
        if (!accountManager.accounts.includes(account)) {
          // P-g1: 応答ヘッダが届いた時点で口座が台帳から消えていた（reload）。
          // ここを結線しないと、この 429 は写像されないまま素通しされる（設計書 §4.2 v1.3 訂正）。
          return writeMappedOrHead(upstreamRes, 'g');
        }
        const responseQuotaEvidence = unifiedQuotaHeaderEvidence(
          upstreamRes.headers,
          accountManager.switchThreshold,
          accountManager.now(),
        );
        accountManager.updateQuota(account.id, upstreamRes.headers, {
          atomicUnifiedWindows: upstreamRes.statusCode === 429,
        });

        if (!passthroughErrors && upstreamRes.statusCode === 429) {
          const unavailableReason = accountManager.unavailableReason(account);
          if (
            allowQuotaRetry
            && responseQuotaEvidence.confirmsExhaustion
          ) {
            outcome = 'quota-retry';
            return false;
          }
          if (
            allowReactiveQuotaConfirmation
            && reactiveQuotaConfirmer
            && req.method === 'POST'
            && target.pathname === '/v1/messages'
            && account.type !== 'apikey'
            && requestModelFamily(body) === 'fable'
            && !responseQuotaEvidence.hasIncompleteExhaustion
            && typeof secret?.accessToken === 'string'
            && secret.accessToken.length > 0
          ) {
            outcome = 'reactive-quota-pending';
            return false;
          }
          outcome = 'rate-limit-passthrough';
          if (!unavailableReason) {
            accountManager.markRateLimited(account.id, retryAfterSeconds(upstreamRes.headers, 60));
          }
        }

        if (!passthroughErrors && upstreamRes.statusCode === 401) {
          if (allowAuthRefreshRetry && canRefreshSecret(account, secret)) {
            outcome = 'auth-refresh-retry';
            return false;
          } else if (secret.liveClaudeCodeCredential) {
            outcome = 'auth-live-reload';
            invalidateLiveClaudeCodeCache();
          } else {
            outcome = 'auth-account-passthrough';
            accountManager.markError(account.id, 'authentication_error', 'OAuth token rejected');
          }
        }

        // P-c（passthroughErrors=true＝利用不可口座での実送信）と
        // P-e（通常ローテーションの rate-limit-passthrough）の共通の書き出し位置。
        // P-e では直前の markRateLimited() が済んでいるので、台帳を全枯渇へ変える
        // 最後の 429 も、その同じ応答の中で写像される（設計書 §4.2）。
        return writeMappedOrHead(upstreamRes, passthroughErrors ? 'c' : 'e');
      },
      onChunk(chunk) {
        if (!res.destroyed) res.write(chunk);
      },
    });
  } catch (error) {
    if (error?.code === 'CLIENT_REQUEST_ABORTED' || req.aborted || res.destroyed) {
      return { retryNextAccount: false };
    }
    outcome = isUpstreamTimeout(error) ? 'upstream-timeout' : 'upstream-error';
    if (accountManager.accounts.includes(account)) {
      recordProxyRequest({
        accountManager,
        logger,
        account,
        method: req.method,
        path: target.pathname,
        outcome,
        durationMs: Date.now() - startedAt,
        errorType: error.code || error.name,
      });
    }

    if (!passthroughErrors && !res.headersSent) {
      sendBufferedResponse(res, syntheticUpstreamErrorResponse(error));
      return { retryNextAccount: false };
    }
    throw error;
  }

  if (!accountManager.accounts.includes(account)) {
    finishStaleAccountResponse(res, upstreamResponse, exhaustionMapper);
    return { retryNextAccount: false, passthroughResponse: upstreamResponse };
  }

  if (outcome === 'reactive-quota-pending') {
    const confirmation = !req.aborted && !res.destroyed
      ? await reactiveQuotaConfirmer.confirm({
        account,
        accessToken: secret.accessToken,
        requestBody: body,
        clientRequest: req,
        clientResponse: res,
      })
      : { confirmed: false, replayTargets: new Map(), replayAuthorization: null };
    if (!accountManager.accounts.includes(account)) {
      finishStaleAccountResponse(res, upstreamResponse, exhaustionMapper);
      return { retryNextAccount: false, passthroughResponse: upstreamResponse };
    }
    if (confirmation.confirmed && !req.aborted && !res.destroyed) {
      outcome = 'quota-retry';
      reactiveQuotaRetry = true;
      reactiveQuotaSource = account;
      reactiveReplayTargets = confirmation.replayTargets;
      reactiveReplayAuthorization = confirmation.replayAuthorization;
    } else {
      outcome = 'rate-limit-passthrough';
      if (accountManager.accounts.includes(account)) {
        const unavailableReason = accountManager.unavailableReason(account);
        if (!unavailableReason) {
          accountManager.markRateLimited(account.id, retryAfterSeconds(upstreamResponse.headers, 60));
        }
      }
      bufferedPassthrough = true;
    }
  }

  // P-f の再生はこの下（bufferedPassthrough の分岐）で書き出すが、写像はログより先に
  // 決めておく。そうしないと 529 を返した行に痕跡が載らない（§9.1・受入条件7）。
  const bufferedReplay = bufferedPassthrough && exhaustionMapper && !req.aborted && !res.destroyed
    ? exhaustionMapper(upstreamResponse, { mapPath: 'f', headersSent: res.headersSent })
    : null;
  if (bufferedReplay?.degradeLog?.mapReason) degradeLog = bufferedReplay.degradeLog;

  // durationMs は観測の解凍を await する前に確定させる。解凍時間が混ざると、
  // 配備前後で遅延の分位点を比べられなくなる（計画書 (d)・リスク R-5）。
  const durationMs = Date.now() - startedAt;

  // 応答本文の**写し**を読むだけで、クライアントへ流すバイト列には触れない。
  // 解凍は非同期版を使う（同期版はイベントループを塞ぐ）。本文は既に onChunk で
  // クライアントへ流れ切っており、遅れるのは終端だけである。
  const observation = accountManager.accounts.includes(account) && upstreamResponse.body.length > 0
    ? await parseUsageObservation(upstreamResponse.body, {
      contentEncoding: headerValue(upstreamResponse.headers['content-encoding']),
      maxBytes: observability.requestLog.maxBodyBytes,
    })
    : null;

  if (accountManager.accounts.includes(account)) {
    recordProxyRequest({
      accountManager,
      logger,
      account,
      method: req.method,
      path: target.pathname,
      statusCode: upstreamResponse.statusCode,
      requestId: headerValue(upstreamResponse.headers['request-id'])
        || headerValue(upstreamResponse.headers['x-request-id']),
      // outcome は上流で実際に起きたこと（rate-limit-passthrough 等）のままにする。
      // 何へ書き換えたかは同じ行の mappedTo / mapReason が持つ（§9.4 は bridge 経路の分岐）。
      outcome: outcomeForResponse(outcome, upstreamResponse.statusCode),
      durationMs,
      degradeLog,
      observationLog: observability.requestLog.enabled
        ? buildObservationLog({ req, body, observation, upstreamResponse, observability })
        : null,
    });
  }

  if (!passthroughErrors && outcome === 'quota-retry') {
    return {
      retryNextAccount: true,
      passthroughResponse: upstreamResponse,
      reactiveQuotaRetry,
      reactiveQuotaSource,
      reactiveReplayTargets,
      reactiveReplayAuthorization,
    };
  }

  if (bufferedPassthrough) {
    // P-f: 反応的枠確認が「未確認」に終わったときの再生。直前の markRateLimited() の
    // 後に評価されるので、ここでも全枯渇へ変わる最後の 429 が写像される（設計書 §4.2）。
    // 写像の判定自体は上の bufferedReplay で済ませてある（順序を変えただけで挙動は同じ）。
    if (!req.aborted && !res.destroyed) {
      sendBufferedResponse(res, bufferedReplay || upstreamResponse);
    }
    return { retryNextAccount: false };
  }

  if (!passthroughErrors && outcome === 'auth-refresh-retry') {
    return { retryAfterRefresh: true, passthroughResponse: upstreamResponse };
  }

  // 解析は上の1回だけ。ここでは結果を集計へ写す（口座が台帳から消えていないか再確認する）。
  if (accountManager.accounts.includes(account)) {
    applyUsageObservation(accountManager, account.id, observation);
  }

  if (!res.writableEnded) res.end();
  return { retryNextAccount: false };
}

function writeUpstreamResponseHead(res, upstreamRes) {
  const responseHeaders = {};
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    if (!HOP_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
  }
  res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
}

function finishStaleAccountResponse(res, upstreamResponse, exhaustionMapper = null) {
  if (res.destroyed || res.writableEnded) return;
  // P-g2: onResponse が false を返して本文をバッファした後（quota-retry /
  // reactive-quota-pending）に口座が消えた場合だけ、ここが 429 を書き出す。
  // P-g1 を通った要求は res.headersSent が真なので、二重には書き換わらない（§8.6）。
  if (!res.headersSent && upstreamResponse) {
    sendBufferedResponse(res, exhaustionMapper
      ? exhaustionMapper(upstreamResponse, { mapPath: 'g', headersSent: res.headersSent })
      : upstreamResponse);
  } else res.end();
}

function configuredUpstreamTarget(requestTarget, upstream) {
  const inbound = new URL(requestTarget, 'http://claude-rotator.local');
  const target = new URL(upstream);
  target.pathname = inbound.pathname;
  target.search = inbound.search;
  target.hash = '';
  return target;
}

function safeRequestPath(requestTarget) {
  try {
    return new URL(requestTarget, 'http://claude-rotator.local').pathname;
  } catch {
    return '<invalid-request-target>';
  }
}

function assertLoopbackProxyHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (['127.0.0.1', '::1', 'localhost'].includes(normalized)) return;
  throw new Error(`Proxy host must be loopback, received ${normalized || '<empty>'}`);
}

function isTrustedLocalHttpRequest(req) {
  const hostAuthority = loopbackHostAuthority(req.headers.host);
  if (!hostAuthority) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && isLoopbackHostname(parsed.hostname)
      && parsed.host.toLowerCase() === hostAuthority;
  } catch {
    return false;
  }
}

function loopbackHostAuthority(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return isLoopbackHostname(parsed.hostname) ? parsed.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(
    String(hostname || '').trim().toLowerCase(),
  );
}

function buildUpstreamHeaders(inputHeaders, account, secret, observability = DEFAULT_OBSERVABILITY) {
  const headers = {};
  for (const [key, value] of Object.entries(inputHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower)) continue;
    if (lower === 'x-api-key' || lower === 'authorization') continue;
    // 要求ヘッダを書き換える唯一の箇所。この実行環境が解けない符号化（Node 22.15 未満の
    // zstd）だけを一覧から落とす。Claude Code は `gzip, deflate, br, zstd` を送るので、
    // 落とさないと上流が zstd で返したときに usage を1件も数えられない（計画書 Task 1 Step 0）。
    // 落とすものが無ければ受け取った文字列がそのまま返るので、ヘッダはバイト同一のままになる。
    headers[key] = lower === 'accept-encoding' && observability.upstream.dropUndecodableAcceptEncoding
      ? upstreamAcceptEncoding(value)
      : value;
  }

  if (account.type === 'apikey') {
    headers['x-api-key'] = secret.apiKey;
  } else {
    appendHeaderCapability(headers, 'anthropic-beta', OAUTH_BETA_HEADER);
    headers.authorization = `Bearer ${secret.accessToken}`;
  }
  return headers;
}

function appendHeaderCapability(headers, headerName, capability) {
  const existingKey = Object.keys(headers)
    .find(key => key.toLowerCase() === headerName.toLowerCase());
  const current = existingKey == null ? '' : headers[existingKey];
  const values = (Array.isArray(current) ? current : [current])
    .flatMap(value => String(value || '').split(','))
    .map(value => String(value).trim())
    .filter(Boolean);
  const normalized = values.filter(value => value !== capability);
  normalized.push(capability);
  if (existingKey != null && existingKey !== headerName) delete headers[existingKey];
  headers[headerName] = normalized.join(',');
}

async function requestUpstreamWithConnectRetries(options) {
  const retryCount = Math.max(0, Number(options.connectRetries) || 0);
  const maxAttempts = retryCount + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestUpstream(options);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableConnectError(error)) throw error;
      options.onRetry?.(error, attempt, maxAttempts);
      await sleep(Math.max(0, Number(options.connectRetryDelayMs) || 0));
    }
  }
  throw new Error('unreachable upstream retry state');
}

function requestUpstream({
  target,
  method,
  headers,
  body,
  idleTimeoutMs,
  connectTimeoutMs,
  clientRequest = null,
  clientResponse = null,
  onResponse,
  onChunk,
}) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    let idleTimer = null;
    let connectTimer = null;
    let connected = false;
    let responseStarted = false;
    let req = null;
    const cleanupClientListeners = () => {
      clientRequest?.removeListener('aborted', onClientAborted);
      clientResponse?.removeListener('close', onClientResponseClose);
    };
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (connectTimer) clearTimeout(connectTimer);
      cleanupClientListeners();
      if (error) reject(error);
      else resolve(result);
    };
    const onClientAborted = () => {
      const error = clientRequestAbortedError();
      req?.destroy(error);
      settle(error);
    };
    const onClientResponseClose = () => {
      if (!clientResponse?.writableEnded) onClientAborted();
    };
    const markConnected = () => {
      connected = true;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };
    const startConnectTimer = () => {
      if (!connectTimeoutMs || connectTimeoutMs <= 0 || settled) return;
      connectTimer = setTimeout(() => {
        const error = new Error(`Upstream connection timeout after ${connectTimeoutMs}ms`);
        error.code = 'UPSTREAM_CONNECT_TIMEOUT';
        error.connectPhase = true;
        req?.destroy(error);
        settle(error);
      }, connectTimeoutMs);
      connectTimer.unref?.();
    };
    const resetIdleTimer = () => {
      if (!idleTimeoutMs || idleTimeoutMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = new Error(`Upstream request idle timeout after ${idleTimeoutMs}ms`);
        error.code = 'UPSTREAM_IDLE_TIMEOUT';
        req?.destroy(error);
        settle(error);
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, upstreamRes => {
      responseStarted = true;
      markConnected();
      resetIdleTimer();
      const chunks = [];
      let shouldStream = false;
      upstreamRes.on('error', settle);
      try {
        shouldStream = onResponse(upstreamRes);
      } catch (error) {
        upstreamRes.destroy(error);
        settle(error);
        return;
      }
      upstreamRes.on('data', chunk => {
        if (settled) return;
        try {
          resetIdleTimer();
          chunks.push(chunk);
          if (shouldStream) onChunk(chunk);
        } catch (error) {
          upstreamRes.destroy(error);
          settle(error);
        }
      });
      upstreamRes.on('end', () => {
        settle(null, {
          statusCode: upstreamRes.statusCode,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks),
        });
      });
      upstreamRes.on('aborted', () => {
        const error = new Error('Upstream response aborted');
        error.code = 'UPSTREAM_RESPONSE_ABORTED';
        settle(error);
      });
    });
    req.on('socket', socket => {
      guardUpstreamSocket(socket);
      if (!socket.connecting) {
        markConnected();
        return;
      }
      if (target.protocol === 'https:') socket.once('secureConnect', markConnected);
      else socket.once('connect', markConnected);
    });
    req.on('error', error => {
      if (!connected && !responseStarted && isConnectNetworkError(error)) {
        error.connectPhase = true;
      }
      settle(error);
    });
    clientRequest?.once('aborted', onClientAborted);
    clientResponse?.once('close', onClientResponseClose);
    if (clientRequest?.aborted || clientResponse?.destroyed) {
      onClientAborted();
      return;
    }
    if (!['GET', 'HEAD'].includes(method) && body.length > 0) req.write(body);
    startConnectTimer();
    resetIdleTimer();
    req.end();
  });
}

function guardUpstreamSocket(socket) {
  if (guardedUpstreamSockets.has(socket)) return;
  guardedUpstreamSockets.add(socket);
  // A TLS socket can emit a late EPIPE after its ClientRequest has already settled.
  socket.on('error', () => {});
}

function isRetryableConnectError(error) {
  return Boolean(error?.connectPhase) && isConnectNetworkError(error);
}

function isConnectNetworkError(error) {
  return [
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNREFUSED',
    'ECONNRESET',
    'UPSTREAM_CONNECT_TIMEOUT',
  ].includes(error?.code);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

function retryAfterSeconds(headers = {}, fallbackSeconds) {
  const parsed = Number.parseInt(headerValue(headers['retry-after']), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackSeconds;
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0];
  return value == null ? null : String(value);
}

function isUpstreamTimeout(error) {
  return error?.code === 'UPSTREAM_IDLE_TIMEOUT'
    || error?.code === 'UPSTREAM_CONNECT_TIMEOUT';
}

function outcomeForResponse(outcome, statusCode) {
  if (outcome !== 'ok') return outcome;
  if (statusCode >= 500) return 'upstream-error-passthrough';
  if (statusCode >= 400) return 'client-error-passthrough';
  return 'ok';
}

function recordProxyRequest({
  accountManager,
  logger,
  account,
  method,
  path,
  statusCode = null,
  requestId = null,
  outcome,
  durationMs,
  errorType = null,
  // R4-5: 写像した要求の痕跡（mapClaudeExhaustion の戻り値 degradeLog）。任意引数なので
  // 渡さなければ現行と完全に同一に振る舞う（設計書 §14.4）。
  degradeLog = null,
  // sticky R-S7 の追記情報の予約席。起点 60da9aa には R-S7 がまだ無いので常に null だが、
  // 引数の順序を先に確定させておき、sticky 合流時に番号を振り直さずに済ませる。
  affinityLog = null,
  // キャッシュ観測の追記情報。null なら行は現行とバイト単位で同一になる。
  observationLog = null,
}) {
  // 写像した要求では、クライアントへ実際に返した status（mappedTo）を記録する。
  // 写像前の実ステータスは同じ行の upstreamStatus / mappedFrom に必ず残るので、
  // 「529 と偽装した行から本当の上流ステータスが読める」（§9.1・受入条件7）。
  const sentStatusCode = degradeLog?.mappedTo ?? statusCode;
  const event = accountManager.recordProxyRequest({
    account: account.id,
    method,
    path,
    statusCode: sentStatusCode,
    requestId,
    outcome,
    durationMs,
    errorType,
  });
  writeProxyLog(logger, event, degradeLog, affinityLog, observationLog);
}

/**
 * 写像した要求のログ行へ足すフィールド（設計書 §9.3 の順序で、値があるキーだけ）。
 * upstreamStatus には写像前の実ステータスを入れる。P-a / P-d のように rotator が
 * 局所合成した 429 でも、「その要求が本来返そうとしていた status」を指す点は同じである。
 * 写像しなかった要求（mapReason が無い）では空文字列を返し、行は現行と一致する。
 */
function degradeLogFields(degradeLog) {
  if (!degradeLog?.mapReason) return '';
  return formatLogMeta(buildBridgeLogMeta(
    { upstreamStatus: degradeLog.mappedFrom, resetAt: degradeLog.resetAt },
    degradeLog,
  ));
}

/**
 * `proxy` 行を書く。
 *
 * 引数順は `(logger, event, degradeLog, affinityLog, observationLog)` に固定し、
 * 連結順は `degradeLogFields` → `affinityLogFields`（sticky R-S7 が持ち込む。
 * 起点 60da9aa にはまだ無い） → `observationLogFields` の固定とする。
 * 追記は必ず末尾へ。値が1つも無ければ行は現行とバイト単位で同一になる。
 */
function writeProxyLog(logger, event, degradeLog = null, affinityLog = null, observationLog = null) {
  if (!logger) return;
  const fields = [
    `${event.at} proxy`,
    `account=${event.account}`,
    `method=${event.method}`,
    `path=${event.path}`,
    `status=${event.statusCode ?? '-'}`,
    `durationMs=${event.durationMs}`,
    `outcome=${event.outcome}`,
  ];
  if (event.requestId) fields.push(`requestId=${event.requestId}`);
  if (event.errorType) fields.push(`errorType=${event.errorType}`);
  // 追記は必ず末尾へ（§9.2）。値が1つも無ければ行は現行とバイト単位で同一になる。
  logger(`${fields.join(' ')}${degradeLogFields(degradeLog)}${observationLogFields(observationLog, affinityLog)}`);
}

function syntheticUpstreamErrorResponse(error) {
  const statusCode = isUpstreamTimeout(error) ? 504 : 502;
  const type = isUpstreamTimeout(error) ? 'upstream_timeout' : 'upstream_error';
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type,
        message: error.message,
      },
    })),
  };
}

function sendCurrentQuotaUnavailableResponse({
  req,
  res,
  accountManager,
  logger,
  modelFamily = null,
  exhaustionMapper = null,
}) {
  let account = accountManager.getCurrentAccount();
  // Use the modelFamily-aware reason so a non-matching-family request never
  // gets handed a misleading scoped claim (e.g. `seven_day_fable`) when it
  // was really blocked by an unrelated common-quota window (m2).
  let reason = accountManager.unavailableReasonForModelFamily(account, modelFamily);
  if (!isUnifiedQuotaExhaustion(reason)) return false;

  const shortestResetAccount = accountManager.selectBestExhaustedFallback({ trigger: 'request' });
  if (shortestResetAccount) {
    account = shortestResetAccount;
    reason = accountManager.unavailableReasonForModelFamily(account, modelFamily);
    if (!isUnifiedQuotaExhaustion(reason)) return false;
  }

  const response = syntheticQuotaExhaustedResponse(account, reason);
  // P-a: 合成した 429 を書き出す唯一の位置（設計書 §4.2）。写像はログより先に決める。
  // ログ行の status は実際に返した値（529 / 403）にし、写像前の 429 は同じ行の
  // upstreamStatus / mappedFrom として残す（§9.5(c)・受入条件7）。
  const mapped = exhaustionMapper
    ? exhaustionMapper(response, { mapPath: 'a', headersSent: res.headersSent })
    : response;
  recordProxyRequest({
    accountManager,
    logger,
    account,
    method: req.method,
    path: new URL(req.url, 'http://claude-rotator.local').pathname,
    statusCode: response.statusCode,
    outcome: 'quota-exhausted-local',
    durationMs: 0,
    degradeLog: mapped?.degradeLog || null,
  });
  sendBufferedResponse(res, mapped);
  return true;
}

function syntheticQuotaExhaustedResponse(account, reason) {
  const windowHeader = quotaWindowHeader(reason.window);
  const claim = reason.claim || quotaRepresentativeClaim(reason.window);
  const resetSeconds = quotaResetSeconds(reason.resetAt);
  const headers = {
    'content-type': 'application/json',
    'x-claude-rotator-account': account?.id || '',
    'x-claude-rotator-quota-window': reason.window || '',
  };
  if (claim) {
    headers['anthropic-ratelimit-unified-status'] = 'rejected';
    headers['anthropic-ratelimit-unified-representative-claim'] = claim;
  }
  if (resetSeconds) headers['anthropic-ratelimit-unified-reset'] = resetSeconds;
  if (windowHeader) {
    headers[`anthropic-ratelimit-unified-${windowHeader}-utilization`] = String(reason.utilization ?? 1);
    if (resetSeconds) headers[`anthropic-ratelimit-unified-${windowHeader}-reset`] = resetSeconds;
  }

  const rotatorMessage = quotaExhaustedRotatorMessage(account, reason);
  return {
    statusCode: 429,
    headers,
    body: Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: quotaExhaustedOfficialMessage(reason),
        details: {
          source: 'claude-rotator',
          account: account?.id || null,
          account_name: account?.name || null,
          window: reason.window,
          utilization: reason.utilization,
          reset_at: reason.resetAt || null,
          rotator_message: rotatorMessage,
        },
      },
    })),
  };
}

function quotaWindowHeader(window) {
  if (window === '5h') return '5h';
  if (window === '7d') return '7d';
  return null;
}

function quotaRepresentativeClaim(window) {
  if (window === '5h') return 'five_hour';
  if (window === '7d') return 'seven_day';
  return null;
}

function quotaResetSeconds(resetAt) {
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return null;
  return String(Math.floor(parsed / 1000));
}

function quotaExhaustedOfficialMessage(reason) {
  const limit = reason.window === '5h'
    ? 'session limit'
    : reason.window === '7d'
      ? 'weekly limit'
      : String(reason.window || '').startsWith('7d ')
        ? `${reason.window.slice(3)} weekly limit`
        : 'usage limit';
  const reset = reason.resetAt ? ` · resets ${formatClaudeResetTime(reason.window, reason.resetAt)}` : '';
  return `You've hit your ${limit}${reset}`;
}

function quotaExhaustedRotatorMessage(account, reason) {
  const reset = reason.resetAt ? ` Resets at ${reason.resetAt}.` : '';
  return `Claude ${reason.window} usage limit exhausted for ${account?.name || account?.id || 'current account'}.${reset} No available rotation target.`;
}

function formatClaudeResetTime(window, resetAt) {
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return resetAt;
  const date = new Date(parsed);
  const time = formatTwelveHourTime(date);
  if (window === '7d' || String(window || '').startsWith('7d ')) {
    const month = date.toLocaleString('en-US', { month: 'short' });
    return `${month} ${date.getDate()} at ${time}`;
  }
  return time;
}

function formatTwelveHourTime(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const hour = hours % 12 || 12;
  const suffix = hours < 12 ? 'am' : 'pm';
  if (minutes === 0) return `${hour}${suffix}`;
  return `${hour}:${String(minutes).padStart(2, '0')}${suffix}`;
}

function sendBufferedResponse(res, response) {
  const headers = {};
  for (const [key, value] of Object.entries(response.headers || {})) {
    if (!HOP_HEADERS.has(key.toLowerCase())) headers[key] = value;
  }
  res.writeHead(response.statusCode || 502, headers);
  res.end(response.body || Buffer.alloc(0));
}

/**
 * 解析済みの観測を口座の集計へ足す。
 *
 * **読めた要求だけを数える。** `parse` が `ok` 以外（解けない符号化・大きすぎる本文・
 * 解析不能・usage 無し）のときは口座の状態を一切動かさない。読めなかった件数は
 * `server.log` の `usageParse=` の分布から数える。
 *
 * 旧 `extractUsage()` は `content-encoding` を見ずに圧縮されたバイト列を UTF-8 として
 * 解釈していたため、例外も警告も出さないまま 0 件で終わっていた（本件の根本原因）。
 */
function applyUsageObservation(accountManager, accountId, observation) {
  if (observation?.parse !== 'ok') return;
  try {
    accountManager.updateUsage(accountId, {
      inputTokens: observation.inputTokens,
      outputTokens: observation.outputTokens,
      cacheReadTokens: observation.cacheReadTokens,
      cacheCreation1hTokens: observation.cacheCreation1hTokens,
      cacheCreation5mTokens: observation.cacheCreation5mTokens,
      // 1応答＝1件。旧実装はストリームで message_start と message_delta の2回数えていた。
      countRequest: true,
    });
  } catch {
    // 集計の失敗で応答を壊さない（旧実装の try/catch と同じ規律）。
  }
}

/**
 * `proxy` 行へ足す観測情報を組み立てる。
 *
 * 枠の使用率は `parseRateLimitHeaders()` をもう一度呼んで作る。`updateQuota()` が
 * `onResponse` で同じ解析をしているが、そちらは口座台帳を更新する副作用つきなので、
 * ログ用には副作用の無いこの関数を別に呼ぶ。reset はミリ秒で返るのでエポック秒へ直す。
 */
function buildObservationLog({ req, body, observation, upstreamResponse, observability }) {
  const quota = parseRateLimitHeaders(upstreamResponse.headers);
  // 既定では要求本文を読まない。本文は数百 KB〜数 MB あり、JSON.parse の追加1回が
  // 要求ごとの実コストになる。まずヘッダ付与率を測ってから有効化を決める。
  const sessionSource = observability.requestLog.sessionFromBody ? body : null;
  return {
    model: observation?.model ?? null,
    // 生のセッション id は出さない。出すのは sha256 の先頭 12 桁だけ。
    sid: sidHash(sessionKeyFrom(req, sessionSource)),
    inputTokens: observation?.inputTokens ?? 0,
    outputTokens: observation?.outputTokens ?? 0,
    cacheReadTokens: observation?.cacheReadTokens ?? 0,
    cacheCreationTokens: observation?.cacheCreationTokens ?? 0,
    cacheCreation1hTokens: observation?.cacheCreation1hTokens ?? 0,
    cacheCreation5mTokens: observation?.cacheCreation5mTokens ?? 0,
    quota: {
      unified5h: quota.unified5h,
      unified5hReset: epochSeconds(quota.unified5hReset),
      unified7d: quota.unified7d,
      unified7dReset: epochSeconds(quota.unified7dReset),
    },
    encoding: observation?.encoding ?? null,
    parse: observation?.parse ?? 'no-usage',
  };
}

function epochSeconds(milliseconds) {
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1000)
    : null;
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

function sendUnavailableAccounts(res, accountManager = null, exhaustionMapper = null) {
  const current = accountManager?.getCurrentAccount();
  const reason = current ? accountManager.unavailableReason(current) : null;
  if (isCredentialUnavailable(reason)) {
    const headers = { 'Content-Type': 'application/json' };
    const now = Date.now();
    const retryTimes = (accountManager?.accounts || [])
      .map(account => accountManager.unavailableReason(account))
      .flatMap(accountReason => [accountReason?.retryAt, accountReason?.resetAt])
      .map(recoveryAt => Date.parse(recoveryAt || ''))
      .filter(retryAt => Number.isFinite(retryAt) && retryAt > now);
    const retryAt = retryTimes.length > 0 ? Math.min(...retryTimes) : null;
    if (retryAt != null) {
      headers['Retry-After'] = String(Math.max(1, Math.ceil((retryAt - now) / 1000)));
    }
    res.writeHead(503, headers);
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'No usable OAuth credential is currently available.',
      },
    }));
    return;
  }
  // P-d の 429 分岐。503 分岐（認証情報が使えない）は上で return 済みなので
  // 自動的に写像対象外になる（契約 §C10.4 補足②。個別の除外条件を書かない）。
  const body = {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'All configured accounts are unavailable.' },
  };
  const mapped = exhaustionMapper?.({
    statusCode: 429,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  }, { mapPath: 'd', headersSent: res.headersSent });
  if (mapped && mapped.statusCode !== 429) {
    sendBufferedResponse(res, mapped);
    return;
  }
  sendJson(res, 429, body);
}

function shortErrorMessage(error) {
  const parts = [error?.message || error || 'unknown error'];
  const cause = error?.cause;
  if (cause) {
    const causeParts = [
      cause.name,
      cause.code,
      cause.message,
      cause.syscall,
      cause.address && cause.port ? `${cause.address}:${cause.port}` : cause.address,
    ].filter(Boolean);
    if (causeParts.length > 0) parts.push(`cause: ${causeParts.join(' ')}`);
  }
  return String(parts.join(' · ')).replace(/\s+/g, ' ').slice(0, 360);
}
