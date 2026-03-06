'use strict';

const zlib = require('zlib');
const { requestIDs, parseIFlowBusinessStatusError, summarizeErrorBody, executeIFlowRequest, executeIFlowRequestStream } = require('./iflow.js');
const { convertAnthropicToOpenAI, convertOpenAIToAnthropic, writeAnthropicSSE, writeAnthropicSSEError, estimateInputTokens } = require('./anthropic.js');
const { maybeApplyMultimodalBridge } = require('./multimodal.js');
const { AcpClient, messagesToPrompt, detectAcpServer } = require('./acp.js');

// ─── 敏感词混淆 ──────────────────────────────────────────────────────────────

// 不可见字符集（用于混淆）
const INVISIBLE_CHARS = [
  '\u200B', // 零宽空格 (ZWSP)
  '\u200C', // 零宽非连接符 (ZWNJ)
  '\u200D', // 零宽连接符 (ZWJ)
  '\u2060', // 字连接符 (WJ)
  '\uFEFF', // 字节顺序标记 (BOM)
];

// 同形字替换表（视觉相似但 Unicode 不同）
const HOMOGLYPHS = {
  'a': ['а', 'ạ', 'ą'], // 西里尔字母 a, 带下点 a
  'A': ['А', 'Α', 'Ạ'], // 西里尔字母 A, 希腊 Alpha
  'c': ['с', 'ç', 'ć'], // 西里尔字母 c
  'C': ['С', 'Ç', 'Ć'], // 西里尔字母 C
  'e': ['е', 'ẹ', 'ę'], // 西里尔字母 e
  'E': ['Е', 'Ε', 'Ẹ'], // 西里尔字母 E, 希腊 Epsilon
  'o': ['о', 'ọ', 'ö'], // 西里尔字母 o
  'O': ['О', 'Ο', 'Ọ'], // 西里尔字母 O, 希腊 Omicron
  'p': ['р', 'р'], // 西里尔字母 p
  'P': ['Р', 'Ρ'], // 西里尔字母 P, 希腊 Rho
  'x': ['х', 'х'], // 西里尔字母 x
  'X': ['Х', 'Χ'], // 西里尔字母 X, 希腊 Chi
  'y': ['у', 'у'], // 西里尔字母 y
  'Y': ['У', 'Υ'], // 西里尔字母 Y, 希兰 Upsilon
  'i': ['і', 'ị', 'ı'], // 西里尔字母 i
  'I': ['І', 'Ι', 'İ'], // 西里尔字母 I, 希腊 Iota
  'l': ['ⅼ', 'ⅼ'], // 罗马数字 l
  'L': ['Ⅼ', 'Ⅼ'], // 罗马数字 L
};

/**
 * 高级敏感词混淆
 * 策略：
 * 1. 随机选择多个位置插入不可见字符
 * 2. 随机使用不同类型的不可见字符
 * 3. 对部分字符使用同形字替换
 * 4. 每次调用结果不同，增加检测难度
 */
function obfuscateWord(word) {
  if (word.length < 2) return word;

  const chars = word.split('');
  const result = [];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const lowerChar = char.toLowerCase();
    let obfuscated = char;

    // 策略1：30% 概率使用同形字替换
    if (Math.random() < 0.3 && HOMOGLYPHS[lowerChar]) {
      const variants = HOMOGLYPHS[lowerChar];
      const variant = variants[Math.floor(Math.random() * variants.length)];
      // 保持大小写
      obfuscated = char === lowerChar ? variant : variant.toUpperCase();
    }

    result.push(obfuscated);

    // 策略2：50% 概率在字符后插入不可见字符
    if (Math.random() < 0.5 && i < chars.length - 1) {
      const invisible = INVISIBLE_CHARS[Math.floor(Math.random() * INVISIBLE_CHARS.length)];
      result.push(invisible);
    }
  }

  // 策略3：50% 概率在开头插入不可见字符
  if (Math.random() < 0.5) {
    const invisible = INVISIBLE_CHARS[Math.floor(Math.random() * INVISIBLE_CHARS.length)];
    result.unshift(invisible);
  }

  return result.join('');
}

function obfuscateBody(bodyBuffer, sensitiveWords) {
  if (!sensitiveWords || sensitiveWords.length === 0) return bodyBuffer;
  let text = bodyBuffer.toString();

  for (const word of sensitiveWords) {
    if (!word || word.length < 2) continue;
    // 使用函数进行替换，每次调用结果不同
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), m => obfuscateWord(m));
  }

  return Buffer.from(text);
}

// ─── Round-robin ──────────────────────────────────────────────────────────────
let upstreamCursor = 0;
function pickRoundRobin(upstreams) {
  if (upstreams.length === 1) return { upstream: upstreams[0], idx: 0 };
  const idx = upstreamCursor++ % upstreams.length;
  return { upstream: upstreams[idx], idx };
}

// ─── EMA fastest ──────────────────────────────────────────────────────────────
const upstreamStats = []; // { ema: number, count: number }[]
let probeCounter = 0;
const PROBE_INTERVAL = 20; // 每20次请求探测一次非最优上游

