'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 配置文件路径：固定为 ~/.iflow-relay/.env
const ENV_FILE = path.join(os.homedir(), '.iflow-relay', '.env');

function getEnv(key, defaultValue) {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : defaultValue;
}

function getBool(key, defaultValue) {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  return v.toLowerCase() !== 'false' && v !== '0';
}

function getInt(key, defaultValue) {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  const n = parseInt(v, 10);
  return isNaN(n) ? defaultValue : n;
}

function getFloat(key, defaultValue) {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  const n = parseFloat(v);
  return isNaN(n) ? defaultValue : n;
}

function getList(key, defaultValue) {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

// ─── iFlow 域名检测 ────────────────────────────────────────────────────────────

/**
 * 检测 URL 是否为 iFlow 官方域名
 * @param {string} url - API URL
 * @returns {boolean}
 */
function isIFlowDomain(url) {
  if (!url) return false;
  // iFlow 官方域名列表
  const IFLOW_DOMAINS = [
    'apis.iflow.cn',
    'api.iflow.cn',
    'iflow.cn',
  ];
  return IFLOW_DOMAINS.some(d =>
    url.includes(`://${d}`) || url.includes(`://${d}:`) || url.includes(`.${d}`)
  );
}

// ─── iFlow CLI OAuth 凭证读取 ──────────────────────────────────────────────────

/**
 * 从 ~/.iflow/settings.json 读取 iFlow CLI 的设置（包含 baseUrl 和 apiKey）
 * 用户通过 iflow login 登录后，配置保存在此文件中
 */
function loadIFlowSettings() {
  const settingsPath = path.join(os.homedir(), '.iflow', 'settings.json');
  try {
    if (!fs.existsSync(settingsPath)) {
      return null;
    }
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);
    return {
      apiKey: settings.apiKey || null,
      baseUrl: settings.baseUrl || null,
      modelName: settings.modelName || null,
    };
  } catch (err) {
    console.warn(`[config] Failed to load iFlow settings: ${err.message}`);
    return null;
  }
}

/**
 * 从 ~/.iflow/oauth_creds.json 读取 iFlow CLI 的 OAuth 凭证
 * 用户通过 iflow login 登录后，凭证会保存在此文件中
 */
function loadIFlowOAuthCredentials() {
  const credsPath = path.join(os.homedir(), '.iflow', 'oauth_creds.json');
  try {
    if (!fs.existsSync(credsPath)) {
      return null;
    }
    const content = fs.readFileSync(credsPath, 'utf-8');
    const creds = JSON.parse(content);
    return {
      apiKey: creds.apiKey || null,
      accessToken: creds.access_token || null,
      refreshToken: creds.refresh_token || null,
      expiryDate: creds.expiry_date || null,
      userId: creds.userId || null,
      userName: creds.userName || null,
    };
  } catch (err) {
    console.warn(`[config] Failed to load iFlow OAuth credentials: ${err.message}`);
    return null;
  }
}

/**
 * 从 ~/.iflow/iflow_accounts.json 读取活跃的 API Key
 */
function loadIFlowAccounts() {
  const accountsPath = path.join(os.homedir(), '.iflow', 'iflow_accounts.json');
  try {
    if (!fs.existsSync(accountsPath)) {
      return null;
    }
    const content = fs.readFileSync(accountsPath, 'utf-8');
    const accounts = JSON.parse(content);
    return {
      activeApiKey: accounts.iflowApiKey || null,
    };
  } catch (err) {
    console.warn(`[config] Failed to load iFlow accounts: ${err.message}`);
    return null;
  }
}

/**
 * 从 iFlow CLI 配置中获取凭证
 * 优先级：settings.json > oauth_creds.json > iflow_accounts.json
 * @returns {{ apiKey: string|null, baseUrl: string|null }}
 */
