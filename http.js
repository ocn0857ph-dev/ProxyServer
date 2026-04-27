'use strict';

const http = require('http');
const { insertHttpProxyLog, fetchHttpTargetHosts } = require('./sql.js');
const { sendTelegramMessage } = require('./telegram.js');

const HTTP_LISTEN_PORT = Number(process.env.HTTP_LISTEN_PORT ?? 8001);
const BODY_MAX_BYTES = Number(process.env.HTTP_BODY_MAX_BYTES ?? 1048576);

if (!Number.isFinite(HTTP_LISTEN_PORT) || HTTP_LISTEN_PORT < 1 || HTTP_LISTEN_PORT > 65535) {
  throw new Error('Invalid HTTP_LISTEN_PORT');
}
if (!Number.isFinite(BODY_MAX_BYTES) || BODY_MAX_BYTES < 1) {
  throw new Error('Invalid HTTP_BODY_MAX_BYTES');
}

function targetPortFor(listenPort, nOffset) {
  return listenPort + nOffset;
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

async function startHttpServer() {
  const hostsAtStart = await fetchHttpTargetHosts();
  if (hostsAtStart.length < 1) {
    throw new Error('tb_http_host_info must have at least one valid row (sIP, nOffset)');
  }

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

    let targetHosts;
    try {
      targetHosts = await fetchHttpTargetHosts();
    } catch (err) {
      console.error('[HTTP] fetchHttpTargetHosts on receive ->', err?.message ?? err);
      return;
    }
    if (targetHosts.length < 1) {
      console.error('[HTTP] tb_http_host_info has no valid rows, skip forward');
      return;
    }

    for (const t of targetHosts) {
      const port = targetPortFor(HTTP_LISTEN_PORT, t.nOffset);
      const host = t.sIP;
      forwardJson(host, port, bodyBuf, meta).catch((err) => {
        console.error(`[HTTP] forward error ${host}:${port} ->`, err?.message ?? err);

        sendTelegramMessage(`[HTTP] forward error ${host}:${port} -> ${err?.message ?? err}`).catch(
          (e) => console.error('[Telegram]', e?.message ?? e)
        );
      });
    }
  });

  server.on('error', (err) => {
    console.error('[HTTP] server error:', err?.message ?? err);
  });

  server.listen(HTTP_LISTEN_PORT, () => {
    const summary = hostsAtStart
      .map((h) => `${h.sIP}:${targetPortFor(HTTP_LISTEN_PORT, h.nOffset)}`)
      .join(', ');
    console.log(`HTTP listening :${HTTP_LISTEN_PORT} -> ${summary} (tb_http_host_info; refreshed each request)`);
  });

  return server;
}

module.exports = { startHttpServer };