function ensureStats(n) {
  while (upstreamStats.length < n) upstreamStats.push({ ema: 0, count: 0 });
}

function pickFastest(upstreams, excludeIdx = -1) {
  if (upstreams.length === 1) return { upstream: upstreams[0], idx: 0 };
  ensureStats(upstreams.length);

  // 正常选最快
  let bestIdx = -1, bestEma = Infinity;
  for (let i = 0; i < upstreams.length; i++) {
    if (i === excludeIdx) continue;
    const ema = upstreamStats[i].count === 0 ? 0 : upstreamStats[i].ema;
    if (ema < bestEma) { bestEma = ema; bestIdx = i; }
  }
  if (bestIdx < 0) bestIdx = excludeIdx === 0 ? 1 : 0;

  // 探测：每 PROBE_INTERVAL 次，强制选数据最陈旧的非最优上游
  if (excludeIdx < 0 && ++probeCounter % PROBE_INTERVAL === 0) {
    let staleIdx = -1, minCount = Infinity;
    for (let i = 0; i < upstreams.length; i++) {
      if (i === bestIdx) continue;
      if (upstreamStats[i].count < minCount) { minCount = upstreamStats[i].count; staleIdx = i; }
    }
    if (staleIdx >= 0) return { upstream: upstreams[staleIdx], idx: staleIdx };
  }

  return { upstream: upstreams[bestIdx], idx: bestIdx };
}

function recordLatency(idx, ms) {
  ensureStats(idx + 1);
  const s = upstreamStats[idx];
  s.ema = s.count === 0 ? ms : 0.2 * ms + 0.8 * s.ema;
  s.count++;
}

let runtimeStrategy = null; // null = 使用 cfg.upstreamStrategy

/**
 * 解析模型名称，提取 provider 和实际模型名
 * @param {string} modelName - 模型名称，可能包含 provider 前缀
 * @param {Array} upstreams - upstream 列表
 * @returns {{ model: string, upstream: object|null, idx: number }}
 */
function parseModelWithProvider(modelName, upstreams) {
  if (!modelName) return { model: modelName, upstream: null, idx: -1 };

  // 格式: provider/model
  const slashIdx = modelName.indexOf('/');
  if (slashIdx > 0) {
    const provider = modelName.slice(0, slashIdx);
    const model = modelName.slice(slashIdx + 1);
    const foundIdx = upstreams.findIndex(u =>
      u.name.toLowerCase() === provider.toLowerCase()
    );
    if (foundIdx >= 0) {
      return { model, upstream: upstreams[foundIdx], idx: foundIdx };
    }
  }

  // 无 provider 前缀
  return { model: modelName, upstream: null, idx: -1 };
}

function pickUpstream(cfg, options = {}) {
  const { specifiedUpstream, specifiedIdx, model } = options;

  // 优先级1: 模型名称指定了 provider (如 iFlow/glm-5)
  if (specifiedUpstream) {
    return { upstream: specifiedUpstream, idx: specifiedIdx };
  }

  // 优先级2: 策略选择
  const strategy = runtimeStrategy || cfg.upstreamStrategy;

  // fixed 策略：使用指定的 provider
  if (strategy === 'fixed') {
    return pickFixed(cfg.upstreams, cfg.defaultModelProvider, model);
  }

  if (strategy === 'roundrobin') return pickRoundRobin(cfg.upstreams);
  return pickFastest(cfg.upstreams);
}

function pickFixed(upstreams, defaultProvider, model) {
  // 找到指定 provider 的 upstream
  if (defaultProvider) {
    const idx = upstreams.findIndex(u =>
      u.name.toLowerCase() === defaultProvider.toLowerCase() && u.enabled !== false
    );
    if (idx >= 0) {
      return { upstream: upstreams[idx], idx };
    }
  }

  // 没有指定 provider 或找不到，使用第一个启用的
  const enabled = upstreams.filter(u => u.enabled !== false);
  if (enabled.length === 0) return { upstream: null, idx: -1 };
  return { upstream: enabled[0], idx: upstreams.indexOf(enabled[0]) };
}

function pickPriority(upstreams) {
  // 只使用第一个启用的 upstream
  const enabled = upstreams.filter(u => u.enabled !== false);
  if (enabled.length === 0) return { upstream: null, idx: -1 };
  return { upstream: enabled[0], idx: upstreams.indexOf(enabled[0]) };
}

function handleAdminStrategy(cfg, req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let obj;
    try { obj = JSON.parse(body); } catch (_) { writeError(res, 400, 'invalid JSON'); return; }
    const s = (obj.strategy || '').trim();
    if (s !== 'fastest' && s !== 'roundrobin' && s !== 'fixed') {
      writeError(res, 400, 'strategy must be "fastest", "roundrobin" or "fixed"'); return;
    }
    runtimeStrategy = s;
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ strategy: runtimeStrategy }));
  });
}

function writeError(res, code, message) {
  if (code < 400 || code > 599) code = 502;
  if (!message) message = `status ${code}`;
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(code);
  res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
}

function writeAnthropicError(res, code, message) {
  if (code < 400 || code > 599) code = 502;
  if (!message) message = `status ${code}`;
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(code);
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
}

