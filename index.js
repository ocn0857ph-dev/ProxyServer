'use strict';

require('dotenv').config();

const { startTcpProxy } = require('./tcp.js');
const { startHttpServer } = require('./http.js');

startTcpProxy();
startHttpServer().catch((err) => {
  console.error('startHttpServer failed:', err?.message ?? err);
  process.exit(1);
});
