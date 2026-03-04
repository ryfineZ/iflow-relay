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

// ─── Provider 命令 ──────────────────────────────────────────────────────────────

async function cmdProviderList(args) {
  const config = loadConfig();

  if (config.upstreams.length === 0) {
    console.log('No providers configured.');
    console.log('\nTo add a provider:');
    console.log('  iflow-relay provider add <url> <key> [--sign]');
    return;
  }

  console.log(`Configured providers (${config.upstreams.length}):\n`);

  config.upstreams.forEach((u, i) => {
    const name = u.url.includes('iflow') ? 'iFlow' : `provider-${i + 1}`;
    const sign = u.sign ? 'yes' : 'no';
    console.log(`  [${i + 1}] ${name}`);
    console.log(`      URL: ${u.url}`);
    console.log(`      Key: ${u.key.substring(0, 10)}...${u.key.substring(u.key.length - 4)}`);
    console.log(`      Sign: ${sign}`);
    console.log('');
  });
}

async function cmdProviderAdd(args) {
  if (args.length < 2) {
    console.error('Error: URL and API key required.');
    console.error('Usage: iflow-relay provider add <url> <key> [--sign]');
    console.error('');
    console.error('Options:');
    console.error('  --sign    Enable request signing (for iFlow API)');
    console.error('');
    console.error('Examples:');
    console.error('  iflow-relay provider add https://apis.iflow.cn/v1 sk-xxx --sign');
    console.error('  iflow-relay provider add https://api.openai.com/v1 sk-yyy');
    process.exit(1);
  }

  let url = args[0];
  const key = args[1];
  const enableSign = args.includes('--sign');

  // 移除末尾斜杠
  url = url.replace(/\/$/, '');

  // 验证 URL
  try {
    new URL(url);
  } catch (e) {
    console.error(`Error: Invalid URL: ${url}`);
    process.exit(1);
  }

  // 验证 key
  if (!key || key.length < 10) {
    console.error('Error: API key seems too short');
    process.exit(1);
  }

  const envPath = path.join(process.cwd(), '.env');

  // 读取现有 .env
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  // 找到下一个可用的 provider 编号
  const lines = content.split('\n');
  let maxNum = 0;
  lines.forEach(line => {
    const match = line.match(/^UPSTREAM_(\d+)_URL=/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  });

  const nextNum = maxNum + 1;

  // 添加新 provider
  const newLines = [
    '',
    `# Provider ${nextNum} (added ${new Date().toISOString().split('T')[0]})`,
    `UPSTREAM_${nextNum}_URL=${url}`,
    `UPSTREAM_${nextNum}_KEY=${key}`,
    `UPSTREAM_${nextNum}_SIGN=${enableSign}`,
  ];

  fs.writeFileSync(envPath, content + newLines.join('\n'), 'utf-8');

  console.log(`Provider ${nextNum} added:`);
  console.log(`  URL: ${url}`);
  console.log(`  Key: ${key.substring(0, 10)}...${key.substring(key.length - 4)}`);
  console.log(`  Sign: ${enableSign ? 'yes' : 'no'}`);
  console.log(`\nUpdated: ${envPath}`);
  console.log('Restart iflow-relay for changes to take effect.');
}

async function cmdProviderRemove(args) {
  const num = parseInt(args[0], 10);

  if (!num || num < 1) {
    console.error('Error: Provider number required.');
    console.error('Usage: iflow-relay provider remove <number>');
    console.error('');
    console.error('Use "iflow-relay provider list" to see provider numbers.');
    process.exit(1);
  }

  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    console.error('Error: .env file not found');
    process.exit(1);
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  // 查找要删除的 provider
  const urlPattern = new RegExp(`^UPSTREAM_${num}_URL=`);
  const keyPattern = new RegExp(`^UPSTREAM_${num}_KEY=`);
  const signPattern = new RegExp(`^UPSTREAM_${num}_SIGN=`);

  let found = false;
  const newLines = [];
  let skipComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 跳过相关注释
    if (line.match(new RegExp(`^# Provider ${num} `))) {
      skipComment = true;
      found = true;
      continue;
    }

    // 跳过相关配置行
    if (line.match(urlPattern) || line.match(keyPattern) || line.match(signPattern)) {
      found = true;
      continue;
    }

    // 跳过空行（在注释后）
    if (skipComment && line.trim() === '') {
      skipComment = false;
      continue;
    }

    skipComment = false;
    newLines.push(line);
  }

  if (!found) {
    console.error(`Error: Provider ${num} not found.`);
    console.error('Use "iflow-relay provider list" to see provider numbers.');
    process.exit(1);
  }

  fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');

  console.log(`Provider ${num} removed.`);
  console.log(`Updated: ${envPath}`);
  console.log('Restart iflow-relay for changes to take effect.');
}