function writeSSEError(res, code, message) {
  if (code < 400 || code > 599) code = 502;
  if (!message) message = `status ${code}`;
  const payload = `data: {"error":{"message":${JSON.stringify(message)},"type":"server_error","code":"internal_server_error"}}\n\n`;
  res.write(payload);
}

function copySelectedHeaders(res, upstreamHeaders) {
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const lk = key.toLowerCase().trim();
    if (lk === 'content-type' || lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
    if (lk.startsWith('x-') || lk.startsWith('request-') || lk === 'server') {
      res.setHeader(key, value);
    }
  }
}

async function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes + 1) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function synthesizeOpenAIStreamChunks(data) {
  let obj;
  try { obj = JSON.parse(data); } catch (_) { return []; }
  if (!obj.choices || !Array.isArray(obj.choices) || obj.choices.length === 0) return [];

  const chunk = {
    id: obj.id || '',
    object: 'chat.completion.chunk',
    created: obj.created || 0,
    model: obj.model || '',
    choices: [],
  };

  for (let i = 0; i < obj.choices.length; i++) {
    const choice = obj.choices[i];
    const index = choice.index != null ? choice.index : i;
    const streamChoice = { index, delta: {}, finish_reason: null };

    const role = (choice.message && choice.message.role || '').trim();
    if (role) streamChoice.delta.role = role;

    const content = choice.message && choice.message.content;
    if (content != null) streamChoice.delta.content = content;

    const reasoning = choice.message && choice.message.reasoning_content;
    if (reasoning != null) streamChoice.delta.reasoning_content = reasoning;

    const toolCalls = choice.message && choice.message.tool_calls;
    if (toolCalls != null) streamChoice.delta.tool_calls = toolCalls;

    if (choice.finish_reason != null) streamChoice.finish_reason = choice.finish_reason;
    chunk.choices.push(streamChoice);
  }

  const out = [Buffer.from(JSON.stringify(chunk))];

  if (obj.usage != null) {
    const usageChunk = {
      id: obj.id || '',
      object: 'chat.completion.chunk',
      created: obj.created || 0,
      model: obj.model || '',
      choices: [],
      usage: obj.usage,
    };
    out.push(Buffer.from(JSON.stringify(usageChunk)));
  }
  return out;
}

function parseOpenAIStreamNetworkError(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let payload = trimmed;
  if (payload.startsWith('data:')) payload = payload.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;

  let obj;
  try { obj = JSON.parse(payload); } catch (_) { return null; }
  if (!obj.choices || !Array.isArray(obj.choices) || obj.choices.length === 0) return null;

  let hasNetworkError = false;
  let hasContent = false;
  for (const choice of obj.choices) {
    if ((choice.finish_reason || '').toLowerCase() === 'network_error') hasNetworkError = true;
    const delta = choice.delta || {};
    const content = (delta.content || '').trim();
    const reasoning = (delta.reasoning_content || '').trim();
    const toolCalls = delta.tool_calls;
    if (content || reasoning || (toolCalls && JSON.stringify(toolCalls) !== '[]')) hasContent = true;
  }

  if (!hasNetworkError || hasContent) return null;
  const model = (obj.model || 'unknown').trim();
  return { code: 502, msg: `iflow upstream stream network_error for model ${model}` };
}

// ─── ACP Mode Handler ──────────────────────────────────────────────────────────

// ACP 客户端池（复用连接）
let acpClientPool = null;

async function getAcpClient(cfg) {
  if (acpClientPool && acpClientPool.isConnected()) {
    return acpClientPool;
  }

  const client = new AcpClient({
    port: cfg.acp.port,
    timeout: cfg.acp.timeout,
    debug: cfg.acp.debug,
  });

  await client.connect();
  acpClientPool = client;
  return client;
}

/**
 * 检查是否应该使用 ACP 模式
 * @param {object} cfg - 配置
 * @returns {Promise<boolean>}
 * @throws {Error} 如果 ACP 启用但 iFlow CLI 不可用
 */
async function shouldUseAcp(cfg) {
  if (!cfg.acp.enabled) return false;

  // 检测 iFlow CLI 是否运行
  const available = await detectAcpServer(cfg.acp.port, 2000);
  if (!available) {
    throw new Error(`ACP mode enabled but iFlow CLI not running on port ${cfg.acp.port}. Start with: iflow --experimental-acp --port ${cfg.acp.port}`);
  }

  return true;
}

/**
 * 使用 ACP 模式处理 OpenAI 格式请求
 * @param {object} cfg - 配置
 * @param {object} bodyObj - OpenAI 格式请求体
 * @param {boolean} stream - 是否流式响应
 * @param {http.ServerResponse} res - 响应对象
 */
