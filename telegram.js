'use strict';

const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

/**
 * @param {string} text
 * @param {{ parse_mode?: string, disable_web_page_preview?: boolean }} [opts]
 * @returns {Promise<object>} Telegram API result (parsed JSON)
 */
function sendTelegramMessage(text, opts = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return Promise.reject(new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not set'));
  }

  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: String(text),
    ...opts
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            reject(new Error(`Telegram response not JSON: ${raw.slice(0, 200)}`));
            return;
          }
          if (!parsed.ok) {
            reject(new Error(parsed.description ?? 'Telegram sendMessage failed'));
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('Telegram request timeout'));
    });
    req.write(body);
    req.end();
  });
}

module.exports = {
  sendTelegramMessage
};
