'use strict';

const tcpLogQueue = [];
const httpLogQueue = [];
let LogWriting = false;


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


async function writeTcpLogQueue() {
  if (LogWriting) return;
  LogWriting = true;
  try {
    while (tcpLogQueue.length > 0) {
      const batch = tcpLogQueue.splice(0, LOG_BATCH_SIZE);
      const values = batch.map((r) => [r.sType, r.sIp, r.sPort, r.data, r.tIp, r.tPort]);
      await mysqlPool.query(
        'INSERT INTO tb_tcp_proxy_log (sType, sIP, sPort, Data, tIP, tPort) VALUES ?',
        [values]
      );
    }
  } catch (err) {
    console.error('tb_tcp_proxy_log insert failed:', err?.message ?? err);
  } finally {
    LogWriting = false;
  }
}

function insertTcpProxyLog({ sType, sIp, sPort, chunk, tIp, tPort }) {
  if (!sIp || !Number.isFinite(sPort)) return;
  if (!tIp || !Number.isFinite(tPort)) return;

  if (tcpLogQueue.length >= LOG_MAX_QUEUE) {
    tcpLogQueue.shift();
  }

  tcpLogQueue.push({
    sType,
    sIp,
    sPort: Number(sPort),
    data: encodeLogData(chunk),
    tIp,
    tPort: Number(tPort)
  });

  if (!LogWriting) {
    setImmediate(() => {
      writeTcpLogQueue().catch((e) => console.error('tb_tcp_proxy_log drain error:', e?.message ?? e));
    });
  }
}


async function writeHttpLogQueue() {
  if (LogWriting) return;
  LogWriting = true;
  try {
    while (httpLogQueue.length > 0) {
      const batch = httpLogQueue.splice(0, LOG_BATCH_SIZE);
      const values = batch.map((r) => [r.sIp, r.sPort, r.raw, r.timestamp, r.deive, r.action, r.tIp, r.tPort]);
      await mysqlPool.query(
        'INSERT INTO tb_http_proxy_log (sIp, sPort, raw, timestamp, device, action, tIp, tPort) VALUES ?',
        [values]
      );
    }
  } catch (err) {
    console.error('tb_http_proxy_log insert failed:', err?.message ?? err);
  } finally {
    LogWriting = false;
  }
}

function insertHttpProxyLog({ sIp, sPort, raw, timestamp, deive, action, tIp, tPort }) {
  if (!sIp || !Number.isFinite(sPort)) return;
  if (!tIp || !Number.isFinite(tPort)) return;

  if (httpLogQueue.length >= LOG_MAX_QUEUE) {
    httpLogQueue.shift();
  }

  httpLogQueue.push({

    sIp, 
    sPort: Number(sPort),
    raw, 
    timestamp, 
    deive, 
    action, 
    tIp,
    tPort: Number(tPort),
  });

  if (!LogWriting) {
    setImmediate(() => {
      writeHttpLogQueue().catch((e) => console.error('tb_http_proxy_log write error:', e?.message ?? e));
    });
  }
}

module.exports = {
  insertTcpProxyLog,
  insertHttpProxyLog,
  getPool: () => mysqlPool
};