async function handleOpenAICompletionsViaAcp(cfg, bodyObj, stream, res) {
  const model = bodyObj.model || cfg.defaultModel || 'glm-5';
  const messages = bodyObj.messages || [];

  if (messages.length === 0) {
    writeError(res, 400, 'messages is required');
    return;
  }

  try {
    const client = await getAcpClient(cfg);

    // 创建 session
    await client.createSession({ model });

    if (stream) {
      // 流式响应
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.writeHead(200);

      const completionId = `acp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      // 发送初始角色
      const roleChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

      // 发送 prompt 并收集流式响应
      const prompt = messagesToPrompt(messages);
      let fullContent = '';

      await client.prompt(prompt, {
        model,
        onChunk: (chunk) => {
          fullContent += chunk;
          const contentChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
        },
      });

      // 发送结束
      const finishChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // 非流式响应
      const prompt = messagesToPrompt(messages);
      const result = await client.prompt(prompt, { model });

      const completionId = `acp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      const response = {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.text },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(response));
    }
  } catch (err) {
    console.error('[acp] error:', err.message);
    if (!res.headersSent) {
      writeError(res, 502, `ACP error: ${err.message}`);
    } else {
      writeSSEError(res, 502, `ACP error: ${err.message}`);
      res.end();
    }
  }
}

/**
 * 使用 ACP 模式处理 Anthropic 格式请求
 * @param {object} cfg - 配置
 * @param {object} bodyObj - Anthropic 格式请求体
 * @param {boolean} stream - 是否流式响应
 * @param {http.ServerResponse} res - 响应对象
 */
async function handleAnthropicMessagesViaAcp(cfg, bodyObj, stream, res) {
  let openAIBody, model;
  try {
    const result = convertAnthropicToOpenAI(bodyObj, cfg.defaultModel);
    openAIBody = result.body;
    model = result.model;
  } catch (err) {
    if (stream) {
      writeAnthropicSSEError(res, 400, err.message);
      return;
    }
    writeAnthropicError(res, 400, err.message);
    return;
  }

  const messages = openAIBody.messages || [];

  if (messages.length === 0) {
    if (stream) {
      writeAnthropicSSEError(res, 400, 'messages is required');
      return;
    }
    writeAnthropicError(res, 400, 'messages is required');
    return;
  }

  try {
    const client = await getAcpClient(cfg);

    // 创建 session
    await client.createSession({ model });

    if (stream) {
      // 流式响应
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.writeHead(200);

      const messageId = `msg_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

      // 发送 message_start 事件
      writeAnthropicEvent(res, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      // 发送 content_block_start
      writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });

      // 发送 prompt 并收集流式响应
      const prompt = messagesToPrompt(messages);
      let fullContent = '';

      await client.prompt(prompt, {
        model,
        onChunk: (chunk) => {
          fullContent += chunk;
          // 发送 text_delta 事件
          writeAnthropicEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: chunk },
          });
        },
      });

      // 发送 content_block_stop
      writeAnthropicEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      });

      // 发送 message_delta
      writeAnthropicEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      });

      // 发送 message_stop
      writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' });
      res.end();
    } else {
      // 非流式响应
      const prompt = messagesToPrompt(messages);
      const result = await client.prompt(prompt, { model });

      // 构建 Anthropic 格式响应
      const anthropicResp = {
        id: `msg_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: result.text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      };

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(anthropicResp));
    }
  } catch (err) {
    console.error('[acp] error:', err.message);
    if (!res.headersSent) {
      if (stream) {
        writeAnthropicSSEError(res, 502, `ACP error: ${err.message}`);
      } else {
        writeAnthropicError(res, 502, `ACP error: ${err.message}`);
      }
    } else {
      writeAnthropicEvent(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message: `ACP error: ${err.message}` },
      });
      res.end();
    }
  }
}

/**
 * 写入 Anthropic SSE 事件
 */
function writeAnthropicEvent(res, eventName, payload) {
  const body = JSON.stringify(payload);
  res.write(`event: ${eventName}\ndata: ${body}\n\n`);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleHealth(req, res) {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end('{"status":"ok"}');
}

async function handleAcpHealth(cfg, req, res) {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  const acpEnabled = cfg.acp.enabled;
  let acpAvailable = false;
  let acpConnected = false;

  if (acpEnabled) {
    try {
      acpAvailable = await detectAcpServer(cfg.acp.port, 2000);
      if (acpClientPool && acpClientPool.isConnected()) {
        acpConnected = true;
      }
    } catch (err) {
      console.error('[acp] health check error:', err.message);
    }
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({
    status: 'ok',
    acp: {
      enabled: acpEnabled,
      available: acpAvailable,
      connected: acpConnected,
      port: cfg.acp.port,
    },
  }, null, 2));
}

function handleModels(cfg, req, res) {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  const data = cfg.models
    .map(m => m.trim()).filter(Boolean)
    .map(m => ({ id: m, object: 'model', created: 0, owned_by: 'aigw' }));
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ object: 'list', data }));
}

/**
 * 从上游获取可用模型列表
 * @param {object} cfg - 配置
 * @param {http.ServerResponse} res - 响应对象
 */
