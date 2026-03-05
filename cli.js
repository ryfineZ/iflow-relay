#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

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

function loadConfig() {
  const port = parseInt(getEnv('PORT', '8327'), 10);

  // 加载上游配置
  const upstreams = [];
  for (let i = 1; i <= 50; i++) {
    const url = getEnv(`UPSTREAM_${i}_URL`, '').replace(/\/$/, '');
    const key = getEnv(`UPSTREAM_${i}_KEY`, '');
    if (!url && !key) break;
    if (!url || !key) continue;
    // 根据域名判断是否为 iFlow
    const isIFlow = isIFlowDomain(url);
    upstreams.push({ url, key, sign: isIFlow, name: getEnv(`UPSTREAM_${i}_NAME`, '') || (isIFlow ? 'iFlow' : `provider-${i}`) });
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
    upstreams.push({ url: iflowUrl, key: iflowKey, sign: true, name: 'iFlow' });
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
        model: 'test',
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

    // 400 (模型不存在等) 说明连接成功、认证通过
    if (testResponse.statusCode === 400) {
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
  } catch (err) {
    result.latency = Date.now() - startTime;
    result.error = err.message;
    return result;
  }

  return result;
}

// ─── Provider 管理 ────────────────────────────────────────────────────────────

function getNextProviderNum() {
  const envPath = path.join(process.cwd(), '.env');
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  let maxNum = 0;
  content.split('\n').forEach(line => {
    const match = line.match(/^UPSTREAM_(\d+)_URL=/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  });

  return maxNum + 1;
}

/**
 * 更新 .env 文件中的一行配置
 * @param {string} key - 配置键名，如 UPSTREAM_1_NAME
 * @param {string} value - 配置值
 */
function updateEnvLine(key, value) {
  const envPath = path.join(process.cwd(), '.env');
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

function addProviderToEnv(url, key, sign, name, defaultModel = null) {
  const envPath = path.join(process.cwd(), '.env');
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

  // 如果提供了默认模型，也写入 DEFAULT_MODEL
  if (defaultModel) {
    // 检查是否已有 DEFAULT_MODEL
    if (!content.includes('DEFAULT_MODEL=')) {
      newContent += `DEFAULT_MODEL=${defaultModel}\n`;
    }
  }

  fs.writeFileSync(envPath, newContent, 'utf-8');
  return { num, name: providerName, defaultModel };
}

function removeProviderFromEnv(num) {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return false;

  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  const urlPattern = new RegExp(`^UPSTREAM_${num}_URL=`);
  const keyPattern = new RegExp(`^UPSTREAM_${num}_KEY=`);
  const signPattern = new RegExp(`^UPSTREAM_${num}_SIGN=`);
  const namePattern = new RegExp(`^UPSTREAM_${num}_NAME=`);

  let found = false;
  const newLines = [];
  let skipComment = false;

  for (const line of lines) {
    if (line.match(new RegExp(`^# Provider ${num} `))) {
      skipComment = true;
      found = true;
      continue;
    }
    if (line.match(urlPattern) || line.match(keyPattern) || line.match(signPattern) || line.match(namePattern)) {
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
    console.log('运行 `iflow-relay provider add` 添加 Provider');
    return;
  }

  console.log('正在获取模型列表...\n');

  for (const upstream of config.upstreams) {
    console.log(`[${upstream.name}] ${upstream.url}`);

    try {
      const result = await testProvider(upstream.url, upstream.key, true);
      if (result.success) {
        if (result.warning) {
          console.log(`  ⚠️  连接成功 (${result.latency}ms)`);
          console.log(`  ${result.warning.split('\n').join('\n  ')}\n`);
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
      }
    } catch (err) {
      console.log(`  ❌ 连接失败: ${err.message}`);
    }
    console.log('');
  }
}

async function cmdProviderList() {
  const config = loadConfig();

  if (config.upstreams.length === 0) {
    console.log('❌ 没有配置任何 Provider');
    console.log('运行 `iflow-relay provider add` 添加 Provider');
    return;
  }

  console.log(`已配置 ${config.upstreams.length} 个 Provider:\n`);

  for (let i = 0; i < config.upstreams.length; i++) {
    const u = config.upstreams[i];
    console.log(`[${i + 1}] ${u.name}`);
    console.log(`    URL: ${u.url}`);
    console.log(`    Key: ${u.key.substring(0, 10)}...${u.key.substring(u.key.length - 4)}`);
    console.log(`    Sign: ${u.sign ? '是 (iFlow)' : '否'}`);
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
      let defaultModel = null;

      if (result.warning) {
        // 连接成功但模型列表不可用
        console.log(`\n⚠️  连接成功 (${result.latency}ms)`);
        console.log(`   ${result.warning.split('\n').join('\n   ')}`);
        console.log('');

        // 询问默认模型
        const inputModel = await question(rl, '请输入默认模型名称 (留空跳过)', '');
        if (inputModel.trim()) {
          defaultModel = inputModel.trim();
        }
      } else {
        // 完全成功
        console.log(`\n✅ 连接成功!`);
        console.log(`   延迟: ${result.latency}ms`);
        console.log(`   模型数量: ${result.modelCount}`);
        if (result.models.length > 0) {
          console.log(`   模型示例: ${result.models.join(', ')}`);
        }
      }

      // 询问是否保存
      const save = await questionYesNo(rl, '\n是否保存此 Provider?', 'y');
      if (save) {
        const { num, name } = addProviderToEnv(url, key, isIFlow, null, defaultModel);
        console.log(`\n✅ Provider ${num} (${name}) 已保存到 .env`);
        if (defaultModel) {
          console.log(`   默认模型: ${defaultModel}`);
        }
        console.log('重启 iflow-relay 使配置生效: npm start');
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
          const { num, name } = addProviderToEnv(url, key, isIFlow);
          console.log(`\n✅ Provider ${num} (${name}) 已保存到 .env (未验证)`);
          console.log('重启 iflow-relay 使配置生效: npm start');
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
      const envPath = path.join(process.cwd(), '.env');
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
              console.log('重启 iflow-relay 使配置生效: npm start');
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
    console.log('运行 `iflow-relay provider add` 添加 Provider');
    return;
  }

  const rl = createReadline();
  try {
    console.log('已配置的 Provider:\n');
    config.upstreams.forEach((u, i) => {
      console.log(`  [${i + 1}] ${u.name} - ${u.url}`);
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
    updateEnvLine(`UPSTREAM_${num}_NAME`, newName.trim());
    console.log(`\n✅ Provider ${num} 名称已设置为: ${newName.trim()}`);
    console.log('重启 iflow-relay 使配置生效: npm start');
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
    console.log('运行 `iflow-relay provider add` 添加 Provider');
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
        const envPath = path.join(process.cwd(), '.env');
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
        console.log('重启 iflow-relay 使配置生效: npm start');
      }
    }
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
    console.log('❌ 无法连接到 iflow-relay');
    console.log(`确保服务正在运行: npm start`);
  }
}

// ─── 帮助信息 ────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
iflow-relay CLI - 管理 iflow-relay 代理

用法:
  iflow-relay <command> [args]

命令:
  models                      列出所有可用模型（含来源和别名）
  model                       交互式选择默认模型
  provider list               列出已配置的 Provider
  provider add                交互式添加 Provider
  provider remove             删除 Provider
  provider test               测试 Provider 连接
  provider name               设置 Provider 名称
  health                      检查服务状态

模型别名格式:
  provider/model    例如: iFlow/qwen3-max

示例:
  iflow-relay models
  iflow-relay model
  iflow-relay provider add
  iflow-relay provider test
  iflow-relay provider name
  iflow-relay health
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
    case 'provider':
      if (subCmd === 'list') {
        await cmdProviderList();
      } else if (subCmd === 'add') {
        await cmdProviderAdd();
      } else if (subCmd === 'remove' || subCmd === 'rm') {
        await cmdProviderRemove();
      } else if (subCmd === 'test') {
        await cmdProviderTest();
      } else if (subCmd === 'name') {
        await cmdProviderName();
      } else {
        console.log('用法: iflow-relay provider <list|add|remove|test|name>');
      }
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