async function cmdProviderTest(args) {
  const config = loadConfig();
  const num = parseInt(args[0], 10);

  if (!num || num < 1 || num > config.upstreams.length) {
    console.error('Error: Invalid provider number.');
    console.error('Use "iflow-relay provider list" to see provider numbers.');
    process.exit(1);
  }

  const upstream = config.upstreams[num - 1];
  const name = upstream.url.includes('iflow') ? 'iFlow' : `provider-${num}`;

  console.log(`Testing provider ${num} (${name})...`);
  console.log(`URL: ${upstream.url}`);

  try {
    const startTime = Date.now();
    const response = await httpRequest(`${upstream.url}/models`, {
      headers: {
        'authorization': `Bearer ${upstream.key}`,
        'user-agent': 'iFlow-Cli',
        'accept': '*/*',
      },
      timeout: 15000,
    });
    const latency = Date.now() - startTime;

    if (response.statusCode === 200) {
      const json = JSON.parse(response.data);
      const modelCount = json.data ? json.data.length : 0;
      console.log(`\n✅ Provider ${num} is working`);
      console.log(`   Latency: ${latency}ms`);
      console.log(`   Models: ${modelCount}`);
    } else {
      console.log(`\n❌ Provider ${num} returned status ${response.statusCode}`);
      console.log(`   Response: ${response.data.substring(0, 200)}`);
    }
  } catch (err) {
    console.log(`\n❌ Provider ${num} failed: ${err.message}`);
  }
}

// ─── 帮助信息 ──────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
iflow-relay CLI - Manage iflow-relay proxy

Usage:
  node cli.js <command> [args]

  # 或全局安装后:
  iflow-relay <command> [args]

Commands:
  models                    List all available models from upstreams
  model show                Show current model configuration
  model set <id>            Set default model
  provider list             List configured providers
  provider add <url> <key> [--sign]   Add a new provider
  provider remove <num>     Remove a provider
  provider test <num>       Test provider connection
  health                    Check service health status

Examples:
  node cli.js models
  node cli.js model set qwen3-max
  node cli.js provider list
  node cli.js provider add https://apis.iflow.cn/v1 sk-xxx --sign
  node cli.js provider add https://api.openai.com/v1 sk-yyy
  node cli.js provider remove 2
  node cli.js provider test 1
  node cli.js health

Global Install:
  npm link                  # 安装全局命令
  iflow-relay models        # 然后可以直接使用

Environment Variables:
  PORT                Server port (default: 8327)
  UPSTREAM_1_URL      Upstream API URL
  UPSTREAM_1_KEY      Upstream API key
  UPSTREAM_1_SIGN     Enable signing (true/false)
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
      const modelSubCmd = subArgs[0] || 'show';
      if (modelSubCmd === 'show') {
        await cmdModelShow(subArgs.slice(1));
      } else if (modelSubCmd === 'set') {
        await cmdModelSet(subArgs.slice(1));
      } else {
        console.error(`Unknown model subcommand: ${modelSubCmd}`);
        console.error('Use: model show | model set <id>');
        process.exit(1);
      }
      break;
    case 'provider':
      const providerSubCmd = subArgs[0] || 'list';
      if (providerSubCmd === 'list') {
        await cmdProviderList(subArgs.slice(1));
      } else if (providerSubCmd === 'add') {
        await cmdProviderAdd(subArgs.slice(1));
      } else if (providerSubCmd === 'remove') {
        await cmdProviderRemove(subArgs.slice(1));
      } else if (providerSubCmd === 'test') {
        await cmdProviderTest(subArgs.slice(1));
      } else {
        console.error(`Unknown provider subcommand: ${providerSubCmd}`);
        console.error('Use: provider list | provider add | provider remove | provider test');
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