async function handleUpstreamModels(cfg, res) {
  const https = require('https');
  const http = require('http');
  const { URL } = require('url');

  // 收集所有上游的模型
  const allModels = [];
  const errors = [];

  for (let i = 0; i < cfg.upstreams.length; i++) {
    const upstream = cfg.upstreams[i];
    // 【修改】使用配置的 name
    const upstreamName = upstream.name;

    try {
      const models = await new Promise((resolve, reject) => {
        const url = new URL(upstream.url + '/models');
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const headers = {
          'authorization': `Bearer ${upstream.key}`,
          'user-agent': 'iFlow-Cli',
          'accept': '*/*',
        };

        const req = lib.request({
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'GET',
          headers,
          agent: isHttps ? new https.Agent({
            keepAlive: true,
            ALPNProtocols: ['http/1.1'],
          }) : undefined,
        }, (upstreamRes) => {
          let data = '';
          upstreamRes.on('data', chunk => data += chunk);
          upstreamRes.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.data && Array.isArray(json.data)) {
                resolve(json.data.map(m => ({
                  ...m,
                  upstream: upstreamName,
                  upstream_url: upstream.url,
                  alias: `${upstreamName}/${m.id}`,
                })));
              } else {
                resolve([]);
              }
            } catch (e) {
              resolve([]);
            }
          });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
        req.end();
      });

      // 如果 API 返回了模型，使用它们
      if (models.length > 0) {
        allModels.push(...models);
      } else if (upstream.models && upstream.models.length > 0) {
        // API 没有返回模型，使用配置的模型列表
        for (const modelId of upstream.models) {
          allModels.push({
            id: modelId,
            object: 'model',
            created: 0,
            owned_by: upstreamName,
            upstream: upstreamName,
            upstream_url: upstream.url,
            alias: `${upstreamName}/${modelId}`,
          });
        }
      }
    } catch (err) {
      // API 请求失败，尝试使用配置的模型列表
      if (upstream.models && upstream.models.length > 0) {
        for (const modelId of upstream.models) {
          allModels.push({
            id: modelId,
            object: 'model',
            created: 0,
            owned_by: upstreamName,
            upstream: upstreamName,
            upstream_url: upstream.url,
            alias: `${upstreamName}/${modelId}`,
          });
        }
      } else {
        errors.push({ upstream: upstreamName, error: err.message });
      }
    }
  }

  // 去重（相同 id 的模型保留第一个出现的）
  const seen = new Set();
  const uniqueModels = allModels.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({
    object: 'list',
    data: uniqueModels,
    errors: errors.length > 0 ? errors : undefined,
    total: uniqueModels.length,
  }, null, 2));
}

function handleModelByID(cfg, req, res, id) {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  id = (id || '').trim();
  if (!id) { writeError(res, 404, 'model not found'); return; }
  const found = cfg.models.find(m => m.trim().toLowerCase() === id.toLowerCase());
  if (!found) { writeError(res, 404, 'model not found'); return; }
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ id: found.trim(), object: 'model', created: 0, owned_by: 'aigw' }));
}

