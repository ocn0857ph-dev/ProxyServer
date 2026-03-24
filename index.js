'use strict';

require('dotenv').config();

const { startTcpProxy } = require('./tcp.js');

startTcpProxy().catch((err) => {
  console.error('Startup failed:', err?.message ?? err);
  process.exit(1);
});
