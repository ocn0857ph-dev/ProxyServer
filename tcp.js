'use strict';

const net = require('net');
const { insertTcpProxyLog, fetchTcpTargetHosts } = require('./sql.js');
const { sendTelegramMessage } = require('./telegram.js');

const LISTEN_START = Number(process.env.TCP_LISTEN_START ?? 8100);
const LISTEN_END = Number(process.env.TCP_LISTEN_END ?? 8200);
const LOG_COALESCE_MS = Number(process.env.TCP_LOG_COALESCE_MS ?? 10);

if (!Number.isFinite(LISTEN_START) || !Number.isFinite(LISTEN_END)) {
  throw new Error('Invalid TCP_LISTEN_START / TCP_LISTEN_END');
}
if (LISTEN_START > LISTEN_END) {
  throw new Error('TCP_LISTEN_START must be <= TCP_LISTEN_END');
}
if (!Number.isFinite(LOG_COALESCE_MS) || LOG_COALESCE_MS < 0) {
  throw new Error('Invalid TCP_LOG_COALESCE_MS');
}

function targetPortFor(listenPort, nOffset) {
  return listenPort + nOffset;
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

/**
 * @param {number} listenPort
 */
function createProxyServer(listenPort) {
  const server = net.createServer((clientSocket) => {
    const upstreams = new Map();
    const peer = `${clientSocket.remoteAddress ?? '-'}:${clientSocket.remotePort ?? '-'}`;
    let coalesceTimer = null;
    const coalescedChunks = [];
    /** 매 수신 배치마다 DB 조회 후 첫 번째 target 기준 (upstream 응답 라우팅) */
    let primaryResponseKey = null;

    const handleUpstreamDown = (key) => {
      const sock = upstreams.get(key);
      if (sock && !sock.destroyed) {
        sock.destroy();
      }
      upstreams.delete(key);
    };

    const ensureUpstream = (sIP, hostPort) => {
      const key = `${sIP}:${hostPort}`;
      const existing = upstreams.get(key);
      if (existing && !existing.destroyed) return existing;

      const upstream = net.createConnection({ host: sIP, port: hostPort });
      upstreams.set(key, upstream);

      upstream.on('error', (err) => {
        console.error(
          `[${kstNowString()}] [${listenPort}] ${peer} upstream error ${sIP}:${hostPort} ->`,
          err?.message ?? err
        );
        handleUpstreamDown(key);
      });
      upstream.on('close', () => handleUpstreamDown(key));
      upstream.on('data', (chunk) => {
        // 다중 Target 중 (해당 배치의) 첫 번째 target 응답만 클라이언트로 전달
        if (key === primaryResponseKey && !clientSocket.destroyed) {
          clientSocket.write(chunk);
        }
      });
      return upstream;
    };

    const flushSend = async () => {
      if (coalescedChunks.length === 0) return;
      const merged = Buffer.concat(coalescedChunks);
      coalescedChunks.length = 0;

      let targetHosts;
      try {
        targetHosts = await fetchTcpTargetHosts();
      } catch (err) {
        console.error(
          `[${kstNowString()}] [${listenPort}] ${peer} fetchTcpTargetHosts failed ->`,
          err?.message ?? err
        );
        return;
      }
      if (targetHosts.length < 1) {
        console.error(
          `[${kstNowString()}] [${listenPort}] ${peer} tb_tcp_host_info has no valid rows, drop ${merged.length} bytes`
        );
        return;
      }

      const primary = targetHosts[0];
      primaryResponseKey = `${primary.sIP}:${targetPortFor(listenPort, primary.nOffset)}`;

      console.log(
        `[TCP] Recv [${listenPort}] ${peer} (${merged.length} bytes) hex: ${chunkToLogHex(merged)} [${kstNowString()}]`
      );

      for (const t of targetHosts) {
        const hostPort = targetPortFor(listenPort, t.nOffset);
        const sIP = t.sIP;
        const target = ensureUpstream(sIP, hostPort);
        if (!target || target.destroyed || !target.writable) {
          console.log(
            `[${kstNowString()}] [${listenPort}] ${peer} drop (upstream unavailable) ${sIP}:${hostPort}`
          );
          continue;
        }
        try {
          const ok = target.write(merged, (err) => {
            if (err) {
              // 전송 에러
              console.error(
                `[${kstNowString()}] [${listenPort}] ${peer} write error ${sIP}:${hostPort} ->`,
                err?.message ?? err
              );

              sendTelegramMessage(
                `[${kstNowString()}] [${listenPort}] ${peer} write error ${sIP}:${hostPort} ->`,
                err?.message ?? err
              );
            } else {
              // 전송 에러가 아니면
              // DB에 로그 기록
              insertTcpProxyLog({
                sType: 'TCP',
                sIp: clientSocket.remoteAddress ?? '',
                sPort: listenPort ?? NaN,
                chunk: merged,
                tIp: sIP,
                tPort: hostPort
              });
              console.log(
                `[TCP] Send [${sIP}:${hostPort} (${merged.length} bytes) hex: ${chunkToLogHex(merged)} [${kstNowString()}]`
              );
            }
          });
          if (!ok) {
            clientSocket.pause();
            target.once('drain', () => {
              if (!clientSocket.destroyed) clientSocket.resume();
            });
          }
        } catch (err) {
          console.error(
            `[${kstNowString()}] [${listenPort}] ${peer} write threw ${sIP}:${hostPort} ->`,
            err?.message ?? err
          );
        }
      }

    };


    const flushCoalesced = () => {
      coalesceTimer = null;
      flushSend().catch((err) => {
        console.error(
          `[${kstNowString()}] [${listenPort}] ${peer} flushSend failed ->`,
          err?.message ?? err
        );
      });
    };

    const cleanup = () => {
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      void (async () => {
        try {
          await flushSend();
        } catch (err) {
          console.error(
            `[${kstNowString()}] [${listenPort}] ${peer} flushSend (cleanup) ->`,
            err?.message ?? err
          );
        } finally {
          if (!clientSocket.destroyed) clientSocket.destroy();
          for (const sock of upstreams.values()) {
            if (!sock.destroyed) sock.destroy();
          }
          upstreams.clear();
        }
      })();
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
        `Listening :${port} (targets from tb_tcp_host_info on each receive) [${started}/${total}]`
      );
    });
    servers.push(srv);
  }

  console.log(
    `TCP proxy ready: ${LISTEN_START}..${LISTEN_END} (tb_tcp_host_info loaded per client receive batch)`
  );
  return servers;
}

module.exports = { startTcpProxy, createProxyServer };