async function handleOpenAICompletions(cfg, req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let rawBody;
  try { rawBody = await readBody(req, cfg.maxBodyBytes); }
  catch (err) {
    if (err.message === 'request body too large') { writeError(res, 413, 'request body too large'); return; }
    writeError(res, 400, `read request body failed: ${err.message}`); return;
  }
  if (rawBody.length > cfg.maxBodyBytes) { writeError(res, 413, 'request body too large'); return; }

  let bodyObj;
  try { bodyObj = JSON.parse(rawBody); } catch (_) { writeError(res, 400, 'invalid JSON body'); return; }

  const stream = !!bodyObj.stream;
  let model = (bodyObj.model || '').trim();

  // 【新增】解析模型名称中的 provider
  const { model: resolvedModel, upstream: specifiedUpstream, idx: specifiedIdx } =
    parseModelWithProvider(model, cfg.upstreams);

  if (resolvedModel !== model) {
    model = resolvedModel;
    bodyObj.model = model;
    rawBody = Buffer.from(JSON.stringify(bodyObj));
  }

  if (!model && cfg.defaultModel) {
    model = cfg.defaultModel;
    bodyObj.model = model;
    rawBody = Buffer.from(JSON.stringify(bodyObj));
  }
  if (!model) { writeError(res, 400, 'model is required'); return; }

  // 检查是否使用 ACP 模式
  try {
    if (await shouldUseAcp(cfg)) {
      console.log('[server] using ACP mode (via iFlow CLI)');
      return handleOpenAICompletionsViaAcp(cfg, bodyObj, stream, res);
    }
  } catch (err) {
    // ACP 启用但 iFlow CLI 不可用，返回错误
    writeError(res, 503, err.message);
    return;
  }

  // 以下是原来的 HTTP 模式
  // 【修改】传入指定的 upstream 和 model
  const { upstream, idx } = pickUpstream(cfg, {
    specifiedUpstream,
    specifiedIdx,
    model
  });
  const endpoint = upstream.url + '/chat/completions';
  const { sessionID, conversationID } = requestIDs(bodyObj);
  const traceParent = (req.headers['traceparent'] || '').trim();

  const iflowOpts = {
    model, traceParent, sessionID, conversationID,
    withSignature: upstream.sign,
    timeoutMs: cfg.requestTimeoutMs,
    logRequestHeaders: cfg.logRequestHeaders,
  };

  rawBody = obfuscateBody(rawBody, cfg.sensitiveWords);

  if (stream) {
    const t0 = Date.now();
    let upstreamRes, activeIdx = idx;
    try { upstreamRes = await executeIFlowRequestStream(endpoint, upstream.key, rawBody, iflowOpts); }
    catch (err) {
      const { upstream: u2, idx: idx2 } = pickFastest(cfg.upstreams, idx);
      if (idx2 !== idx) {
        try {
          upstreamRes = await executeIFlowRequestStream(u2.url + '/chat/completions', u2.key, rawBody, { ...iflowOpts, withSignature: u2.sign });
          activeIdx = idx2;
        } catch (err2) { writeError(res, 502, err2.message); return; }
      } else { writeError(res, 502, err.message); return; }
    }

    if (cfg.logResponseHeaders) console.log('[server] upstream response', upstreamRes.statusCode, upstreamRes.headers);

    // 5xx 且响应头未发出，尝试切换上游
    if (upstreamRes.statusCode >= 500) {
      const { upstream: u2, idx: idx2 } = pickFastest(cfg.upstreams, activeIdx);
      if (idx2 !== activeIdx) {
        try {
          const r2 = await executeIFlowRequestStream(u2.url + '/chat/completions', u2.key, rawBody, { ...iflowOpts, withSignature: u2.sign });
          if (r2.statusCode < 500) { upstreamRes = r2; activeIdx = idx2; }
        } catch (_) {}
      }
    }

    if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
      const chunks = [];
      const errEncoding = (upstreamRes.headers['content-encoding'] || '').toLowerCase();
      let errStream = upstreamRes;
      if (errEncoding === 'gzip') {
        errStream = upstreamRes.pipe(zlib.createGunzip());
      } else if (errEncoding === 'br') {
        errStream = upstreamRes.pipe(zlib.createBrotliDecompress());
      } else if (errEncoding === 'deflate') {
        errStream = upstreamRes.pipe(zlib.createInflate());
      }
      errStream.on('data', c => chunks.push(c));
      errStream.on('end', () => {
        const data = Buffer.concat(chunks);
        let code = upstreamRes.statusCode;
        let msg = summarizeErrorBody(upstreamRes.headers['content-type'], data);
        const bizErr = parseIFlowBusinessStatusError(data);
        if (bizErr) { code = bizErr.code; msg = bizErr.msg; }
        writeError(res, code, msg);
      });
      return;
    }

    recordLatency(activeIdx, Date.now() - t0);
    const ct = (upstreamRes.headers['content-type'] || '').toLowerCase();
    const encoding = (upstreamRes.headers['content-encoding'] || '').toLowerCase();

    // 创建解压流（如果需要）
    let stream = upstreamRes;
    if (encoding === 'gzip') {
      stream = upstreamRes.pipe(zlib.createGunzip());
    } else if (encoding === 'br') {
      stream = upstreamRes.pipe(zlib.createBrotliDecompress());
    } else if (encoding === 'deflate') {
      stream = upstreamRes.pipe(zlib.createInflate());
    }

    copySelectedHeaders(res, upstreamRes.headers);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // 移除 content-encoding，因为已经解压
    res.removeHeader('Content-Encoding');
    res.writeHead(200);

    if (!ct.includes('text/event-stream')) {
      // Non-SSE upstream: buffer and synthesize
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        const bizErr = parseIFlowBusinessStatusError(data);
        if (bizErr) { writeSSEError(res, bizErr.code, bizErr.msg); res.end(); return; }
        const synth = synthesizeOpenAIStreamChunks(data);
        if (synth.length === 0) { writeSSEError(res, 502, 'upstream returned non-SSE payload without choices'); res.end(); return; }
        for (const chunk of synth) { res.write(`data: ${chunk}\n\n`); }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }

    // SSE passthrough with heartbeat
    const heartbeat = cfg.emitHeartbeatComments
      ? setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, cfg.streamHeartbeatMs)
      : null;

    let sawDone = false;
    let buffer = '';

    stream.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === 'data: [DONE]' || trimmed === '[DONE]') sawDone = true;
        const netErr = parseOpenAIStreamNetworkError(trimmed);
        if (netErr) {
          if (heartbeat) clearInterval(heartbeat);
          writeSSEError(res, netErr.code, netErr.msg);
          res.end();
          stream.destroy();
          return;
        }
        res.write(line + '\n');
      }
    });

    stream.on('end', () => {
      if (heartbeat) clearInterval(heartbeat);
      if (buffer) res.write(buffer);
      if (!sawDone) res.write('data: [DONE]\n\n');
      res.end();
    });

    stream.on('error', err => {
      if (heartbeat) clearInterval(heartbeat);
      writeSSEError(res, 502, `read upstream stream failed: ${err.message}`);
      res.end();
    });

    req.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      upstreamRes.destroy();
    });

    return;
  }

  // Non-stream
  const t0ns = Date.now();
  let upstreamResp, activeIdxNs = idx;
  try { upstreamResp = await executeIFlowRequest(endpoint, upstream.key, rawBody, iflowOpts); }
  catch (err) {
    const { upstream: u2, idx: idx2 } = pickFastest(cfg.upstreams, idx);
    if (idx2 !== idx) {
      try {
        upstreamResp = await executeIFlowRequest(u2.url + '/chat/completions', u2.key, rawBody, { ...iflowOpts, withSignature: u2.sign });
        activeIdxNs = idx2;
      } catch (err2) { writeError(res, 502, err2.message); return; }
    } else { writeError(res, 502, err.message); return; }
  }

  if (cfg.logResponseHeaders) console.log('[server] upstream response', upstreamResp.statusCode, upstreamResp.headers);

  if (upstreamResp.statusCode >= 500) {
    const { upstream: u2, idx: idx2 } = pickFastest(cfg.upstreams, activeIdxNs);
    if (idx2 !== activeIdxNs) {
      try {
        const r2 = await executeIFlowRequest(u2.url + '/chat/completions', u2.key, rawBody, { ...iflowOpts, withSignature: u2.sign });
        if (r2.statusCode < 500) { upstreamResp = r2; activeIdxNs = idx2; }
      } catch (_) {}
    }
  }

  recordLatency(activeIdxNs, Date.now() - t0ns);

  if (upstreamResp.statusCode < 200 || upstreamResp.statusCode >= 300) {
    let code = upstreamResp.statusCode;
    let msg = summarizeErrorBody(upstreamResp.headers['content-type'], upstreamResp.body);
    const bizErr = parseIFlowBusinessStatusError(upstreamResp.body);
    if (bizErr) { code = bizErr.code; msg = bizErr.msg; }
    writeError(res, code, msg); return;
  }

  const bizErr = parseIFlowBusinessStatusError(upstreamResp.body);
  if (bizErr) { writeError(res, bizErr.code, bizErr.msg); return; }

  copySelectedHeaders(res, upstreamResp.headers);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(upstreamResp.body);
}

