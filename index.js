'use strict';

require('dotenv').config();

const { startTcpProxy } = require('./tcp.js');
const { startHttpServer } = require('./http.js');

startTcpProxy();
startHttpServer();
