'use strict';

require('dotenv').config();

const { startTcpProxy } = require('./tcp.js');

startTcpProxy();
