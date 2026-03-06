'use strict';

// Load .env from ~/.iflow-relay/.env
const fs = require('fs');
const path = require('path');
const os = require('os');

const ENV_FILE = path.join(os.homedir(), '.iflow-relay', '.env');

// 确保配置目录存在
const ENV_DIR = path.dirname(ENV_FILE);
if (!fs.existsSync(ENV_DIR)) {
  fs.mkdirSync(ENV_DIR, { recursive: true });
}

if (fs.existsSync(ENV_FILE)) {
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

const http = require('http');
const { load } = require('./src/config.js');
const { createHandler } = require('./src/server.js');

const cfg = load();
const handler = createHandler(cfg);
const server = http.createServer(handler);

server.listen(cfg.port, () => {
  console.log(`iflow-relay started on :${cfg.port}`);
  console.log(`upstreams=${cfg.upstreams.length} models=${cfg.models.join(',')}`);
});

function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
