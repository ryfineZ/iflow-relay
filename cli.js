#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// 配置文件路径：固定为 ~/.aigw/.env
const ENV_FILE = path.join(os.homedir(), '.aigw', '.env');

// 确保配置目录存在
const ENV_DIR = path.dirname(ENV_FILE);
if (!fs.existsSync(ENV_DIR)) {
  fs.mkdirSync(ENV_DIR, { recursive: true });
}

// 加载 .env 文件
if (fs.existsSync(ENV_FILE)) {
  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        // 只设置未定义的环境变量
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  });
}

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

// ─── iFlow 域名检测 ────────────────────────────────────────────────────────────

/**
 * 检测 URL 是否为 iFlow 官方域名
 */
function isIFlowDomain(url) {
  if (!url) return false;
  const IFLOW_DOMAINS = ['apis.iflow.cn', 'api.iflow.cn', 'iflow.cn'];
  return IFLOW_DOMAINS.some(d =>
    url.includes(`://${d}`) || url.includes(`://${d}:`) || url.includes(`.${d}`)
  );
}

/**
 * 从 URL 提取域名作为 Provider 名称
 */
function extractDomainName(url) {
  try {
    const parsed = new URL(url);
    // 移除端口号
    let hostname = parsed.hostname;
    // 提取主域名（如 aigw-gzgy2.cucloud.cn → cucloud）
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      // 取倒数第二部分作为名称
      return parts[parts.length - 2];
    }
    return hostname;
  } catch (e) {
    return 'provider';
  }
}

function loadConfig() {
  const port = parseInt(getEnv('PORT', '8327'), 10);

  // 加载上游配置
  const upstreams = [];
  for (let i = 1; i <= 50; i++) {
    const url = getEnv(`UPSTREAM_${i}_URL`, '').replace(/\/$/, '');
    const key = getEnv(`UPSTREAM_${i}_KEY`, '');
    const enabled = getEnv(`UPSTREAM_${i}_ENABLED`, 'true').toLowerCase() !== 'false';
    if (!url && !key) break;
    if (!url || !key) continue;
    // 根据域名判断是否为 iFlow
    const isIFlow = isIFlowDomain(url);
    const name = getEnv(`UPSTREAM_${i}_NAME`, '') || (isIFlow ? 'iFlow' : `provider-${i}`);
    const models = getList(`UPSTREAM_${i}_MODELS`, []);
    upstreams.push({ url, key, sign: isIFlow, name, models, enabled, index: i });
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
      reject(new Error('请求超时'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ─── 交互式输入 ──────────────────────────────────────────────────────────────

function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(rl, prompt, defaultValue = '') {
  return new Promise((resolve) => {
    const displayPrompt = defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `;
    rl.question(displayPrompt, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function questionYesNo(rl, prompt, defaultValue = 'n') {
  return new Promise((resolve) => {
    const hint = defaultValue === 'y' ? '[Y/n]' : '[y/N]';
    rl.question(`${prompt} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === 'y' || a === 'yes') resolve(true);
      else if (a === 'n' || a === 'no') resolve(false);
      else resolve(defaultValue === 'y');
    });
  });
}

function questionChoice(rl, prompt, choices) {
  return new Promise((resolve) => {
    console.log(prompt);
    choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    rl.question('请选择: ', (answer) => {
      const num = parseInt(answer.trim(), 10);
      if (num >= 1 && num <= choices.length) {
        resolve(num - 1);
      } else {
        resolve(-1);
      }
    });
  });
}

// ─── 验证函数 ────────────────────────────────────────────────────────────────

function validateUrl(url) {
  if (!url) return { valid: false, error: 'URL 不能为空' };

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'URL 必须以 http:// 或 https:// 开头' };
    }
    if (!parsed.hostname) {
      return { valid: false, error: 'URL 格式无效' };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'URL 格式无效: ' + e.message };
  }
}

function validateApiKey(key) {
  if (!key) return { valid: false, error: 'API Key 不能为空' };
  if (key.length < 10) return { valid: false, error: 'API Key 长度不足' };
  return { valid: true };
}

// ─── 测试 Provider ────────────────────────────────────────────────────────────

async function testProvider(url, key, fullModels = false) {
  const startTime = Date.now();
  const result = {
    success: false,
    latency: 0,
    modelCount: 0,
    models: [],
    allModels: [],
    statusCode: null,
    error: null,
    warning: null, // 警告信息（如模型列表不可用）
  };

  // 测试1: 尝试获取模型列表
  try {
    const modelsResponse = await httpRequest(`${url}/models`, {
      headers: {
        'authorization': `Bearer ${key}`,
        'user-agent': 'iFlow-Cli',
        'accept': '*/*',
      },
      timeout: 15000,
    });

    result.latency = Date.now() - startTime;
    result.statusCode = modelsResponse.statusCode;

    if (modelsResponse.statusCode === 200) {
      // 模型列表获取成功
      result.success = true;
      try {
        const json = JSON.parse(modelsResponse.data);
        if (json.data && Array.isArray(json.data)) {
          result.modelCount = json.data.length;
          result.allModels = json.data.map(m => m.id);
          result.models = fullModels ? result.allModels : result.allModels.slice(0, 5);
        }
      } catch (_) {}
      return result;
    }
  } catch (err) {
    // 模型列表请求失败，继续尝试连通性测试
  }

  // 测试2: 连通性测试 - 发送一个简单请求
  try {
    const testResponse = await httpRequest(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
        'user-agent': 'iFlow-Cli',
        'accept': '*/*',
      },
      body: JSON.stringify({
        model: 'glm-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      timeout: 15000,
    });

    result.latency = Date.now() - startTime;
    result.statusCode = testResponse.statusCode;

    // 401 认证失败
    if (testResponse.statusCode === 401) {
      result.error = '认证失败，请检查 API Key 是否正确';
      return result;
    }

    // 400/422 (模型不存在/参数错误) 说明连接成功、认证通过
    if (testResponse.statusCode === 400 || testResponse.statusCode === 422) {
      result.success = true;
      result.warning = '模型列表端点不可用，但服务连接正常。请手动配置模型名称。';

      // 尝试解析错误信息
      try {
        const json = JSON.parse(testResponse.data);
        if (json.error?.message) {
          result.warning += `\n服务返回: ${json.error.message}`;
        }
      } catch (_) {}

      return result;
    }

    // 其他错误状态码
    if (testResponse.statusCode >= 400) {
      try {
        const json = JSON.parse(testResponse.data);
        result.error = json.error?.message || json.message || `HTTP ${testResponse.statusCode}`;
      } catch (_) {
        result.error = `HTTP ${testResponse.statusCode}`;
      }
      return result;
    }

    // 200 成功
    result.success = true;
    return result;
  } catch (err) {
    result.latency = Date.now() - startTime;
    result.error = err.message;
    return result;
  }

  return result;
}

