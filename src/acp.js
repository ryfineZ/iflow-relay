'use strict';

/**
 * ACP (Agent Communication Protocol) 客户端
 * 通过 WebSocket JSON-RPC 2.0 与本地 iFlow CLI 通信
 *
 * 协议流程：
 * 1. 连接 WebSocket (ws://127.0.0.1:{port}/acp)
 * 2. 接收 //ready 控制消息
 * 3. 发送 initialize 请求
 * 4. 接收 initialize 响应 (包含 authMethods)
 * 5. 发送 session/new 请求
 * 6. 接收 session/new 响应 (包含 sessionId)
 * 7. 发送 session/prompt 请求
 * 8. 接收 session/update 事件 (agent_message_chunk)
 * 9. 接收 stopReason 表示完成
 */

const WebSocket = require('ws');
const crypto = require('crypto');

class AcpClient {
  /**
   * @param {object} options
   * @param {number} options.port - iFlow CLI ACP 端口，默认 8090
   * @param {string} options.cwd - 工作目录
   * @param {number} options.timeout - 超时时间（秒）
   * @param {boolean} options.debug - 是否启用调试日志
   */
  constructor(options = {}) {
    this.port = options.port || 8090;
    this.cwd = options.cwd || process.cwd();
    this.timeout = options.timeout || 180;
    this.debug = options.debug || false;
    this.ws = null;
    this.requestId = 1;
    this.pendingRequests = new Map();
    this.sessionId = null;
    this.connected = false;
    this.authenticated = false;
  }

