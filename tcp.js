'use strict';

const net = require('net');
const { enqueueProxyLog } = require('./sql.js');

const LISTEN_START = Number(process.env.LISTEN_START ?? 8100);
const LISTEN_END = Number(process.env.LISTEN_END ?? 8200);
const TARGET_HOST = process.env.TARGET_HOST ?? '127.0.0.1';
const TARGET_PORT_OFFSET = Number(process.env.TARGET_PORT_OFFSET ?? 0);

const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS ?? 200);
const RECONNECT_MAX_BACKOFF_MS = Number(process.env.RECONNECT_MAX_BACKOFF_MS ?? 5000);
const MAX_RECONNECT_RETRIES = Number(process.env.MAX_RECONNECT_RETRIES ?? -1);
const TARGET_RECONNECT_DEBOUNCE_MS = Number(process.env.TARGET_RECONNECT_DEBOUNCE_MS ?? 50);

if (!Number.isFinite(LISTEN_START) || !Number.isFinite(LISTEN_END)) {
  throw new Error('Invalid LISTEN_START/LISTEN_END');
}
if (!Number.isFinite(TARGET_PORT_OFFSET)) {
  throw new Error('Invalid TARGET_PORT_OFFSET');
}
if (!Number.isFinite(RECONNECT_BASE_MS) || RECONNECT_BASE_MS < 0) {
  throw new Error('Invalid RECONNECT_BASE_MS');
}
if (!Number.isFinite(RECONNECT_MAX_BACKOFF_MS) || RECONNECT_MAX_BACKOFF_MS < 0) {
  throw new Error('Invalid RECONNECT_MAX_BACKOFF_MS');
}
if (!Number.isFinite(TARGET_RECONNECT_DEBOUNCE_MS) || TARGET_RECONNECT_DEBOUNCE_MS < 0) {
  throw new Error('Invalid TARGET_RECONNECT_DEBOUNCE_MS');
}

function safeDestroy(socket) {
  if (!socket) return;
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

function forwardTarget(listenPort) {
  return `${TARGET_HOST}:${listenPort + TARGET_PORT_OFFSET}`;
}

function createTcpProxyServer(listenPort) {
  const targetPort = listenPort + TARGET_PORT_OFFSET;
  const targetLabel = forwardTarget(listenPort);

  const server = net.createServer((clientSocket) => {
    const clientAddr = `${clientSocket.remoteAddress ?? '-'}:${clientSocket.remotePort ?? '-'}`;
    const tag = `[${listenPort}] ${clientAddr}`;
    const clientIp = clientSocket.remoteAddress ?? '';
    const clientRemotePort = clientSocket.remotePort ?? NaN;

    let closed = false;
    let targetSocket = null;
    let reconnectTimer = null;
    let reconnectRetries = 0;
    let lastTargetCloseAt = 0;
    let onClientData = null;

    const stopReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const closeAll = () => {
      if (closed) return;
      closed = true;
      stopReconnectTimer();
      if (onClientData) {
        clientSocket.removeListener('data', onClientData);
      }
      safeDestroy(targetSocket);
      clientSocket.destroy();
    };

    const scheduleReconnect = () => {
      if (closed) return;
      if (reconnectTimer) return;
      if (MAX_RECONNECT_RETRIES >= 0 && reconnectRetries > MAX_RECONNECT_RETRIES) {
        console.error(
          `${tag} -> target ${targetLabel} reconnect failed: exceeded ${MAX_RECONNECT_RETRIES} retries`
        );
        closeAll();
        return;
      }

      const debounceDelay = Math.max(0, TARGET_RECONNECT_DEBOUNCE_MS - (Date.now() - lastTargetCloseAt));
      const backoff = Math.min(
        RECONNECT_MAX_BACKOFF_MS,
        RECONNECT_BASE_MS * Math.pow(2, reconnectRetries)
      );
      const delay = debounceDelay + backoff;

      reconnectRetries += 1;
      console.log(
        `${tag} reconnecting -> ${targetLabel} (attempt ${reconnectRetries}, delay ${delay}ms)`
      );

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectTarget();
      }, delay);
    };

    const cleanupPipesForTarget = (socketToUnpipe) => {
      try {
        if (socketToUnpipe) {
          clientSocket.unpipe(socketToUnpipe);
          socketToUnpipe.unpipe(clientSocket);
        } else {
          clientSocket.unpipe();
        }
      } catch {
        // ignore
      }
    };

    const connectTarget = () => {
      if (closed) return;
      stopReconnectTimer();

      clientSocket.pause();
      cleanupPipesForTarget(targetSocket);
      safeDestroy(targetSocket);

      const currentTarget = net.createConnection({ host: TARGET_HOST, port: targetPort });
      targetSocket = currentTarget;

      currentTarget.on('error', (err) => {
        if (closed || targetSocket !== currentTarget) return;
        console.error(`${tag} -> target ${targetLabel} error:`, err?.message ?? err);
      });

      currentTarget.on('close', () => {
        if (closed || targetSocket !== currentTarget) return;
        lastTargetCloseAt = Date.now();
        scheduleReconnect();
      });

      currentTarget.once('connect', () => {
        reconnectRetries = 0;
        clientSocket.resume();
        clientSocket.pipe(currentTarget, { end: false });
        currentTarget.pipe(clientSocket, { end: false });
      });
    };

    clientSocket.on('error', closeAll);
    clientSocket.on('close', () => closeAll());

    onClientData = (chunk) => {
      if (closed) return;
      enqueueProxyLog({ ip: clientIp, port: clientRemotePort, chunk });
    };
    clientSocket.on('data', onClientData);

    clientSocket.on('end', () => {
      stopReconnectTimer();
      try {
        if (targetSocket) targetSocket.end();
      } catch {
        // ignore
      }
      clientSocket.destroy();
    });

    console.log(`[${new Date().toLocaleString('ko-KR')}] ${tag} -> ${targetLabel}`);
    connectTarget();
  });

  server.on('error', (err) => {
    console.error(`[${listenPort}] server error:`, err?.message ?? err);
  });

  return server;
}

async function startTcpProxy() {
  if (LISTEN_START > LISTEN_END) {
    throw new Error('LISTEN_START must be <= LISTEN_END');
  }

  const servers = [];
  let started = 0;
  const total = LISTEN_END - LISTEN_START + 1;

  for (let port = LISTEN_START; port <= LISTEN_END; port++) {
    const server = createTcpProxyServer(port);
    server.listen(port, () => {
      started += 1;
      console.log(`Listening on :${port} (forward -> ${forwardTarget(port)}) [${started}/${total}]`);
    });
    servers.push(server);
  }

  console.log(
    `TCP proxy range ready: ${LISTEN_START}..${LISTEN_END} -> ${forwardTarget(LISTEN_START)}..${forwardTarget(LISTEN_END)}`
  );

  return servers;
}

module.exports = {
  createTcpProxyServer,
  startTcpProxy
};