// ─── Provider 管理 ────────────────────────────────────────────────────────────

function getNextProviderNum() {
  const envPath = ENV_FILE;
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  // 找到所有已使用的编号
  const usedNums = new Set();
  content.split('\n').forEach(line => {
    const match = line.match(/^UPSTREAM_(\d+)_URL=/);
    if (match) {
      usedNums.add(parseInt(match[1], 10));
    }
  });

  // 找到第一个空缺的编号
  for (let i = 1; i <= 50; i++) {
    if (!usedNums.has(i)) {
      return i;
    }
  }

  return 1; // 默认返回1
}

/**
 * 更新 .env 文件中的一行配置
 * @param {string} key - 配置键名，如 UPSTREAM_1_NAME
 * @param {string} value - 配置值
 */
function updateEnvLine(key, value) {
  const envPath = ENV_FILE;
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  const lines = content.split('\n');
  let found = false;
  const newLines = lines.map(line => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
}

function addProviderToEnv(url, key, sign, name, models = null) {
  const envPath = ENV_FILE;
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  const num = getNextProviderNum();
  const providerName = name || (sign ? 'iFlow' : `provider-${num}`);

  let newContent = content +
    (content && !content.endsWith('\n') ? '\n' : '') +
    `\n# Provider ${num}: ${providerName} (added ${new Date().toISOString().split('T')[0]})\n` +
    `UPSTREAM_${num}_URL=${url}\n` +
    `UPSTREAM_${num}_KEY=${key}\n` +
    `UPSTREAM_${num}_SIGN=${sign}\n` +
    `UPSTREAM_${num}_NAME=${providerName}\n`;

  // 如果提供了模型列表，写入 UPSTREAM_X_MODELS
  if (models && models.length > 0) {
    const modelList = Array.isArray(models) ? models : [models];
    newContent += `UPSTREAM_${num}_MODELS=${modelList.join(',')}\n`;
    // 第一个模型作为默认模型
    if (!content.includes('DEFAULT_MODEL=')) {
      newContent += `DEFAULT_MODEL=${modelList[0]}\n`;
    }
  }

  fs.writeFileSync(envPath, newContent, 'utf-8');
  return { num, name: providerName, models };
}

function removeProviderFromEnv(num) {
  const envPath = ENV_FILE;
  if (!fs.existsSync(envPath)) return false;

  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  const urlPattern = new RegExp(`^UPSTREAM_${num}_URL=`);
  const keyPattern = new RegExp(`^UPSTREAM_${num}_KEY=`);
  const signPattern = new RegExp(`^UPSTREAM_${num}_SIGN=`);
  const namePattern = new RegExp(`^UPSTREAM_${num}_NAME=`);
  const modelsPattern = new RegExp(`^UPSTREAM_${num}_MODELS=`);

  let found = false;
  const newLines = [];
  let skipComment = false;

  for (const line of lines) {
    if (line.match(new RegExp(`^# Provider ${num} `))) {
      skipComment = true;
      found = true;
      continue;
    }
    if (line.match(urlPattern) || line.match(keyPattern) || line.match(signPattern) || line.match(namePattern) || line.match(modelsPattern)) {
      found = true;
      continue;
    }
    if (skipComment && line.trim() === '') {
      skipComment = false;
      continue;
    }
    skipComment = false;
    newLines.push(line);
  }

  if (found) {
    fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
  }
  return found;
}

// ─── 命令实现 ──────────────────────────────────────────────────────────────────

async function cmdModels() {
  const config = loadConfig();

  if (config.upstreams.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    console.log('运行 `aigw provider add` 添加 Provider');
    return;
  }

  console.log('正在获取模型列表...\n');

  for (const upstream of config.upstreams) {
    console.log(`[${upstream.name}] ${upstream.url}`);

    try {
      const result = await testProvider(upstream.url, upstream.key, true);
      if (result.success) {
        if (result.warning) {
          // API 无法获取模型，显示配置的模型列表
          console.log(`  ⚠️  连接成功 (${result.latency}ms)`);
          console.log(`  ${result.warning.split('\n').join('\n  ')}`);
          if (upstream.models && upstream.models.length > 0) {
            console.log(`  配置的模型 (${upstream.models.length} 个):\n`);
            upstream.models.forEach((model, i) => {
              console.log(`    ${i + 1}. ${model}  (${upstream.name}/${model})`);
            });
          } else {
            console.log(`  提示: 使用 aigw provider models 命令配置模型列表`);
          }
        } else {
          console.log(`  ✅ 连接成功 (${result.latency}ms, ${result.modelCount} 个模型)\n`);
          if (result.allModels.length > 0) {
            result.allModels.forEach((model, i) => {
              console.log(`    ${i + 1}. ${model}  (${upstream.name}/${model})`);
            });
          }
        }
      } else {
        console.log(`  ❌ 连接失败: ${result.error}`);
        // 显示配置的模型列表
        if (upstream.models && upstream.models.length > 0) {
          console.log(`  配置的模型 (${upstream.models.length} 个):`);
          upstream.models.forEach((model, i) => {
            console.log(`    ${i + 1}. ${model}  (${upstream.name}/${model})`);
          });
        }
      }
    } catch (err) {
      console.log(`  ❌ 连接失败: ${err.message}`);
      // 显示配置的模型列表
      if (upstream.models && upstream.models.length > 0) {
        console.log(`  配置的模型 (${upstream.models.length} 个):`);
        upstream.models.forEach((model, i) => {
          console.log(`    ${i + 1}. ${model}  (${upstream.name}/${model})`);
        });
      }
    }
    console.log('');
  }
}

async function cmdProviderList() {
  // 读取所有 Provider（包括停用的）
  const allProviders = [];
  const envPath = ENV_FILE;
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (let i = 1; i <= 50; i++) {
      const urlMatch = content.match(new RegExp(`^UPSTREAM_${i}_URL=(.+)$`, 'm'));
      if (urlMatch) {
        const url = urlMatch[1].trim().replace(/\/$/, '');
        const keyMatch = content.match(new RegExp(`^UPSTREAM_${i}_KEY=(.+)$`, 'm'));
        const key = keyMatch ? keyMatch[1].trim() : '';
        const nameMatch = content.match(new RegExp(`^UPSTREAM_${i}_NAME=(.+)$`, 'm'));
        const name = nameMatch ? nameMatch[1].trim() : (isIFlowDomain(url) ? 'iFlow' : `provider-${i}`);
        const signMatch = content.match(new RegExp(`^UPSTREAM_${i}_SIGN=(.+)$`, 'm'));
        const sign = signMatch ? signMatch[1].trim().toLowerCase() !== 'false' : isIFlowDomain(url);
        const enabledMatch = content.match(new RegExp(`^UPSTREAM_${i}_ENABLED=(.+)$`, 'm'));
        const enabled = enabledMatch ? enabledMatch[1].trim().toLowerCase() !== 'false' : true;
        allProviders.push({ index: i, name, url, key, sign, enabled });
      }
    }
  }

  if (allProviders.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    console.log('运行 `aigw provider add` 添加 Provider');
    return;
  }

  const enabledCount = allProviders.filter(p => p.enabled).length;
  const disabledCount = allProviders.length - enabledCount;

  console.log(`已配置 ${allProviders.length} 个 Provider (启用: ${enabledCount}, 停用: ${disabledCount}):\n`);

  for (const p of allProviders) {
    const status = p.enabled ? '✅' : '⛔';
    console.log(`[${p.index}] ${status} ${p.name}`);
    console.log(`    URL: ${p.url}`);
    if (p.key) {
      console.log(`    Key: ${p.key.substring(0, 10)}...${p.key.substring(p.key.length - 4)}`);
    }
    console.log(`    Sign: ${p.sign ? '是 (iFlow)' : '否'}`);
    if (!p.enabled) {
      console.log(`    状态: 已停用`);
    }
    console.log('');
  }
}