  /**
   * 连接到 iFlow CLI ACP 服务器
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}/acp`;
      this.log(`Connecting to ${url}`);

      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error(`ACP connection timeout after ${this.timeout}s`));
        this.ws.close();
      }, this.timeout * 1000);

      this.ws.on('open', () => {
        this.log('WebSocket connected, waiting for //ready');
      });

      this.ws.on('message', (data) => {
        const text = data.toString();
        this.handleMessage(text, resolve, reject);
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`ACP WebSocket error: ${err.message}`));
      });

      this.ws.on('close', () => {
        this.log('WebSocket closed');
        this.connected = false;
      });
    });
  }

  /**
   * 处理接收到的消息
   */
  handleMessage(text, connectResolve, connectReject) {
    // 控制消息
    if (text.startsWith('//')) {
      const ctrl = text.trim();
      this.log(`Control: ${ctrl}`);

      if (ctrl === '//ready' && !this.connected) {
        this.connected = true;
        this.sendInitialize()
          .then(() => {
            this.log('Initialized');
            connectResolve();
          })
          .catch((err) => {
            connectReject(err);
          });
      }
      return;
    }

    // JSON-RPC 响应
    try {
      const msg = JSON.parse(text);
      this.log(`Received: ${JSON.stringify(msg).substring(0, 200)}`);

      // 处理响应
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const { resolve, reject } = this.pendingRequests.get(msg.id);
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }

      // 处理通知（session/update 等）
      if (msg.method === 'session/update' && this.onUpdate) {
        this.onUpdate(msg.params);
      }
    } catch (e) {
      this.log(`Parse error: ${e.message}`);
    }
  }

  /**
   * 发送 initialize 请求
   */
  async sendInitialize() {
    const result = await this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true }
      },
      mcpServers: [],
      hooks: {},
      commands: [],
      agents: []
    });

    if (result.authMethods) {
      this.authenticated = true;
    }

    return result;
  }

  /**
   * 创建新 session
   * @param {object} options
   * @param {string} options.model - 模型名称
   * @returns {Promise<string>} sessionId
   */
  async createSession(options = {}) {
    const settings = {
      permission_mode: 'yolo',
      thinking: true
    };

    if (options.model) {
      settings.model = options.model;
    }

    const result = await this.sendRequest('session/new', {
      cwd: this.cwd,
      mcpServers: [],
      settings
    });

    this.sessionId = result.sessionId;
    this.log(`Session created: ${this.sessionId}`);
    return this.sessionId;
  }

  /**
   * 发送 prompt 并收集响应
   * @param {string} prompt - 用户输入
   * @param {object} options
   * @param {function} options.onChunk - 流式响应回调 (chunk: string) => void
   * @returns {Promise<string>} 完整响应文本
   */
  async prompt(prompt, options = {}) {
    if (!this.sessionId) {
      await this.createSession(options);
    }

    return new Promise((resolve, reject) => {
      let fullText = '';
      let stopReason = null;

      this.onUpdate = (params) => {
        const update = params.update || {};

        if (update.sessionUpdate === 'agent_message_chunk') {
          const chunk = update.content?.text || '';
          fullText += chunk;
          if (options.onChunk) {
            options.onChunk(chunk);
          }
        }

        // 检查是否完成
        if (update.stopReason) {
          stopReason = update.stopReason;
        }
      };

      this.sendRequest('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: prompt }]
      })
        .then((result) => {
          this.onUpdate = null;
          if (result.stopReason) {
            stopReason = result.stopReason;
          }
          resolve(fullText);
        })
        .catch((err) => {
          this.onUpdate = null;
          reject(err);
        });
    });
  }

  /**
   * 发送 JSON-RPC 请求
   */
  async sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;

      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.pendingRequests.set(id, { resolve, reject });
      this.log(`Sending: ${JSON.stringify(request).substring(0, 200)}`);
      this.ws.send(JSON.stringify(request));

      // 设置超时
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timeout`));
        }
      }, this.timeout * 1000);
    });
  }

  /**
   * 断开连接
   */
  async disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.sessionId = null;
  }

  /**
   * 检查连接状态
   */
  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 检查认证状态
   */
  isAuthenticated() {
    return this.authenticated;
  }

  log(message) {
    if (this.debug) {
      console.log(`[ACP] ${message}`);
    }
  }
}

/**
 * 将 OpenAI 消息转换为 ACP prompt 文本
 * @param {Array} messages - OpenAI 格式消息
 * @returns {string} prompt 文本
 */
function messagesToPrompt(messages) {
  const systemParts = [];
  const convParts = [];

  for (const msg of messages) {
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // 提取文本内容
      content = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }

    switch (msg.role) {
      case 'system':
        systemParts.push(content);
        break;
      case 'user':
        convParts.push(content);
        break;
      case 'assistant':
        convParts.push(`[Assistant]\n${content}`);
        break;
      default:
        convParts.push(content);
    }
  }

  let result = '';
  if (systemParts.length > 0) {
    result += systemParts.join('\n') + '\n\n';
  }
  result += convParts.join('\n\n');
  return result;
}

/**
 * 检测 iFlow CLI 是否运行并监听 ACP 端口
 * @param {number} port - 端口号
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<boolean>}
 */
async function detectAcpServer(port = 8090, timeout = 5000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);

    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, timeout);

    ws.on('open', () => {
      // 发送一个测试消息
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }));
    });

    ws.on('message', () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });

    ws.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * 使用 ACP 进行对话（便捷函数）
 * @param {Array} messages - OpenAI 格式消息
 * @param {object} options
 * @param {number} options.port - ACP 端口
 * @param {string} options.model - 模型名称
 * @param {function} options.onChunk - 流式响应回调
 * @param {number} options.timeout - 超时时间
 * @returns {Promise<{text: string, sessionId: string}>}
 */
async function acpChat(messages, options = {}) {
  const client = new AcpClient({
    port: options.port || 8090,
    timeout: options.timeout || 180,
    debug: options.debug
  });

  try {
    await client.connect();

    const prompt = messagesToPrompt(messages);
    const text = await client.prompt(prompt, {
      model: options.model,
      onChunk: options.onChunk
    });

    return {
      text,
      sessionId: client.sessionId
    };
  } finally {
    await client.disconnect();
  }
}

module.exports = {
  AcpClient,
  messagesToPrompt,
  detectAcpServer,
  acpChat
};
