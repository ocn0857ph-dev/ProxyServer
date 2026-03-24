'use strict';

const DB_HOST = process.env.DB_HOST ?? '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT ?? 3306);
const DB_USER = process.env.DB_USER ?? 'proxy';
const DB_PASSWORD = process.env.DB_PASSWORD ?? 'proxy!@12';
const DB_DATABASE = process.env.DB_DATABASE;
const DB_CONNECTION_LIMIT = Number(process.env.DB_CONNECTION_LIMIT ?? 5);

const LOG_DATA_ENCODING = process.env.LOG_DATA_ENCODING ?? 'base64';
const LOG_MAX_QUEUE = Number(process.env.LOG_MAX_QUEUE ?? 5000);
const LOG_BATCH_SIZE = Number(process.env.LOG_BATCH_SIZE ?? 200);
const LOG_TRUNCATE_BYTES = Number(process.env.LOG_TRUNCATE_BYTES ?? 0);

assertFinitePositive('DB_PORT', DB_PORT);
assertFinitePositive('DB_CONNECTION_LIMIT', DB_CONNECTION_LIMIT);
assertFinitePositive('LOG_MAX_QUEUE', LOG_MAX_QUEUE);
assertFinitePositive('LOG_BATCH_SIZE', LOG_BATCH_SIZE);
assertFiniteNonNegative('LOG_TRUNCATE_BYTES', LOG_TRUNCATE_BYTES);


const mysql = require('mysql2/promise');

function assertFinitePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}`);
  }
}

function assertFiniteNonNegative(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }
}



const poolConfig = {
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  connectionLimit: DB_CONNECTION_LIMIT,
  waitForConnections: true,
  queueLimit: 0
};
if (DB_DATABASE) poolConfig.database = DB_DATABASE;

const mysqlPool = mysql.createPool(poolConfig);

function encodeLogData(chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const limited =
    LOG_TRUNCATE_BYTES > 0 && buf.length > LOG_TRUNCATE_BYTES
      ? buf.subarray(0, LOG_TRUNCATE_BYTES)
      : buf;

  switch (LOG_DATA_ENCODING) {
    case 'hex':
      return limited.toString('hex');
    case 'utf8':
      return limited.toString('utf8');
    case 'base64':
    default:
      return limited.toString('base64');
  }
}

const logQueue = [];
let logDraining = false;

async function drainLogQueue() {
  if (logDraining) return;
  logDraining = true;
  try {
    while (logQueue.length > 0) {
      const batch = logQueue.splice(0, LOG_BATCH_SIZE);
      const values = batch.map((r) => [r.ip, r.port, r.data]);
      await mysqlPool.query('INSERT INTO tb_proxy_log (sIP, nPort, Data) VALUES ?', [values]);
    }
  } catch (err) {
    console.error('tb_proxy_log insert failed:', err?.message ?? err);
  } finally {
    logDraining = false;
  }
}

function enqueueProxyLog({ ip, port, chunk }) {
  if (!ip || !Number.isFinite(port)) return;

  if (logQueue.length >= LOG_MAX_QUEUE) {
    logQueue.shift();
  }

  logQueue.push({
    ip,
    port: Number(port),
    data: encodeLogData(chunk)
  });

  if (!logDraining) {
    setImmediate(() => {
      drainLogQueue().catch((e) => console.error('tb_proxy_log drain error:', e?.message ?? e));
    });
  }
}

module.exports = {
  enqueueProxyLog,
  getPool: () => mysqlPool
};