async function cmdProviderAdd() {
  const rl = createReadline();

  try {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║           添加新的 Provider                  ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    // 1. 输入 URL
    let url = '';
    while (true) {
      url = await question(rl, '请输入 API URL');
      const validation = validateUrl(url);
      if (validation.valid) {
        url = url.replace(/\/$/, ''); // 移除末尾斜杠
        // 自动补全 /v1 后缀
        if (!url.endsWith('/v1') && !url.endsWith('/v1/')) {
          // 检查是否已经有其他版本路径
          const hasVersionPath = /\/v\d+\/?$/.test(url);
          if (!hasVersionPath) {
            console.log('✓ 自动补全 /v1 后缀');
            url = url + '/v1';
          }
        }
        break;
      }
      console.log(`❌ ${validation.error}\n`);
    }

    // 判断是否是 iFlow
    const isIFlow = isIFlowDomain(url);
    if (isIFlow) {
      console.log('✓ 检测到 iFlow API，将自动启用签名\n');
    }

    // 2. 输入 API Key
    let key = '';
    while (true) {
      key = await question(rl, '请输入 API Key');
      const validation = validateApiKey(key);
      if (validation.valid) break;
      console.log(`❌ ${validation.error}\n`);
    }

    // 3. 测试连接
    console.log('\n正在测试连接...');
    const result = await testProvider(url, key);

    if (result.success) {
      let models = null;

      if (result.warning) {
        // 连接成功但模型列表不可用
        console.log(`\n⚠️  连接成功 (${result.latency}ms)`);
        console.log(`   ${result.warning.split('\n').join('\n   ')}`);
        console.log('');

        // 询问模型列表
        console.log('请输入该 Provider 支持的模型名称（逗号分隔，留空跳过）');
        const inputModels = await question(rl, '例如: qwen-coder-plus,qwen-max,deepseek-r1', '');
        if (inputModels.trim()) {
          models = inputModels.split(',').map(m => m.trim()).filter(m => m);
        }
      } else {
        // 完全成功
        console.log(`\n✅ 连接成功!`);
        console.log(`   延迟: ${result.latency}ms`);
        console.log(`   模型数量: ${result.modelCount}`);
        if (result.models.length > 0) {
          console.log(`   模型示例: ${result.models.join(', ')}`);
        }

        // 如果模型数量为0，提示输入
        if (result.modelCount === 0) {
          console.log('');
          console.log('⚠️  未能获取模型列表，请手动输入模型名称');
          console.log('请输入该 Provider 支持的模型名称（逗号分隔，留空跳过）');
          const inputModels = await question(rl, '例如: qwen-coder-plus,qwen-max,deepseek-r1', '');
          if (inputModels.trim()) {
            models = inputModels.split(',').map(m => m.trim()).filter(m => m);
          }
        }
      }

      // 询问是否保存
      const save = await questionYesNo(rl, '\n是否保存此 Provider?', 'y');
      if (save) {
        // 询问 Provider 名称（默认从 URL 域名提取）
        const defaultName = isIFlow ? 'iFlow' : extractDomainName(url);
        const inputName = await question(rl, 'Provider 名称', defaultName);
        const providerName = inputName.trim() || defaultName;

        const { num, name } = addProviderToEnv(url, key, isIFlow, providerName, models);
        console.log(`\n✅ Provider ${num} (${name}) 已保存到 .env`);
        if (models && models.length > 0) {
          console.log(`   模型列表: ${models.join(', ')}`);
          console.log(`   默认模型: ${models[0]}`);
        }

        // 尝试热重载
        await tryReload();

        console.log('提示: 如需更新调度权重，运行 aigw reload');
      } else {
        console.log('\n已取消保存');
      }
    } else {
      // 连接失败
      console.log(`\n❌ 连接失败`);
      console.log(`   状态码: ${result.statusCode || 'N/A'}`);
      console.log(`   错误: ${result.error}`);

      // 询问用户如何处理
      while (true) {
        console.log('\n请选择:');
        console.log('  1. 重新输入');
        console.log('  2. 仍然保存 (不推荐)');
        console.log('  3. 放弃');
        const choice = await question(rl, '请选择 (1-3)');

        if (choice === '1') {
          // 重新输入 - 递归调用
          rl.close();
          await cmdProviderAdd();
          return;
        } else if (choice === '2') {
          // 询问 Provider 名称（默认从 URL 域名提取）
          const defaultName = isIFlow ? 'iFlow' : extractDomainName(url);
          const inputName = await question(rl, 'Provider 名称', defaultName);
          const providerName = inputName.trim() || defaultName;

          const { num, name } = addProviderToEnv(url, key, isIFlow, providerName);
          console.log(`\n✅ Provider ${num} (${name}) 已保存到 .env (未验证)`);
          console.log('重启 aigw 使配置生效: npm start');
          break;
        } else if (choice === '3') {
          console.log('\n已取消');
          break;
        } else {
          console.log('无效选择，请输入 1-3');
        }
      }
    }
  } finally {
    rl.close();
  }
}

