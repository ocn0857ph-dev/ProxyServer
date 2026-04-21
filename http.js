'use strict';

const http = require('http');
const { insertHttpProxyLog } = require('./sql.js');
const { sendTelegramMessage } = require('./telegram.js');

const HTTP_LISTEN_PORT = Number(process.env.HTTP_LISTEN_PORT ?? 8100);
const TARGET_HOSTS = (process.env.HTTP_TARGET_HOST ?? '127.0.0.1')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const TARGET_PORT_OFFSET = Number(process.env.HTTP_TARGET_PORT_OFFSET ?? 0);
const BODY_MAX_BYTES = Number(process.env.HTTP_BODY_MAX_BYTES ?? 1048576);

if (!Number.isFinite(HTTP_LISTEN_PORT) || HTTP_LISTEN_PORT < 1 || HTTP_LISTEN_PORT > 65535) {
  throw new Error('Invalid HTTP_LISTEN_PORT');
}
if (!Number.isFinite(TARGET_PORT_OFFSET)) {
  throw new Error('Invalid HTTP_TARGET_PORT_OFFSET');
}
if (TARGET_HOSTS.length < 1) {
  throw new Error('HTTP_TARGET_HOST must contain at least one host (comma separated)');
}
if (!Number.isFinite(BODY_MAX_BYTES) || BODY_MAX_BYTES < 1) {
  throw new Error('Invalid HTTP_BODY_MAX_BYTES');
}

function targetPortFor(listenPort) {
  return listenPort + TARGET_PORT_OFFSET;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forwardJson(host, port, bodyBuf, meta) {
  return new Promise((resolve, reject) => {


    const req = http.request(
      {
        hostname: host,
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length
        },
        timeout: 60000
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          // DB Log
          if (meta) {
            insertHttpProxyLog({
              sIp: meta.sIp,
              sPort: meta.sPort,
              raw: meta.raw,
              timestamp: meta.timestamp,
              deive: meta.device,
              action: meta.action,
              tIp: host,
              tPort: port
            });
          }
          resolve();
        });

      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.write(bodyBuf);
    req.end();
  });
}

function startHttpServer() {
  const targetPort = targetPortFor(HTTP_LISTEN_PORT);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    let bodyBuf;
    try {
      bodyBuf = await readRequestBody(req, BODY_MAX_BYTES);
    } catch (err) {
      const status = err?.message === 'Payload too large' ? 413 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message ?? 'Bad Request' }));
      return;
    }

    let payload;
    try {
      const text = bodyBuf.length ? bodyBuf.toString('utf8') : '{}';
      payload = JSON.parse(text);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    console.log(JSON.stringify(payload, null, 2));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    
    const meta = {
      sIp: req.socket.remoteAddress ?? '',
      sPort: Number(HTTP_LISTEN_PORT ?? NaN),
      timestamp: payload?.data?.timestamp ?? '',
      device: payload?.data?.device ?? '',
      raw: payload?.data?.raw ?? '',
      action: payload?.data?.action ?? ''
    };

    for (const host of TARGET_HOSTS) {
      forwardJson(host, targetPort, bodyBuf, meta).catch((err) => {
        console.error(`[HTTP] forward error ${host}:${targetPort} ->`, err?.message ?? err);

        sendTelegramMessage(`[HTTP] forward error ${host}:${targetPort} -> ${err?.message ?? err}`).catch(
          (e) => console.error('[Telegram]', e?.message ?? e)
        );
      });
    }
  });

  server.on('error', (err) => {
    console.error('[HTTP] server error:', err?.message ?? err);
  });

  server.listen(HTTP_LISTEN_PORT, () => {
    console.log(
      `HTTP listening :${HTTP_LISTEN_PORT} -> ${TARGET_HOSTS.map((h) => `${h}:${targetPort}`).join(', ')} (offset ${TARGET_PORT_OFFSET})`
    );
  });

  return server;
}

module.exports = { startHttpServer };
