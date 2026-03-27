'use strict';

const net = require('net');

const LISTEN_START = Number(process.env.TCP_LISTEN_START ?? 8100);
const LISTEN_END = Number(process.env.TCP_LISTEN_END ?? 8200);
const TARGET_HOSTS = (process.env.TCP_TARGET_HOST ?? '127.0.0.1')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
/** 수신 포트 + 오프셋 = Target 포트 (기본 0이면 8100 → Target 8100) */
const TARGET_PORT_OFFSET = Number(process.env.TCP_TARGET_PORT_OFFSET ?? 0);
const LOG_COALESCE_MS = Number(process.env.TCP_LOG_COALESCE_MS ?? 10);

if (!Number.isFinite(LISTEN_START) || !Number.isFinite(LISTEN_END)) {
  throw new Error('Invalid TCP_LISTEN_START / TCP_LISTEN_END');
}
if (LISTEN_START > LISTEN_END) {
  throw new Error('TCP_LISTEN_START must be <= TCP_LISTEN_END');
}
if (!Number.isFinite(TARGET_PORT_OFFSET)) {
  throw new Error('Invalid TCP_TARGET_PORT_OFFSET');
}
if (!Number.isFinite(LOG_COALESCE_MS) || LOG_COALESCE_MS < 0) {
  throw new Error('Invalid TCP_LOG_COALESCE_MS');
}
if (TARGET_HOSTS.length < 1) {
  throw new Error('TCP_TARGET_HOST must contain at least one host (comma separated)');
}

function targetPortFor(listenPort) {
  return listenPort + TARGET_PORT_OFFSET;
}

function kstNowString() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function chunkToLogHex(chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const hex = buf.toString('hex');
  const max = 4096;
  return hex.length > max ? `${hex.slice(0, max)}...` : hex;
}

function createProxyServer(listenPort) {
  const tp = targetPortFor(listenPort);

  const server = net.createServer((clientSocket) => {
    const upstreams = new Map();
    const peer = `${clientSocket.remoteAddress ?? '-'}:${clientSocket.remotePort ?? '-'}`;
    let coalesceTimer = null;
    const coalescedChunks = [];
    const primaryHost = TARGET_HOSTS[0];


    const handleUpstreamDown = (host) => {
      const sock = upstreams.get(host);
      if (sock && !sock.destroyed) {
        sock.destroy();
      }
      upstreams.delete(host);
    };

    const ensureUpstream = (host) => {
      const existing = upstreams.get(host);
      if (existing && !existing.destroyed) return existing;

      const upstream = net.createConnection({ host, port: tp });
      upstreams.set(host, upstream);

      upstream.on('error', (err) => {
        console.error(
          `[${kstNowString()}] [${listenPort}] ${peer} upstream error ${host}:${tp} ->`,
          err?.message ?? err
        );
        handleUpstreamDown(host);
      });
      upstream.on('close', () => handleUpstreamDown(host));
      upstream.on('data', (chunk) => {
        // 다중 Target 중 첫 번째 host 응답만 클라이언트로 전달
        if (host === primaryHost && !clientSocket.destroyed) {
          clientSocket.write(chunk);
        }
      });
      return upstream;
    };

    const flushSend = () => {
      if (coalescedChunks.length === 0) return;
      const merged = Buffer.concat(coalescedChunks);
      coalescedChunks.length = 0;

      for (const host of TARGET_HOSTS) {
        const target = ensureUpstream(host);
        if (!target || target.destroyed || !target.writable) {
          console.log(
            `[${kstNowString()}] [${listenPort}] ${peer} drop (upstream unavailable) ${host}:${tp}`
          );
          continue;
        }
        target.write(merged);
      }
      console.log(
        `[${kstNowString()}] [${listenPort}] ${peer} recv (${merged.length} bytes) hex: ${chunkToLogHex(merged)}`
      );

    };

    const flushRecvLog = () => {
      if (coalescedChunks.length === 0) return;
      const merged = Buffer.concat(coalescedChunks);
      console.log(
        `[${kstNowString()}] [${listenPort}] ${peer} recv (${merged.length} bytes) hex: ${chunkToLogHex(merged)}`
      );
    };


    const flushCoalesced = () => {
      coalesceTimer = null;
      //flushRecvLog();
      flushSend();
    };

    const cleanup = () => {
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      flushCoalesced();
      if (!clientSocket.destroyed) clientSocket.destroy();
      for (const sock of upstreams.values()) {
        if (!sock.destroyed) sock.destroy();
      }
      upstreams.clear();
    };

    clientSocket.on('error', cleanup);
    clientSocket.on('close', cleanup);

    clientSocket.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      coalescedChunks.push(buf);
      if (!coalesceTimer) {
        coalesceTimer = setTimeout(flushCoalesced, LOG_COALESCE_MS);
      }
    });
  });

  server.on('error', (err) => {
    console.error(`[${listenPort}] server error:`, err?.message ?? err);
  });

  return server;
}

function startTcpProxy() {
  const servers = [];
  let started = 0;
  const total = LISTEN_END - LISTEN_START + 1;

  for (let port = LISTEN_START; port <= LISTEN_END; port++) {
    const srv = createProxyServer(port);
    srv.listen(port, () => {
      started += 1;
      console.log(
        `Listening :${port} -> ${TARGET_HOSTS.map((h) => `${h}:${targetPortFor(port)}`).join(', ')} [${started}/${total}]`
      );
    });
    servers.push(srv);
  }

  console.log(
    `TCP proxy ready: ${LISTEN_START}..${LISTEN_END} -> ${TARGET_HOSTS.join(', ')} (offset ${TARGET_PORT_OFFSET})`
  );
  return servers;
}

module.exports = { startTcpProxy, createProxyServer };