async function cmdProviderRemove() {
  const config = loadConfig();

  if (config.upstreams.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    return;
  }

  const rl = createReadline();

  try {
    console.log('已配置的 Provider:\n');
    config.upstreams.forEach((u, i) => {
      console.log(`  [${i + 1}] ${u.name} - ${u.url}`);
    });
    console.log('');

    const numStr = await question(rl, '请输入要删除的 Provider 编号');
    const num = parseInt(numStr, 10);

    if (isNaN(num) || num < 1 || num > config.upstreams.length) {
      console.log('❌ 无效的编号');
      return;
    }

    const upstream = config.upstreams[num - 1];
    const confirm = await questionYesNo(rl, `确认删除 Provider ${num} (${upstream.name})?`);

    if (confirm) {
      // 需要找到实际的 UPSTREAM_X 编号
      const envPath = ENV_FILE;
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const lines = content.split('\n');

        // 找到匹配的编号
        for (let i = 1; i <= 50; i++) {
          const urlLine = lines.find(l => l.startsWith(`UPSTREAM_${i}_URL=`));
          if (urlLine) {
            const envUrl = urlLine.split('=')[1].replace(/\/$/, '');
            if (envUrl === upstream.url) {
              removeProviderFromEnv(i);
              console.log(`\n✅ Provider ${num} (${upstream.name}) 已删除`);
              console.log('重启 aigw 使配置生效: npm start');
              return;
            }
          }
        }
      }
      console.log('❌ 删除失败: 找不到对应的配置');
    } else {
      console.log('已取消');
    }
  } finally {
    rl.close();
  }
}

async function cmdProviderTest() {
  const config = loadConfig();

  if (config.upstreams.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    return;
  }

  const rl = createReadline();

  try {
    console.log('已配置的 Provider:\n');
    config.upstreams.forEach((u, i) => {
      console.log(`  [${i + 1}] ${u.name} - ${u.url}`);
    });
    console.log('');

    const numStr = await question(rl, '请输入要测试的 Provider 编号 (直接回车测试全部)');
    const num = parseInt(numStr, 10);

    if (!isNaN(num) && num >= 1 && num <= config.upstreams.length) {
      // 测试单个
      const upstream = config.upstreams[num - 1];
      console.log(`\n测试 Provider ${num} (${upstream.name})...`);
      console.log(`URL: ${upstream.url}`);

      const result = await testProvider(upstream.url, upstream.key);

      if (result.success) {
        if (result.warning) {
          console.log(`\n⚠️  连接成功 (${result.latency}ms)`);
          console.log(`   ${result.warning.split('\n').join('\n   ')}`);
        } else {
          console.log(`\n✅ 连接成功`);
          console.log(`   延迟: ${result.latency}ms`);
          console.log(`   模型数量: ${result.modelCount}`);
          if (result.models.length > 0) {
            console.log(`   模型示例: ${result.models.join(', ')}`);
          }
        }
      } else {
        console.log(`\n❌ 连接失败`);
        console.log(`   状态码: ${result.statusCode || 'N/A'}`);
        console.log(`   错误: ${result.error}`);
      }
    } else {
      // 测试全部
      console.log('\n测试所有 Provider...\n');

      for (let i = 0; i < config.upstreams.length; i++) {
        const u = config.upstreams[i];
        console.log(`[${i + 1}] ${u.name}`);

        const result = await testProvider(u.url, u.key);

        if (result.success) {
          if (result.warning) {
            console.log(`    ⚠️  成功 (${result.latency}ms) - 模型列表不可用`);
          } else {
            console.log(`    ✅ 成功 (${result.latency}ms, ${result.modelCount} 个模型)`);
          }
        } else {
          console.log(`    ❌ 失败: ${result.error}`);
        }
        console.log('');
      }
    }
  } finally {
    rl.close();
  }
}

async function cmdProviderName() {
  const config = loadConfig();
  if (config.upstreams.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    console.log('运行 `aigw provider add` 添加 Provider');
    return;
  }

  const rl = createReadline();
  try {
    console.log('已配置的 Provider:\n');
    config.upstreams.forEach((u, i) => {
      const status = u.enabled ? '' : ' (已停用)';
      console.log(`  [${i + 1}] ${u.name} - ${u.url}${status}`);
    });

    const numStr = await question(rl, '\n请输入要修改的 Provider 编号');
    const num = parseInt(numStr, 10);
    if (isNaN(num) || num < 1 || num > config.upstreams.length) {
      console.log('❌ 无效的编号');
      return;
    }

    const newName = await question(rl, '请输入新名称', config.upstreams[num - 1].name);
    if (!newName.trim()) {
      console.log('❌ 名称不能为空');
      return;
    }

    // 更新 .env 添加 UPSTREAM_X_NAME
    const idx = config.upstreams[num - 1].index;
    updateEnvLine(`UPSTREAM_${idx}_NAME`, newName.trim());
    console.log(`\n✅ Provider ${num} 名称已设置为: ${newName.trim()}`);
    console.log('重启 aigw 使配置生效: npm start');
  } finally {
    rl.close();
  }
}

async function cmdProviderDisable() {
  const config = loadConfig();
  if (config.upstreams.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    console.log('运行 `aigw provider add` 添加 Provider');
    return;
  }

  const rl = createReadline();
  try {
    console.log('已配置的 Provider:\n');
    config.upstreams.forEach((u, i) => {
      const status = u.enabled ? '' : ' (已停用)';
      console.log(`  [${i + 1}] ${u.name} - ${u.url}${status}`);
    });

    const numStr = await question(rl, '\n请输入要停用的 Provider 编号');
    const num = parseInt(numStr, 10);
    if (isNaN(num) || num < 1 || num > config.upstreams.length) {
      console.log('❌ 无效的编号');
      return;
    }

    const upstream = config.upstreams[num - 1];
    if (!upstream.enabled) {
      console.log(`\n⚠️  Provider ${num} (${upstream.name}) 已经是停用状态`);
      return;
    }

    const confirm = await questionYesNo(rl, `确认停用 Provider ${num} (${upstream.name})?`);
    if (confirm) {
      const idx = upstream.index;
      updateEnvLine(`UPSTREAM_${idx}_ENABLED`, 'false');
      console.log(`\n✅ Provider ${num} (${upstream.name}) 已停用`);
      console.log('重启 aigw 使配置生效: npm start');
    } else {
      console.log('已取消');
    }
  } finally {
    rl.close();
  }
}

