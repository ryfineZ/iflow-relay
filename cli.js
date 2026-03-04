#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ─── 配置加载 ────────────────────────────────────────────────────────────────

function getEnv(key, defaultValue) {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : defaultValue;
}

function getList(key, defaultValue) {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

function loadConfig() {
  const port = parseInt(getEnv('PORT', '8327'), 10);

  // 加载上游配置
  const upstreams = [];
  for (let i = 1; i <= 50; i++) {
    const url = getEnv(`UPSTREAM_${i}_URL`, '').replace(/\/$/, '');
    const key = getEnv(`UPSTREAM_${i}_KEY`, '');
    const sign = getEnv(`UPSTREAM_${i}_SIGN`, 'true').toLowerCase() !== 'false';
    if (!url && !key) break;
    if (!url) continue;
    if (!key) continue;
    upstreams.push({ url, key, sign });
  }

  // 从 ~/.iflow/settings.json 加载
  const settingsPath = path.join(os.homedir(), '.iflow', 'settings.json');
  let iflowKey = null;
  let iflowUrl = 'https://apis.iflow.cn/v1';
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      iflowKey = settings.apiKey || null;
      iflowUrl = (settings.baseUrl || iflowUrl).replace(/\/$/, '');
    }
  } catch (_) {}

  // 如果没有配置上游，使用 iFlow CLI 凭证
  if (upstreams.length === 0 && iflowKey) {
    upstreams.push({ url: iflowUrl, key: iflowKey, sign: true });
  }

  return {
    port,
    upstreams,
    defaultModel: getEnv('DEFAULT_MODEL', 'glm-5'),
    models: getList('IFLOW_MODELS', []),
  };
}

