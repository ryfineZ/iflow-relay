'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { execSync } = require('child_process');
const zlib = require('zlib');

const IFLOW_USER_AGENT = 'iFlow-Cli';
const IFLOW_MULTIMODAL_USER_AGENT = 'iFlow-Cli-MultimodalHelper';

// 每次启动生成新的 session-id（与官方 CLI 行为一致）
// 官方 CLI 不持久化 session-id，每次启动都是新的
const PERSISTENT_SESSION_ID = `session-${crypto.randomUUID()}`;

// ─── 错误处理：遇 429/403 主动暂停 ─────────────────────────────────────────────
let globalPauseUntil = 0;  // 暂停截止时间戳（毫秒）

function checkPause() {
  const now = Date.now();
  if (now < globalPauseUntil) {
    const waitMs = globalPauseUntil - now;
    throw new Error(`rate limited, pause for ${Math.ceil(waitMs / 1000)}s`);
  }
}

function triggerPause(statusCode) {
  const now = Date.now();
  if (statusCode === 429) {
    // 429: 限速，暂停 30 秒
    globalPauseUntil = Math.max(globalPauseUntil, now + 30000);
    console.warn(`[iflow] 429 rate limit, pausing for 30s`);
  } else if (statusCode === 403) {
    // 403: 疑似封号，暂停 5 分钟
    globalPauseUntil = Math.max(globalPauseUntil, now + 300000);
    console.warn(`[iflow] 403 forbidden, pausing for 5min`);
  }
}

function getPauseInfo() {
  const now = Date.now();
  if (now >= globalPauseUntil) return null;
  return { remainingMs: globalPauseUntil - now };
}

// 持久连接 agent：
// 1. keepAlive=true → Connection: keep-alive，与 iFlow CLI 行为一致
// 2. ALPNProtocols=['http/1.1'] → 禁止 HTTP/2 协商，保持 JA3 指纹与 iFlow CLI 一致
// 3. TLS session 复用，减少握手次数
const iflowHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 20,
  scheduling: 'lifo',
  ALPNProtocols: ['http/1.1'],
});

// 动态获取官方 CLI 版本号
function getIflowCliVersion() {
  try {
    const version = execSync('iflow --version 2>/dev/null', { encoding: 'utf-8' }).trim();
    // 输出格式可能是 "0.5.14" 或带有警告信息，提取版本号
    const match = version.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : '0.5.14'; // 默认版本作为 fallback
  } catch (_) {
    return '0.5.14'; // fallback 版本
  }
}

const IFLOW_AONE_CLIENT_TYPE = 'iflow-cli';
const IFLOW_AONE_CLIENT_VERSION = getIflowCliVersion();

function randomUUID() {
  return crypto.randomUUID();
}

// 生成 W3C traceparent 头（格式：00-{trace-id}-{parent-id}-01）
function generateTraceParent() {
  const traceId = crypto.randomBytes(16).toString('hex');  // 32位
  const parentId = crypto.randomBytes(8).toString('hex');   // 16位
  return `00-${traceId}-${parentId}-01`;
}

function createIFlowSignature(userAgent, sessionID, timestamp, apiKey) {
  if (!apiKey || !apiKey.trim()) return '';
  const payload = `${userAgent}:${sessionID}:${timestamp}`;
  return crypto.createHmac('sha256', apiKey).update(payload).digest('hex');
}

function requestIDs(body) {
  let conversationID = '';
  let sessionID = '';
  try {
    const obj = typeof body === 'string' ? JSON.parse(body) : body;
    conversationID = (obj.conversation_id || obj.conversationId || '').trim();
    sessionID = (obj.session_id || obj.sessionId || '').trim();
  } catch (_) {}
  if (!sessionID && conversationID) sessionID = conversationID;
  // 使用持久化的 session ID，而不是每次随机生成
  if (!sessionID) sessionID = PERSISTENT_SESSION_ID;
  // 官方 CLI 会为每个请求生成 conversation-id（即使请求体中没有）
  if (!conversationID) conversationID = crypto.randomUUID();
  return { sessionID, conversationID };
}

function buildIFlowHeaders(apiKey, withSignature, model, traceParent, sessionID, conversationID, userAgent, minimalHeaders) {
  // minimalHeaders: 辅助模型请求只发送最基本的头，与官方 CLI 行为一致
  if (minimalHeaders) {
    const headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey.trim()}`,
      'user-agent': userAgent || IFLOW_USER_AGENT,
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
    };
    return headers;
  }

  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${apiKey.trim()}`,
    'user-agent': userAgent || IFLOW_USER_AGENT,
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
    'session-id': sessionID,
  };

  if (conversationID) {
    headers['conversation-id'] = conversationID;
  }

  // traceparent: 如果没传入则自动生成（每个请求随机）
  if (traceParent && traceParent.trim()) {
    headers['traceparent'] = traceParent.trim();
  } else {
    headers['traceparent'] = generateTraceParent();
  }

  if (model && model.trim().toLowerCase() === 'aone') {
    headers['X-Client-Type'] = IFLOW_AONE_CLIENT_TYPE;
    headers['X-Client-Version'] = IFLOW_AONE_CLIENT_VERSION;
  }
  if (withSignature) {
    const timestamp = Date.now();
    headers['x-iflow-timestamp'] = String(timestamp);
    const sig = createIFlowSignature(IFLOW_USER_AGENT, sessionID, timestamp, apiKey);
    if (sig) headers['x-iflow-signature'] = sig;
  }
  return headers;
}

function parseNumericStatus(raw) {
  if (!raw || !raw.trim()) return 0;
  const n = parseInt(raw.trim(), 10);
  return isNaN(n) ? 0 : n;
}