async function cmdProviderEnable() {
  const config = loadConfig();
  if (config.upstreams.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    console.log('运行 `aigw provider add` 添加 Provider');
    return;
  }

  // 找出所有 Provider（包括停用的）
  const allProviders = [];
  const envPath = ENV_FILE;
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (let i = 1; i <= 50; i++) {
      const urlMatch = content.match(new RegExp(`^UPSTREAM_${i}_URL=(.+)$`, 'm'));
      if (urlMatch) {
        const url = urlMatch[1].trim().replace(/\/$/, '');
        const nameMatch = content.match(new RegExp(`^UPSTREAM_${i}_NAME=(.+)$`, 'm'));
        const name = nameMatch ? nameMatch[1].trim() : (isIFlowDomain(url) ? 'iFlow' : `provider-${i}`);
        const enabledMatch = content.match(new RegExp(`^UPSTREAM_${i}_ENABLED=(.+)$`, 'm'));
        const enabled = enabledMatch ? enabledMatch[1].trim().toLowerCase() !== 'false' : true;
        allProviders.push({ index: i, name, url, enabled });
      }
    }
  }

  if (allProviders.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    return;
  }

  const disabled = allProviders.filter(p => !p.enabled);
  if (disabled.length === 0) {
    console.log('✅ 所有 Provider 都已启用');
    return;
  }

  const rl = createReadline();
  try {
    console.log('已停用的 Provider:\n');
    disabled.forEach((p, i) => {
      console.log(`  [${i + 1}] ${p.name} - ${p.url}`);
    });

    const numStr = await question(rl, '\n请输入要启用的 Provider 编号');
    const num = parseInt(numStr, 10);
    if (isNaN(num) || num < 1 || num > disabled.length) {
      console.log('❌ 无效的编号');
      return;
    }

    const provider = disabled[num - 1];
    updateEnvLine(`UPSTREAM_${provider.index}_ENABLED`, 'true');
    console.log(`\n✅ Provider (${provider.name}) 已启用`);
    console.log('重启 aigw 使配置生效: npm start');
  } finally {
    rl.close();
  }
}

async function cmdProviderAddIFlow() {
  console.log('正在读取 iFlow CLI 凭证...\n');

  // 从 ~/.iflow/settings.json 读取凭证
  const settingsPath = path.join(os.homedir(), '.iflow', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    console.log('❌ 未找到 iFlow CLI 配置文件');
    console.log('请先运行 `iflow login` 登录 iFlow CLI');
    return;
  }

  let cliCreds;
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);
    cliCreds = {
      apiKey: settings.apiKey || null,
      baseUrl: settings.baseUrl || 'https://apis.iflow.cn/v1',
    };
  } catch (err) {
    console.log(`❌ 读取 iFlow CLI 配置失败: ${err.message}`);
    return;
  }

  if (!cliCreds.apiKey) {
    console.log('❌ iFlow CLI 配置中没有 API Key');
    console.log('请先运行 `iflow login` 登录 iFlow CLI');
    return;
  }

  console.log(`✅ 找到 iFlow CLI 凭证`);
  console.log(`   API Key: ${cliCreds.apiKey.substring(0, 10)}...${cliCreds.apiKey.substring(cliCreds.apiKey.length - 4)}`);
  console.log(`   Base URL: ${cliCreds.baseUrl}`);
  console.log('');

  // 检查是否已有 iFlow Provider
  const envPath = ENV_FILE;
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (let i = 1; i <= 50; i++) {
      const urlMatch = content.match(new RegExp(`^UPSTREAM_${i}_URL=(.+)$`, 'm'));
      if (urlMatch) {
        const url = urlMatch[1].trim();
        if (isIFlowDomain(url)) {
          console.log(`⚠️  已存在 iFlow Provider (UPSTREAM_${i})`);
          console.log('如需重新添加，请先删除现有的 iFlow Provider');
          return;
        }
      }
    }
  }

  const rl = createReadline();
  try {
    const confirm = await questionYesNo(rl, '确认添加 iFlow Provider?');
    if (!confirm) {
      console.log('已取消');
      return;
    }

    // 查找下一个可用的 Provider 编号
    let num = 1;
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (let i = 1; i <= 50; i++) {
        if (!content.includes(`UPSTREAM_${i}_URL=`)) {
          num = i;
          break;
        }
      }
    }

    const now = new Date().toISOString().split('T')[0];
    const url = cliCreds.baseUrl.replace(/\/$/, '');

    // 使用 auto 模式，动态读取 key
    const newProvider = `\n# Provider ${num}: iFlow (added ${now})
UPSTREAM_${num}_URL=${url}
UPSTREAM_${num}_KEY=auto
UPSTREAM_${num}_SIGN=true
UPSTREAM_${num}_NAME=iFlow
`;

    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    envContent = envContent.trimEnd() + newProvider;
    fs.writeFileSync(envPath, envContent, 'utf-8');

    console.log(`\n✅ iFlow Provider 已添加 (UPSTREAM_${num})`);
    console.log(`   URL: ${url}`);
    console.log(`   Key: auto (动态读取自 ~/.iflow/settings.json)`);
    console.log('\n重启 aigw 使配置生效: npm start');
  } finally {
    rl.close();
  }
}