function getIFlowCLICredentials() {
  const result = { apiKey: null, baseUrl: null };

  // 1. 尝试从 settings.json 读取（最完整）
  const settings = loadIFlowSettings();
  if (settings) {
    if (settings.apiKey) {
      console.log('[config] Using API key from ~/.iflow/settings.json');
      result.apiKey = settings.apiKey;
    }
    if (settings.baseUrl) {
      console.log('[config] Using base URL from ~/.iflow/settings.json');
      result.baseUrl = settings.baseUrl;
    }
    if (result.apiKey && result.baseUrl) {
      return result;
    }
  }

  // 2. 尝试从 oauth_creds.json 读取
  if (!result.apiKey) {
    const oauthCreds = loadIFlowOAuthCredentials();
    if (oauthCreds && oauthCreds.apiKey) {
      console.log('[config] Using API key from ~/.iflow/oauth_creds.json');
      result.apiKey = oauthCreds.apiKey;
    }
  }

  // 3. 尝试从 iflow_accounts.json 读取
  if (!result.apiKey) {
    const accounts = loadIFlowAccounts();
    if (accounts && accounts.activeApiKey) {
      console.log('[config] Using API key from ~/.iflow/iflow_accounts.json');
      result.apiKey = accounts.activeApiKey;
    }
  }

  return result;
}

/**
 * 自动添加 iFlow Provider 到 .env 文件
 * @param {Object} cliCreds - 从 ~/.iflow/settings.json 读取的凭证
 * @param {number} providerNum - Provider 编号，默认自动查找
 */
function autoAddIFlowProvider(cliCreds, providerNum = null) {
  if (!cliCreds.apiKey) {
    console.log('[config] No iFlow CLI credentials found, skipping auto-add');
    return { success: false, reason: 'no-credentials' };
  }

  const envPath = ENV_FILE;
  const envDir = path.dirname(envPath);

  try {
    // 确保配置目录存在
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true });
    }

    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf-8');
    }

    // 查找下一个可用的 Provider 编号
    let num = providerNum;
    if (num === null) {
      for (let i = 1; i <= 50; i++) {
        if (!content.includes(`UPSTREAM_${i}_URL=`) && !content.includes(`UPSTREAM_${i}_KEY=`)) {
          num = i;
          break;
        }
      }
    }

    if (num === null) {
      console.log('[config] No available Provider slot (max 50)');
      return { success: false, reason: 'no-slot' };
    }

    // 检查是否已有 iFlow Provider
    for (let i = 1; i <= 50; i++) {
      const urlMatch = content.match(new RegExp(`^UPSTREAM_${i}_URL=(.+)$`, 'm'));
      if (urlMatch) {
        const url = urlMatch[1].trim();
        if (isIFlowDomain(url)) {
          console.log(`[config] iFlow Provider already exists at UPSTREAM_${i}`);
          return { success: false, reason: 'already-exists', slot: i };
        }
      }
    }

    const now = new Date().toISOString().split('T')[0];
    const url = cliCreds.baseUrl || 'https://apis.iflow.cn/v1';

    // 使用 auto 模式，动态读取 key
    const newProvider = `\n# Provider ${num}: iFlow (added ${now})
UPSTREAM_${num}_URL=${url}
UPSTREAM_${num}_KEY=auto
UPSTREAM_${num}_SIGN=true
UPSTREAM_${num}_NAME=iFlow
`;

    // 添加新 Provider
    const newContent = content.trimEnd() + newProvider;
    fs.writeFileSync(envPath, newContent, 'utf-8');
    console.log(`[config] Added iFlow provider to .env as UPSTREAM_${num} (${url})`);
    return { success: true, slot: num, url };
  } catch (err) {
    console.warn(`[config] Failed to add iFlow provider: ${err.message}`);
    return { success: false, reason: 'error', error: err.message };
  }
}