// ─── HTTP 请求 ────────────────────────────────────────────────────────────────

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: isHttps ? new https.Agent({ keepAlive: true, ALPNProtocols: ['http/1.1'] }) : undefined,
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, data, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.setTimeout(options.timeout || 10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ─── 命令实现 ──────────────────────────────────────────────────────────────────

async function cmdModels(args) {
  const config = loadConfig();

  if (config.upstreams.length === 0) {
    console.error('Error: No upstreams configured.');
    console.error('Set UPSTREAM_1_URL and UPSTREAM_1_KEY in .env or run iflow login');
    process.exit(1);
  }

  console.log('Fetching models from upstreams...\n');

  const allModels = [];
  const errors = [];

  for (let i = 0; i < config.upstreams.length; i++) {
    const upstream = config.upstreams[i];
    const upstreamName = upstream.url.includes('iflow') ? 'iFlow' : `upstream-${i + 1}`;

    try {
      const response = await httpRequest(`${upstream.url}/models`, {
        headers: {
          'authorization': `Bearer ${upstream.key}`,
          'user-agent': 'iFlow-Cli',
          'accept': '*/*',
        },
        timeout: 15000,
      });

      if (response.statusCode === 200) {
        const json = JSON.parse(response.data);
        if (json.data && Array.isArray(json.data)) {
          json.data.forEach(m => {
            allModels.push({
              id: m.id,
              owned_by: m.owned_by || 'unknown',
              upstream: upstreamName,
              upstream_url: upstream.url,
            });
          });
        }
      } else {
        errors.push({ upstream: upstreamName, status: response.statusCode });
      }
    } catch (err) {
      errors.push({ upstream: upstreamName, error: err.message });
    }
  }

  // 去重
  const seen = new Set();
  const uniqueModels = allModels.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // 显示模型列表
  if (uniqueModels.length === 0) {
    console.log('No models found.');
    if (errors.length > 0) {
      console.log('\nErrors:');
      errors.forEach(e => console.log(`  - ${e.upstream}: ${e.error || e.status}`));
    }
    return;
  }

  // 按上游分组显示
  const byUpstream = {};
  uniqueModels.forEach(m => {
    if (!byUpstream[m.upstream]) byUpstream[m.upstream] = [];
    byUpstream[m.upstream].push(m);
  });

  console.log(`Found ${uniqueModels.length} models:\n`);

  Object.entries(byUpstream).forEach(([upstream, models]) => {
    console.log(`[${upstream}] (${models.length} models)`);
    models.forEach(m => {
      const current = m.id === config.defaultModel ? ' (current)' : '';
      console.log(`  - ${m.id}${current}`);
    });
    console.log('');
  });

  if (errors.length > 0) {
    console.log('Errors:');
    errors.forEach(e => console.log(`  - ${e.upstream}: ${e.error || e.status}`));
  }
}

async function cmdModelShow(args) {
  const config = loadConfig();

  console.log('Current configuration:\n');
  console.log(`  Default model: ${config.defaultModel}`);
  console.log(`  Configured models: ${config.models.length > 0 ? config.models.join(', ') : '(none)'}`);
  console.log(`  Upstreams: ${config.upstreams.length}`);

  if (config.upstreams.length > 0) {
    console.log('\n  Upstream details:');
    config.upstreams.forEach((u, i) => {
      const name = u.url.includes('iflow') ? 'iFlow' : `upstream-${i + 1}`;
      console.log(`    [${i + 1}] ${name}`);
      console.log(`        URL: ${u.url}`);
      console.log(`        Key: ${u.key.substring(0, 10)}...`);
    });
  }
}

async function cmdModelSet(args) {
  const modelId = args[0];

  if (!modelId) {
    console.error('Error: Model ID required.');
    console.error('Usage: iflow-relay model set <model-id>');
    process.exit(1);
  }

  const envPath = path.join(process.cwd(), '.env');

  // 读取现有 .env
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  const lines = content.split('\n');
  let foundDefault = false;
  let foundModels = false;
  const newLines = lines.map(line => {
    if (line.startsWith('DEFAULT_MODEL=')) {
      foundDefault = true;
      return `DEFAULT_MODEL=${modelId}`;
    }
    if (line.startsWith('IFLOW_MODELS=')) {
      foundModels = true;
      // 更新模型列表
      return `IFLOW_MODELS=${modelId}`;
    }
    return line;
  });

  if (!foundDefault) {
    newLines.push(`DEFAULT_MODEL=${modelId}`);
  }
  if (!foundModels) {
    newLines.push(`IFLOW_MODELS=${modelId}`);
  }

  fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
  console.log(`Default model set to: ${modelId}`);
  console.log(`Updated: ${envPath}`);
  console.log('\nRestart iflow-relay for changes to take effect.');
}

async function cmdHealth(args) {
  const config = loadConfig();
  const baseUrl = `http://localhost:${config.port}`;

  try {
    // 基础健康检查
    const health = await httpRequest(`${baseUrl}/health`, { timeout: 5000 });
    console.log('Health:', health.data);

    // ACP 状态检查
    try {
      const acpHealth = await httpRequest(`${baseUrl}/health/acp`, { timeout: 5000 });
      const acp = JSON.parse(acpHealth.data);
      console.log('\nACP Status:');
      console.log(`  Enabled: ${acp.acp.enabled}`);
      console.log(`  Available: ${acp.acp.available}`);
      console.log(`  Connected: ${acp.acp.connected}`);
      console.log(`  Port: ${acp.acp.port}`);
    } catch (e) {
      console.log('\nACP Status: (service not running)');
    }
  } catch (err) {
    console.error('Error: Cannot connect to iflow-relay');
    console.error(`Make sure it's running on port ${config.port}`);
    console.error(`  npm start`);
    process.exit(1);
  }
}

// ─── 帮助信息 ──────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
iflow-relay CLI - Manage iflow-relay proxy

Usage:
  iflow-relay <command> [args]

Commands:
  models              List all available models from upstreams
  model show          Show current model configuration
  model set <id>      Set default model
  health              Check service health status

Examples:
  iflow-relay models
  iflow-relay model set qwen3-max
  iflow-relay health

Environment Variables:
  PORT                Server port (default: 8327)
  UPSTREAM_1_URL      Upstream API URL
  UPSTREAM_1_KEY      Upstream API key
  DEFAULT_MODEL       Default model ID
  ACP_ENABLED         Enable ACP mode (true/false)
  ACP_PORT            ACP server port (default: 8090)
`);
}

// ─── 主入口 ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const subArgs = args.slice(1);

  switch (command) {
    case 'models':
      await cmdModels(subArgs);
      break;
    case 'model':
      const subCmd = subArgs[0] || 'show';
      if (subCmd === 'show') {
        await cmdModelShow(subArgs.slice(1));
      } else if (subCmd === 'set') {
        await cmdModelSet(subArgs.slice(1));
      } else {
        console.error(`Unknown model subcommand: ${subCmd}`);
        console.error('Use: model show | model set <id>');
        process.exit(1);
      }
      break;
    case 'health':
      await cmdHealth(subArgs);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