async function cmdProviderClear() {
  // 读取所有 Provider
  const allProviders = [];
  const envPath = ENV_FILE;
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (let i = 1; i <= 50; i++) {
      const urlMatch = content.match(new RegExp(`^UPSTREAM_${i}_URL=(.+)$`, 'm'));
      if (urlMatch) {
        const url = urlMatch[1].trim().replace(/\/$/, '');
        const nameMatch = content.match(new RegExp(`^UPSTREAM_${i}_NAME=(.+)$`, 'm'));
        const name = nameMatch ? nameMatch[1].trim() : (isIFlowDomain(url) ? 'iFlow' : `provider-${i}`);
        allProviders.push({ index: i, name, url });
      }
    }
  }

  if (allProviders.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    return;
  }

  console.log('已配置的 Provider:\n');
  allProviders.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.name} - ${p.url}`);
  });
  console.log('');

  const rl = createReadline();
  try {
    const confirm = await questionYesNo(rl, `确认清空所有 ${allProviders.length} 个 Provider?`);
    if (!confirm) {
      console.log('已取消');
      return;
    }

    // 删除所有 Provider 相关配置
    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    const newLines = [];
    let skipNextEmpty = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 跳过 Provider 注释行
      if (line.match(/^# Provider \d+:/)) {
        skipNextEmpty = true;
        continue;
      }
      // 跳过 UPSTREAM_X_* 配置行
      if (line.match(/^UPSTREAM_\d+_/)) {
        continue;
      }
      // 跳过注释后的空行
      if (skipNextEmpty && line.trim() === '') {
        skipNextEmpty = false;
        continue;
      }
      newLines.push(line);
    }

    // 清理末尾多余空行
    let result = newLines.join('\n').trimEnd() + '\n';
    fs.writeFileSync(envPath, result, 'utf-8');

    console.log(`\n✅ 已清空 ${allProviders.length} 个 Provider`);
    console.log('重启 aigw 使配置生效: npm start');
  } finally {
    rl.close();
  }
}

async function cmdModel() {
  const config = loadConfig();

  console.log('当前配置:\n');
  console.log(`  默认模型: ${config.defaultModel}`);
  console.log(`  Provider 数量: ${config.upstreams.length}`);

  if (config.upstreams.length === 0) {
    console.log('\n❌ 没有配置任何 Provider');
    console.log('运行 `aigw provider add` 添加 Provider');
    return;
  }

  const rl = createReadline();

  try {
    console.log('\n正在获取可用模型...\n');

    // 获取所有模型
    const allModels = [];
    for (const upstream of config.upstreams) {
      try {
        const result = await testProvider(upstream.url, upstream.key);
        if (result.success && result.models) {
          const resp = await httpRequest(`${upstream.url}/models`, {
            headers: {
              'authorization': `Bearer ${upstream.key}`,
              'user-agent': 'iFlow-Cli',
              'accept': '*/*',
            },
            timeout: 10000,
          });
          if (resp.statusCode === 200) {
            const json = JSON.parse(resp.data);
            if (json.data) {
              json.data.forEach(m => {
                if (!allModels.find(x => x.id === m.id)) {
                  allModels.push({
                    id: m.id,
                    owned_by: m.owned_by || 'unknown',
                    upstream: upstream.name,
                    alias: `${upstream.name}/${m.id}`,
                  });
                }
              });
            }
          }
        }
      } catch (_) {}
    }

    if (allModels.length === 0) {
      console.log('❌ 无法获取模型列表');
      return;
    }

    // 按来源分组显示
    const byUpstream = {};
    for (const m of allModels) {
      const key = m.upstream || 'unknown';
      if (!byUpstream[key]) byUpstream[key] = [];
      byUpstream[key].push(m);
    }

    console.log(`可用模型 (${allModels.length} 个):\n`);
    let idx = 1;
    for (const [upstream, models] of Object.entries(byUpstream)) {
      console.log(`[${upstream}]`);
      for (const m of models) {
        const current = m.id === config.defaultModel ? ' ← 当前' : '';
        console.log(`  ${idx}. ${m.id}  (${m.alias})${current}`);
        idx++;
      }
      console.log('');
    }

    const total = allModels.length;
    console.log(`共 ${total} 个模型\n`);

    const action = await question(rl, '输入序号选择模型, q=退出');
    if (action === 'q' || action === '') {
      return;
    }

    const num = parseInt(action, 10);
    if (num >= 1 && num <= allModels.length) {
      const model = allModels[num - 1];
      const confirm = await questionYesNo(rl, `\n设置默认模型为 ${model.id}?`);

      if (confirm) {
        // 更新 .env
        const envPath = ENV_FILE;
        let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

        const lines = content.split('\n');
        let foundDefault = false;
        let foundModels = false;
        const newLines = lines.map(line => {
          if (line.startsWith('DEFAULT_MODEL=')) {
            foundDefault = true;
            return `DEFAULT_MODEL=${model.id}`;
          }
          if (line.startsWith('IFLOW_MODELS=')) {
            foundModels = true;
            return `IFLOW_MODELS=${model.id}`;
          }
          return line;
        });

        if (!foundDefault) newLines.push(`DEFAULT_MODEL=${model.id}`);
        if (!foundModels) newLines.push(`IFLOW_MODELS=${model.id}`);

        fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');

        console.log(`\n✅ 默认模型已设置为: ${model.id}`);
        console.log('重启 aigw 使配置生效: npm start');
      }
    }
  } finally {
    rl.close();
  }
}

async function cmdVisionModel() {
  const envPath = ENV_FILE;

  // 读取当前视觉模型配置
  let currentVisionModel = '';
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/^MM_EXTRACTOR_MODEL=(.+)$/m);
    if (match) {
      currentVisionModel = match[1].trim();
    }
  }

  console.log('视觉模型设置\n');
  console.log(`当前视觉模型: ${currentVisionModel || '(未设置)'}`);
  console.log('');
  console.log('视觉模型用于处理图片请求，将图片内容提取为文本。');
  console.log('支持 provider/model 格式指定 Provider。');
  console.log('');

  const rl = createReadline();
  try {
    // 获取可用的视觉模型
    console.log('正在获取可用的视觉模型...\n');
    const config = loadConfig();
    const visionModels = [];

    for (const upstream of config.upstreams) {
      try {
        const result = await testProvider(upstream.url, upstream.key, true);
        if (result.success && result.allModels) {
          // 过滤视觉模型
          const vlModels = result.allModels.filter(m =>
            m.includes('vl') || m.includes('vision') || m.includes('qwen-vl') || m.includes('glm-4v')
          );
          if (vlModels.length > 0) {
            console.log(`[${upstream.name}]`);
            vlModels.forEach(m => {
              console.log(`  ${m}  (${upstream.name}/${m})`);
              visionModels.push({ id: m, provider: upstream.name, alias: `${upstream.name}/${m}` });
            });
            console.log('');
          }
        }
      } catch (_) {}
    }

    if (visionModels.length === 0) {
      console.log('⚠️  未找到视觉模型，请手动输入。');
    }

    const input = await question(rl, '\n请输入视觉模型 (格式: provider/model 或 model)', currentVisionModel);
    const visionModel = input.trim();

    if (!visionModel) {
      console.log('❌ 视觉模型不能为空');
      return;
    }

    // 更新 .env
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    const lines = content.split('\n');
    let found = false;
    const newLines = lines.map(line => {
      if (line.startsWith('MM_EXTRACTOR_MODEL=')) {
        found = true;
        return `MM_EXTRACTOR_MODEL=${visionModel}`;
      }
      return line;
    });

    if (!found) {
      // 找到 MM_ENABLED 后面插入
      const mmIdx = newLines.findIndex(l => l.startsWith('MM_ENABLED='));
      if (mmIdx >= 0) {
        newLines.splice(mmIdx + 1, 0, `MM_EXTRACTOR_MODEL=${visionModel}`);
      } else {
        newLines.push(`MM_EXTRACTOR_MODEL=${visionModel}`);
      }
    }

    fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
    console.log(`\n✅ 视觉模型已设置为: ${visionModel}`);
    console.log('重启 aigw 使配置生效: npm start');
  } finally {
    rl.close();
  }
}

// 尝试热重载（静默）
async function tryReload() {
  const config = loadConfig();
  const baseUrl = `http://localhost:${config.port}`;

  try {
    await httpRequest(`${baseUrl}/admin/reload`, {
      method: 'POST',
      timeout: 3000,
    });
  } catch (_) {
    // 静默失败，服务可能未运行
  }
}