async function handleAnthropicMessages(cfg, req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let rawBody;
  try { rawBody = await readBody(req, cfg.maxBodyBytes); }
  catch (err) {
    if (err.message === 'request body too large') { writeAnthropicError(res, 413, 'request body too large'); return; }
    writeAnthropicError(res, 400, `read request body failed: ${err.message}`); return;
  }
  if (rawBody.length > cfg.maxBodyBytes) { writeAnthropicError(res, 413, 'request body too large'); return; }

  let bodyObj;
  try { bodyObj = JSON.parse(rawBody); } catch (_) { writeAnthropicError(res, 400, 'invalid JSON body'); return; }

  const stream = !!bodyObj.stream;

  // 检查是否使用 ACP 模式
  try {
    if (await shouldUseAcp(cfg)) {
      console.log('[server] using ACP mode for Anthropic endpoint (via iFlow CLI)');
      return handleAnthropicMessagesViaAcp(cfg, bodyObj, stream, res);
    }
  } catch (err) {
    // ACP 启用但 iFlow CLI 不可用，返回错误
    if (stream) {
      writeAnthropicSSEError(res, 503, err.message);
    } else {
      writeAnthropicError(res, 503, err.message);
    }
    return;
  }

  // 以下是原来的 HTTP 模式
  let openAIBody, model;
  try {
    const result = convertAnthropicToOpenAI(bodyObj, cfg.defaultModel);
    openAIBody = result.body;
    model = result.model;
  } catch (err) {
    if (stream) { writeAnthropicSSEError(res, 400, err.message); return; }
    writeAnthropicError(res, 400, err.message); return;
  }

  // 【新增】解析模型名称中的 provider
  const { model: resolvedModel, upstream: specifiedUpstream, idx: specifiedIdx } =
    parseModelWithProvider(model, cfg.upstreams);

  if (resolvedModel !== model) {
    model = resolvedModel;
    openAIBody.model = model;
  }

  // 【修改】传入指定的 upstream 和 model
  const { upstream, idx } = pickUpstream(cfg, {
    specifiedUpstream,
    specifiedIdx,
    model
  });
  const endpoint = upstream.url + '/chat/completions';
  const { sessionID, conversationID } = requestIDs(openAIBody);
  const traceParent = (req.headers['traceparent'] || '').trim();

  const iflowOpts = {
    model, traceParent, sessionID, conversationID,
    withSignature: upstream.sign,
    timeoutMs: cfg.requestTimeoutMs,
    logRequestHeaders: cfg.logRequestHeaders,
  };

  // Apply multimodal bridge if enabled
  let openAIBodyBuffer = Buffer.from(JSON.stringify(openAIBody));
  try {
    // 【修改】解析 extractorModel 中的 provider
    const { model: extractorModel, upstream: extractorUpstream, idx: extractorIdx } =
      parseModelWithProvider(cfg.multimodal.extractorModel, cfg.upstreams);

    // 选择 extractor 的 upstream
    const ext = extractorUpstream ||
      cfg.upstreams.find(u => u.isIFlow) ||
      cfg.upstreams[0];
    const extractorEndpoint = ext.url + '/chat/completions';
    const extractorOpts = { ...iflowOpts, withSignature: ext.sign };

    openAIBodyBuffer = await maybeApplyMultimodalBridge(
      openAIBodyBuffer, cfg.multimodal, extractorEndpoint, ext.key,
      extractorModel,  // 使用解析后的模型名
      extractorOpts
    );
  } catch (err) {
    console.warn('[multimodal] bridge error:', err.message);
  }

  openAIBodyBuffer = obfuscateBody(openAIBodyBuffer, cfg.sensitiveWords);

  // Always request non-streaming upstream for Anthropic endpoint
  const t0a = Date.now();
  let upstreamResp, activeIdxA = idx;
  try { upstreamResp = await executeIFlowRequest(endpoint, upstream.key, openAIBodyBuffer, iflowOpts); }
  catch (err) {
    const { upstream: u2, idx: idx2 } = pickFastest(cfg.upstreams, idx);
    if (idx2 !== idx) {
      try {
        upstreamResp = await executeIFlowRequest(u2.url + '/chat/completions', u2.key, openAIBodyBuffer, { ...iflowOpts, withSignature: u2.sign });
        activeIdxA = idx2;
      } catch (err2) {
        if (stream) { writeAnthropicSSEError(res, 502, err2.message); return; }
        writeAnthropicError(res, 502, err2.message); return;
      }
    } else {
      if (stream) { writeAnthropicSSEError(res, 502, err.message); return; }
      writeAnthropicError(res, 502, err.message); return;
    }
  }

  if (cfg.logResponseHeaders) console.log('[server] upstream response', upstreamResp.statusCode, upstreamResp.headers);

  if (upstreamResp.statusCode >= 500) {
    const { upstream: u2, idx: idx2 } = pickFastest(cfg.upstreams, activeIdxA);
    if (idx2 !== activeIdxA) {
      try {
        const r2 = await executeIFlowRequest(u2.url + '/chat/completions', u2.key, openAIBodyBuffer, { ...iflowOpts, withSignature: u2.sign });
        if (r2.statusCode < 500) { upstreamResp = r2; activeIdxA = idx2; }
      } catch (_) {}
    }
  }

  recordLatency(activeIdxA, Date.now() - t0a);

  if (upstreamResp.statusCode < 200 || upstreamResp.statusCode >= 300) {
    let code = upstreamResp.statusCode;
    let msg = summarizeErrorBody(upstreamResp.headers['content-type'], upstreamResp.body);
    const bizErr = parseIFlowBusinessStatusError(upstreamResp.body);
    if (bizErr) { code = bizErr.code; msg = bizErr.msg; }
    if (stream) { writeAnthropicSSEError(res, code, msg); return; }
    writeAnthropicError(res, code, msg); return;
  }

  const bizErr = parseIFlowBusinessStatusError(upstreamResp.body);
  if (bizErr) {
    if (stream) { writeAnthropicSSEError(res, bizErr.code, bizErr.msg); return; }
    writeAnthropicError(res, bizErr.code, bizErr.msg); return;
  }

  let anthropicResp;
  try {
    const upstreamObj = JSON.parse(upstreamResp.body.toString());
    anthropicResp = convertOpenAIToAnthropic(upstreamObj);
  } catch (err) {
    if (stream) { writeAnthropicSSEError(res, 502, err.message); return; }
    writeAnthropicError(res, 502, err.message); return;
  }

  if (stream) {
    writeAnthropicSSE(res, anthropicResp);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify(anthropicResp));
}

