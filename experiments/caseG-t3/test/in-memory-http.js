import http from 'node:http';
import { Duplex } from 'node:stream';

// The real HTTP parser and streams run over paired memory sockets. No OS socket
// is opened. Unknown destinations throw, so a missed injection cannot go online.
export function installMemoryHttp(t) {
  const servers = new Map();
  const originalServer = http.createServer;
  const originalRequest = http.request;
  const originalGet = http.get;
  let nextPort = 41000;

  class MemorySocket extends Duplex {
    constructor() {
      super({ allowHalfOpen: false });
      this.remoteAddress = '127.0.0.1';
      this.remotePort = 50000;
      this.connecting = false;
    }
    _read() { this.peer?.resumeWrite?.(); }
    _write(chunk, _encoding, callback) {
      if (this.peer.destroyed) { callback(new Error('memory socket closed')); return; }
      if (this.peer.push(Buffer.from(chunk))) callback();
      else this.resumeWrite = () => { this.resumeWrite = null; callback(); };
    }
    _final(callback) { this.peer.push(null); callback(); }
    _destroy(_error, callback) {
      this.peer?.push(null);
      this.resumeWrite?.();
      callback();
      if (!this.peer?.destroyed) this.peer?.destroy();
    }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
    destroySoon() { this.end(); }
  }

  http.createServer = (...args) => {
    const server = originalServer(...args);
    const sockets = new Set();
    let address = null;
    server.listen = (port, host, callback) => {
      if (host !== '127.0.0.1' || port === 37891) throw new Error('unsafe memory listener');
      address = { address: host, family: 'IPv4', port: port || nextPort++ };
      if (servers.has(address.port)) throw new Error('memory port busy');
      servers.set(address.port, { server, sockets });
      queueMicrotask(() => { server.emit('listening'); callback?.(); });
      return server;
    };
    server.address = () => address;
    server.closeAllConnections = () => { for (const socket of sockets) socket.destroy(); };
    server.close = callback => {
      if (address) servers.delete(address.port);
      address = null;
      server.closeAllConnections();
      queueMicrotask(() => { server.emit('close'); callback?.(); });
      return server;
    };
    return server;
  };
  http.request = (options, callback) => {
    if (typeof options !== 'object' || (options.hostname ?? options.host) !== '127.0.0.1') throw new Error('non-memory destination refused');
    const entry = servers.get(Number(options.port));
    if (!entry) throw new Error('unknown memory destination');
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => {
      const client = new MemorySocket();
      const accepted = new MemorySocket();
      client.peer = accepted;
      accepted.peer = client;
      entry.sockets.add(accepted);
      accepted.on('close', () => entry.sockets.delete(accepted));
      queueMicrotask(() => entry.server.emit('connection', accepted));
      return client;
    };
    return originalRequest({ ...options, agent }, callback);
  };
  http.get = (options, callback) => {
    const req = http.request(options, callback);
    req.end();
    return req;
  };
  t.after(() => {
    for (const { server } of servers.values()) server.closeAllConnections();
    http.createServer = originalServer;
    http.request = originalRequest;
    http.get = originalGet;
  });
}