async function cmdReload() {
  const config = loadConfig();
  const baseUrl = `http://localhost:${config.port}`;

  try {
    const response = await httpRequest(`${baseUrl}/admin/reload`, {
      method: 'POST',
      timeout: 5000,
    });

    if (response.statusCode === 200) {
      const result = JSON.parse(response.data);
      console.log('✅ 配置已热重载');
      console.log(`   Provider 数量: ${result.providerCount}`);
      console.log(`   调度策略: ${result.strategy}`);
    } else {
      console.log('❌ 热重载失败:', response.statusCode);
    }
  } catch (err) {
    console.log('❌ 无法连接到 aigw 服务');
    console.log('确保服务正在运行: npm start');
  }
}

async function cmdStrategy() {
  const envPath = ENV_FILE;

  // 读取当前配置
  let currentStrategy = 'fastest';
  let defaultModel = 'glm-5';
  let defaultProvider = '';

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const strategyMatch = content.match(/^UPSTREAM_STRATEGY=(.+)$/m);
    if (strategyMatch) {
      currentStrategy = strategyMatch[1].trim();
    }
    const modelMatch = content.match(/^DEFAULT_MODEL=(.+)$/m);
    if (modelMatch) {
      defaultModel = modelMatch[1].trim();
    }
    const providerMatch = content.match(/^DEFAULT_MODEL_PROVIDER=(.+)$/m);
    if (providerMatch) {
      defaultProvider = providerMatch[1].trim();
    }
  }

  // 解析当前模型显示
  const currentModelDisplay = currentStrategy === 'fixed' && defaultProvider
    ? `${defaultProvider}/${defaultModel}`
    : defaultModel;

  console.log('调度策略设置\n');
  console.log(`当前策略: ${currentStrategy}`);
  console.log(`默认模型: ${currentModelDisplay}`);
  console.log('');
  console.log('可选策略:');
  console.log('  1. fastest     自动选择响应最快的 Provider');
  console.log('  2. roundrobin  轮询所有有该模型的 Provider');
  console.log('  3. fixed       固定使用指定 Provider');
  console.log('');

  const rl = createReadline();
  try {
    const choice = await question(rl, '请选择策略 (1-3)',
      currentStrategy === 'fastest' ? '1' : currentStrategy === 'roundrobin' ? '2' : '3');

    let strategy;
    let provider = defaultProvider;

    switch (choice) {
      case '1':
        strategy = 'fastest';
        break;
      case '2':
        strategy = 'roundrobin';
        break;
      case '3':
        strategy = 'fixed';
        // 询问 Provider
        const providerInput = await question(rl, '请输入 Provider 名称', defaultProvider);
        provider = providerInput.trim();
        if (!provider) {
          console.log('❌ fixed 策略需要指定 Provider');
          return;
        }
        break;
      default:
        console.log('❌ 无效选择');
        return;
    }

    // 更新 .env
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    const lines = content.split('\n');
    let foundStrategy = false;
    let foundProvider = false;
    const newLines = lines.map(line => {
      if (line.startsWith('UPSTREAM_STRATEGY=')) {
        foundStrategy = true;
        return `UPSTREAM_STRATEGY=${strategy}`;
      }
      if (line.startsWith('DEFAULT_MODEL_PROVIDER=')) {
        foundProvider = true;
        return `DEFAULT_MODEL_PROVIDER=${provider}`;
      }
      return line;
    });

    if (!foundStrategy) {
      const portIdx = newLines.findIndex(l => l.startsWith('PORT='));
      if (portIdx >= 0) {
        newLines.splice(portIdx + 1, 0, `UPSTREAM_STRATEGY=${strategy}`);
      } else {
        newLines.push(`UPSTREAM_STRATEGY=${strategy}`);
      }
    }

    // fixed 策略时写入 DEFAULT_MODEL_PROVIDER
    if (strategy === 'fixed') {
      if (!foundProvider) {
        newLines.push(`DEFAULT_MODEL_PROVIDER=${provider}`);
      }
    } else {
      // 非 fixed 策略时删除 DEFAULT_MODEL_PROVIDER
      const providerIdx = newLines.findIndex(l => l.startsWith('DEFAULT_MODEL_PROVIDER='));
      if (providerIdx >= 0) {
        newLines.splice(providerIdx, 1);
      }
    }

    fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');

    const displayModel = strategy === 'fixed' ? `${provider}/${defaultModel}` : defaultModel;
    console.log(`\n✅ 调度策略已设置为: ${strategy}`);
    console.log(`   默认模型: ${displayModel}`);
    console.log('重启 aigw 使配置生效: npm start');
  } finally {
    rl.close();
  }
}

async function cmdHealth() {
  const config = loadConfig();
  const baseUrl = `http://localhost:${config.port}`;

  try {
    const health = await httpRequest(`${baseUrl}/health`, { timeout: 5000 });
    console.log('服务状态: ', JSON.parse(health.data));

    try {
      const acpHealth = await httpRequest(`${baseUrl}/health/acp`, { timeout: 5000 });
      const acp = JSON.parse(acpHealth.data);
      console.log('\nACP 状态:');
      console.log(`  启用: ${acp.acp.enabled}`);
      console.log(`  可用: ${acp.acp.available}`);
      console.log(`  连接: ${acp.acp.connected}`);
      console.log(`  端口: ${acp.acp.port}`);
    } catch (_) {
      console.log('\nACP 状态: 服务未运行');
    }
  } catch (_) {
    console.log('❌ 无法连接到 aigw');
    console.log(`确保服务正在运行: npm start`);
  }
}