function normalizeIFlowBusinessStatus(statusCode, message) {
  if (statusCode === 449) return 429;
  if (statusCode >= 400 && statusCode < 600) return statusCode;
  const msg = (message || '').toLowerCase().trim();
  if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota')) return 429;
  if (msg.includes('forbidden')) return 403;
  if (msg.includes('unauthorized') || msg.includes('invalid api key') || msg.includes('invalid token')) return 401;
  if (msg.includes('not acceptable')) return 406;
  if (msg.includes('timeout')) return 408;
  return 0;
}

function parseIFlowBusinessStatusError(data) {
  let obj;
  try {
    obj = JSON.parse(typeof data === 'string' ? data : data.toString());
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  let message = (obj.msg || obj.message || (obj.error && obj.error.message) || '').trim();
  let statusCode = 0;
  const statusRaw = obj.status;
  if (typeof statusRaw === 'number') statusCode = statusRaw;
  else if (typeof statusRaw === 'string') statusCode = parseNumericStatus(statusRaw);
  if (!statusCode && obj.error && obj.error.code) {
    statusCode = parseNumericStatus(String(obj.error.code));
  }

  const normalized = normalizeIFlowBusinessStatus(statusCode, message);
  if (normalized > 0) {
    if (!message) message = `status ${normalized}`;
    return { code: normalized, msg: message };
  }

  if (obj.error !== undefined) {
    if (!message) {
      message = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
    }
    if (!message) message = 'iflow upstream returned error payload';
    return { code: 400, msg: message };
  }
  return null;
}

function summarizeErrorBody(contentType, data) {
  if (!data || !data.length) return '';
  const text = (typeof data === 'string' ? data : data.toString()).trim();
  if ((contentType || '').toLowerCase().includes('application/json')) {
    try { JSON.parse(text); return text; } catch (_) {}
  }
  return text.length > 400 ? text.slice(0, 400) + '...' : text;
}

/**
 * Execute an HTTPS POST request to iFlow.
 * Returns a Promise<{ statusCode, headers, body: Buffer }>.
 */
function executeIFlowRequest(endpoint, apiKey, bodyBuffer, options) {
  const {
    model = '',
    traceParent = '',
    sessionID,
    conversationID,
    withSignature = true,
    timeoutMs = 180000,
    logRequestHeaders = false,
    userAgent = '',
    minimalHeaders = false,  // 辅助模型请求使用最小 headers
  } = options || {};

  // 检查是否处于暂停期
  checkPause();

  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80);

    const headers = buildIFlowHeaders(apiKey, withSignature, model, traceParent, sessionID, conversationID, userAgent, minimalHeaders);
    // 不手动设置 content-length，让 Node.js 在 req.end(body) 时自动添加
    // 这样 Content-Length 的大小写和位置与 iFlow CLI 原生行为一致

    if (logRequestHeaders) {
      console.log('[iflow] upstream request', endpoint, JSON.stringify(headers));
    }

    const reqOptions = {
      hostname: url.hostname,
      port,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers,
      // 使用持久连接 agent（keepAlive + ALPN http/1.1）
      agent: isHttps ? iflowHttpsAgent : undefined,
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        // 遇 429/403 触发暂停
        if (res.statusCode === 429 || res.statusCode === 403) {
          triggerPause(res.statusCode);
        }
        let body = Buffer.concat(chunks);
        // 解压响应（如果服务器返回压缩数据）
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (encoding === 'gzip') {
            body = zlib.gunzipSync(body);
          } else if (encoding === 'br') {
            body = zlib.brotliDecompressSync(body);
          } else if (encoding === 'deflate') {
            body = zlib.inflateSync(body);
          }
        } catch (decompressErr) {
          // 解压失败，返回原始数据
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`upstream request timeout after ${timeoutMs}ms`));
      });
    }
    // 单次调用：headers + body 尽量在同一 TCP 包发出，与 iFlow CLI 行为一致
    req.end(bodyBuffer);
  });
}

/**
 * Execute an HTTPS POST request to iFlow, returning the raw http.IncomingMessage
 * (for streaming). Caller is responsible for consuming/closing the response.
 */
function executeIFlowRequestStream(endpoint, apiKey, bodyBuffer, options) {
  const {
    model = '',
    traceParent = '',
    sessionID,
    conversationID,
    withSignature = true,
    timeoutMs = 180000,
    logRequestHeaders = false,
    userAgent = '',
    minimalHeaders = false,  // 辅助模型请求使用最小 headers
  } = options || {};

  // 检查是否处于暂停期
  checkPause();

  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80);

    const headers = buildIFlowHeaders(apiKey, withSignature, model, traceParent, sessionID, conversationID, userAgent, minimalHeaders);

    if (logRequestHeaders) {
      console.log('[iflow] upstream stream request', endpoint, JSON.stringify(headers));
    }

    const reqOptions = {
      hostname: url.hostname,
      port,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers,
      agent: isHttps ? iflowHttpsAgent : undefined,
    };

    const req = lib.request(reqOptions, (res) => {
      // 遇 429/403 触发暂停
      if (res.statusCode === 429 || res.statusCode === 403) {
        triggerPause(res.statusCode);
      }
      resolve(res);
    });
    req.on('error', reject);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`upstream request timeout after ${timeoutMs}ms`));
      });
    }
    req.end(bodyBuffer);
  });
}

module.exports = {
  randomUUID,
  requestIDs,
  parseIFlowBusinessStatusError,
  summarizeErrorBody,
  executeIFlowRequest,
  executeIFlowRequestStream,
  getPauseInfo,
};