function load() {
  // 尝试从 iFlow CLI 配置获取凭证（用于 KEY=auto 模式）
  const cliCreds = getIFlowCLICredentials();

  // API Key 获取优先级：
  // 1. IFLOW_API_KEYS 环境变量（多个 key）
  // 2. IFLOW_API_KEY 环境变量（单个 key）
  // 3. ~/.iflow/settings.json 或 ~/.iflow/oauth_creds.json（iFlow CLI 登录后的凭证）
  // 4. .env 中的 UPSTREAM_X_KEY
  const apiKeys = (() => {
    const multi = getList('IFLOW_API_KEYS', []);
    if (multi.length > 0) return multi;
    const single = getEnv('IFLOW_API_KEY', '');
    if (single) return [single];
    // 优先使用刚读取的 CLI 凭证
    if (cliCreds.apiKey) return [cliCreds.apiKey];
    return [];
  })();

  // 重新读取 .env 以获取自动添加的配置
  const hasUpstreamsCheck = !!getEnv('UPSTREAMS', '') || !!getEnv('UPSTREAM_1_KEY', '');
  if (apiKeys.length === 0 && !hasUpstreamsCheck) {
    console.error('ERROR: No API key found. Options:');
    console.error('  1. Set IFLOW_API_KEY environment variable');
    console.error('  2. Run "iflow login" to authenticate with iFlow CLI');
    console.error('  3. Configure UPSTREAMS in .env file');
    process.exit(1);
  }

  const defaultModel = getEnv('DEFAULT_MODEL', '');
  const models = (() => {
    const list = getList('IFLOW_MODELS', []);
    if (list.length > 0) return list;
    return defaultModel ? [defaultModel] : ['glm-5'];
  })();

  const enableSignature = getBool('IFLOW_ENABLE_SIGNATURE', true);
  // Base URL 优先级：环境变量 > CLI 配置 > 默认值
  const baseURL = getEnv('IFLOW_BASE_URL', cliCreds.baseUrl || 'https://apis.iflow.cn/v1').replace(/\/$/, '');

  // 多 upstream 支持，三种配置方式（优先级从高到低）：
  //
  // 方式1（推荐）：编号格式，每个 upstream 单独配置
  //   UPSTREAM_1_URL=https://apis.iflow.cn/v1
  //   UPSTREAM_1_KEY=sk-xxx
  //   UPSTREAM_2_URL=https://open.bigmodel.cn/api/paas/v4
  //   UPSTREAM_2_KEY=sk-yyy
  //
  // 特殊：当 URL 包含 iflow 且 UPSTREAM_X_KEY 为空或 "auto" 时，
  //       会动态读取 ~/.iflow/settings.json 的 key
  //
  // 方式2（兼容）：单行格式
  //   UPSTREAMS=sk-xxx|https://apis.iflow.cn/v1,sk-yyy|https://other.com/v1
  //
  // 方式3（回退）：IFLOW_API_KEY(S) + IFLOW_BASE_URL
  const upstreams = (() => {
    // 方式1：编号格式
    const numbered = [];
    for (let i = 1; i <= 50; i++) {
      const url = getEnv(`UPSTREAM_${i}_URL`, '').replace(/\/$/, '');
      const key = getEnv(`UPSTREAM_${i}_KEY`, '');
      // 支持显式配置签名：UPSTREAM_X_SIGN=true/false
      // 默认：启用签名（更安全，iFlow API 需要）
      const explicitSign = getEnv(`UPSTREAM_${i}_SIGN`, '');
      // 【新增】支持自定义名称
      const name = getEnv(`UPSTREAM_${i}_NAME`, '')
        || (isIFlowDomain(url) ? 'iFlow' : `provider-${i}`);
      // 【新增】支持显式指定是否为 iFlow：UPSTREAM_X_ISIFLOW=true/false
      const explicitIsIFlow = getEnv(`UPSTREAM_${i}_ISIFLOW`, '');
      // 【新增】支持配置模型列表：UPSTREAM_X_MODELS=model1,model2
      const models = getList(`UPSTREAM_${i}_MODELS`, []);
      // 【新增】支持启用/停用：UPSTREAM_X_ENABLED=true/false
      const enabled = getBool(`UPSTREAM_${i}_ENABLED`, true);
      if (!url && !key) break;
      if (!url) throw new Error(`UPSTREAM_${i}_URL must be set`);

      // 如果 URL 包含 iflow 且 key 为空或 "auto"，使用 CLI 凭证
      let finalKey = key;
      if (isIFlowDomain(url) && (!key || key.toLowerCase() === 'auto')) {
        finalKey = cliCreds.apiKey || '';
        if (!finalKey) {
          console.warn(`[config] UPSTREAM_${i}_KEY is auto but no iFlow CLI credentials found`);
        }
      }

      if (!finalKey) throw new Error(`UPSTREAM_${i}_KEY must be set`);
      // 签名逻辑：显式配置优先，否则 iFlow 域名默认启用
      const sign = explicitSign !== '' ? getBool(`UPSTREAM_${i}_SIGN`, true) : isIFlowDomain(url);
      // isIFlow 逻辑：显式配置优先，否则基于域名判断
      const isIFlow = explicitIsIFlow !== '' ? getBool(`UPSTREAM_${i}_ISIFLOW`, false) : isIFlowDomain(url);
      numbered.push({ key: finalKey, url, sign, isIFlow, name, models, enabled });
    }
    // 只返回启用的 upstream
    const enabledOnes = numbered.filter(u => u.enabled);
    if (enabledOnes.length < numbered.length) {
      const disabled = numbered.filter(u => !u.enabled).map(u => u.name).join(', ');
      console.log(`[config] Disabled providers: ${disabled}`);
    }
    return enabledOnes;

    // 方式2：单行格式
    const raw = getEnv('UPSTREAMS', '');
    if (raw) {
      return raw.split(',').map(s => s.trim()).filter(Boolean).map((entry, idx) => {
        const sep = entry.indexOf('|');
        if (sep < 0) throw new Error(`UPSTREAMS entry missing '|' separator: ${entry}`);
        const key = entry.slice(0, sep).trim();
        const url = entry.slice(sep + 1).trim().replace(/\/$/, '');
        if (!key || !url) throw new Error(`UPSTREAMS entry invalid: ${entry}`);
        const isIFlow = isIFlowDomain(url);
        const name = isIFlow ? 'iFlow' : `provider-${idx + 1}`;
        return { key, url, sign: isIFlow, isIFlow, name, models: [] };
      });
    }

    // 方式3：回退
    const isIFlow = isIFlowDomain(baseURL);
    return apiKeys.map((key, idx) => ({
      key,
      url: baseURL,
      sign: enableSignature || isIFlow,
      isIFlow,
      name: isIFlow ? 'iFlow' : `provider-${idx + 1}`,
      models: [],
    }));
  })();

  return {
    port: getInt('PORT', 8327),
    upstreamStrategy: getEnv('UPSTREAM_STRATEGY', 'fastest'), // 'fastest' | 'roundrobin'
    baseURL,
    apiKeys,
    upstreams,
    defaultModel,
    models,
    enableSignature,
    requestTimeoutMs: getInt('PROXY_REQUEST_TIMEOUT_MS', 180000),
    streamHeartbeatMs: getInt('PROXY_STREAM_HEARTBEAT_MS', 15000),
    maxBodyBytes: getInt('PROXY_MAX_BODY_BYTES', 26214400),
    emitHeartbeatComments: getBool('STREAM_EMIT_HEARTBEAT_COMMENTS', true),
    logRequestHeaders: getBool('LOG_REQUEST_HEADERS', false),
    logResponseHeaders: getBool('LOG_RESPONSE_HEADERS', false),
    sensitiveWords: getList('SENSITIVE_WORDS', ['Claude Code', 'Cursor', 'Cline', 'Kiro', 'aider', 'Windsurf', 'Copilot', 'OpenClaw']),
    multimodal: {
      enabled: getBool('MM_ENABLED', true),
      extractorModel: getEnv('MM_EXTRACTOR_MODEL', 'qwen3-vl-plus'),
      maxImages: getInt('MM_MAX_IMAGES', 4),
      timeoutMs: getInt('MM_TIMEOUT_MS', 12000),
      contextMessages: getInt('MM_CONTEXT_MESSAGES', 6),
      maxTokens: getInt('MM_MAX_TOKENS', 1024),
      lowConfidenceThreshold: getFloat('MM_LOW_CONFIDENCE_THRESHOLD', 0.65),
      lowConfidenceRetry: getInt('MM_LOW_CONFIDENCE_RETRY', 1),
      passThroughModels: getList('MM_PASS_THROUGH_MODELS', ['qwen3-vl-*', '*vision*', '*vl*', 'tstars2.0']),
      schemaVersion: 'v1',
      temperature: 0,
      // 【已移除】extractorUpstream 字段，改为在 server.js 中动态解析 extractorModel 中的 provider 前缀
    },
    // ACP 模式配置（通过官方 iFlow CLI 通信，避免封号）
    acp: {
      enabled: getBool('ACP_ENABLED', false),
      port: getInt('ACP_PORT', 8090),
      timeout: getInt('ACP_TIMEOUT', 180),
      debug: getBool('ACP_DEBUG', false),
      // ACP 模式下自动启动 iFlow CLI
      autoStart: getBool('ACP_AUTO_START', false),
      // ACP 启动命令
      startCommand: getEnv('ACP_START_COMMAND', 'iflow'),
    },
  };
}

module.exports = { load, getIFlowCLICredentials, isIFlowDomain, autoAddIFlowProvider };