async function cmdConfig() {
  const args = process.argv.slice(2);
  const subCmd = args[1];
  const key = args[2];
  const value = args[3];

  if (subCmd === 'get') {
    // 获取配置
    if (!key) {
      console.log('用法: aigw config get <KEY>');
      console.log('\n常用配置:');
      console.log('  DEFAULT_MODEL        默认模型');
      console.log('  MM_EXTRACTOR_MODEL   视觉提取模型');
      console.log('  MM_ENABLED           多模态功能开关');
      console.log('  UPSTREAM_STRATEGY    上游选择策略 (fastest/roundrobin)');
      return;
    }
    const value = process.env[key];
    if (value !== undefined) {
      console.log(`${key}=${value}`);
    } else {
      // 尝试从 .env 读取
      const envPath = ENV_FILE;
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.startsWith(`${key}=`)) {
            console.log(line);
            return;
          }
        }
      }
      console.log(`${key} 未设置`);
    }
    return;
  }

  if (subCmd === 'set') {
    // 设置配置
    if (!key || value === undefined) {
      console.log('用法: aigw config set <KEY> <VALUE>');
      console.log('\n示例:');
      console.log('  aigw config set DEFAULT_MODEL qwen-max');
      console.log('  aigw config set MM_EXTRACTOR_MODEL iFlow/qwen3-vl-plus');
      return;
    }

    const envPath = ENV_FILE;
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf-8');
    }

    const lines = content.split('\n');
    let found = false;
    const newLines = lines.map(line => {
      if (line.startsWith(`${key}=`)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });

    if (!found) {
      if (newLines.length > 0 && newLines[newLines.length - 1] !== '') {
        newLines.push('');
      }
      newLines.push(`${key}=${value}`);
    }

    fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
    console.log(`✅ 已设置 ${key}=${value}`);
    console.log('重启 aigw 使配置生效: npm start');
    return;
  }

  if (subCmd === 'list') {
    // 列出所有配置
    const envPath = ENV_FILE;
    if (!fs.existsSync(envPath)) {
      console.log('❌ .env 文件不存在');
      return;
    }

    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');

    console.log('当前配置:\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        console.log(`  ${trimmed}`);
      }
    }
    return;
  }

  // 默认显示帮助
  console.log(`用法: aigw config <command>

命令:
  get <KEY>     获取配置值
  set <KEY> <VALUE>  设置配置值
  list          列出所有配置

常用配置:
  DEFAULT_MODEL        默认模型
  MM_EXTRACTOR_MODEL   视觉提取模型 (支持 provider/model 格式)
  MM_ENABLED           多模态功能开关 (true/false)
  UPSTREAM_STRATEGY    上游选择策略 (fastest/roundrobin)

示例:
  aigw config get DEFAULT_MODEL
  aigw config set DEFAULT_MODEL iFlow/qwen3-max
  aigw config set MM_EXTRACTOR_MODEL aliyun/qwen-vl-max
  aigw config list
`);
}

// ─── 帮助信息 ────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
aigw CLI - 管理 aigw 代理

用法:
  aigw <command> [args]

命令:
  models                      列出所有可用模型（含来源和别名）
  model                       交互式选择默认模型
  vision-model                设置视觉提取模型
  strategy                    设置调度策略
  reload                      热重载配置（无需重启）
  provider list               列出已配置的 Provider
  provider add                交互式添加 Provider
  provider add-iflow          从 iFlow CLI 添加 iFlow Provider
  provider remove             删除 Provider
  provider clear              清空所有 Provider
  provider test               测试 Provider 连接
  provider name               设置 Provider 名称
  provider disable            停用 Provider
  provider enable             启用 Provider
  config get <KEY>            获取配置值
  config set <KEY> <VALUE>    设置配置值
  config list                 列出所有配置
  health                      检查服务状态

调度策略:
  fastest     相同模型自动选最快的 Provider（默认）
  roundrobin  轮询所有有该模型的 Provider
  fixed       固定使用指定的 Provider（需设置 DEFAULT_MODEL_PROVIDER）

模型别名格式:
  provider/model    例如: iFlow/qwen3-max

常用配置:
  DEFAULT_MODEL           默认模型
  DEFAULT_MODEL_PROVIDER  fixed 策略下的默认 Provider
  MM_EXTRACTOR_MODEL      视觉提取模型
  UPSTREAM_STRATEGY       调度策略

示例:
  aigw models
  aigw model                          # 交互式选择默认模型
  aigw vision-model                   # 设置视觉模型
  aigw strategy                       # 设置调度策略
  aigw reload                         # 热重载配置
  aigw provider add
  aigw config set DEFAULT_MODEL iFlow/qwen3-max
`);
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const subCmd = args[1];

  switch (command) {
    case 'models':
      await cmdModels();
      break;
    case 'model':
      await cmdModel();
      break;
    case 'strategy':
      await cmdStrategy();
      break;
    case 'vision-model':
    case 'vision':
      await cmdVisionModel();
      break;
    case 'reload':
      await cmdReload();
      break;
    case 'provider':
      if (subCmd === 'list') {
        await cmdProviderList();
      } else if (subCmd === 'add') {
        await cmdProviderAdd();
      } else if (subCmd === 'add-iflow') {
        await cmdProviderAddIFlow();
      } else if (subCmd === 'remove' || subCmd === 'rm') {
        await cmdProviderRemove();
      } else if (subCmd === 'clear') {
        await cmdProviderClear();
      } else if (subCmd === 'test') {
        await cmdProviderTest();
      } else if (subCmd === 'name') {
        await cmdProviderName();
      } else if (subCmd === 'disable') {
        await cmdProviderDisable();
      } else if (subCmd === 'enable') {
        await cmdProviderEnable();
      } else {
        console.log('用法: aigw provider <list|add|add-iflow|remove|clear|test|name|disable|enable>');
      }
      break;
    case 'config':
      await cmdConfig();
      break;
    case 'health':
      await cmdHealth();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.log(`未知命令: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('错误:', err.message);
  process.exit(1);
});