async function handleAnthropicCountTokens(cfg, req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let rawBody;
  try { rawBody = await readBody(req, cfg.maxBodyBytes); }
  catch (err) {
    if (err.message === 'request body too large') { writeAnthropicError(res, 413, 'request body too large'); return; }
    writeAnthropicError(res, 400, `read request body failed: ${err.message}`); return;
  }
  if (rawBody.length > cfg.maxBodyBytes) { writeAnthropicError(res, 413, 'request body too large'); return; }

  let inputTokens;
  try { inputTokens = estimateInputTokens(rawBody.toString()); }
  catch (_) { inputTokens = 1; }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ input_tokens: inputTokens }));
}

// ─── Router ───────────────────────────────────────────────────────────────────

function createHandler(cfg) {
  return async function handler(req, res) {
    const url = req.url.split('?')[0];

    try {
      if (url === '/health') return handleHealth(req, res);
      if (url === '/health/acp') return await handleAcpHealth(cfg, req, res);
      if (url === '/v1/models' || url === '/models') return handleModels(cfg, req, res);
      if (url === '/v1/upstream/models' || url === '/upstream/models') return await handleUpstreamModels(cfg, res);
      if (url.startsWith('/v1/models/')) return handleModelByID(cfg, req, res, url.slice('/v1/models/'.length));
      if (url.startsWith('/models/')) return handleModelByID(cfg, req, res, url.slice('/models/'.length));
      if (url === '/admin/upstream-strategy') return handleAdminStrategy(cfg, req, res);
      if (url === '/v1/messages/count_tokens' || url === '/messages/count_tokens') return await handleAnthropicCountTokens(cfg, req, res);
      if (url === '/v1/messages' || url === '/messages') return await handleAnthropicMessages(cfg, req, res);
      if (url === '/v1/chat/completions' || url === '/chat/completions') return await handleOpenAICompletions(cfg, req, res);

      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
    } catch (err) {
      console.error('[server] unhandled error:', err);
      if (!res.headersSent) writeError(res, 500, 'internal server error');
    }
  };
}

module.exports = { createHandler };
