# iflow-relay 技术文档

> iFlow API 反向代理，提供 OpenAI 兼容接口

---

## 目录

1. [概述](#概述)
2. [架构设计](#架构设计)
3. [对抗检测措施](#对抗检测措施)
4. [配置说明](#配置说明)
5. [使用指南](#使用指南)
6. [已知问题](#已知问题)

---

## 概述

`iflow-relay` 是一个轻量级的 iFlow API 反向代理，核心功能：

- **协议转换**：将 OpenAI/Anthropic API 请求转换为 iFlow API 格式
- **请求伪装**：模拟官方 iFlow CLI 的请求特征
- **多上游支持**：支持多个上游 API，自动选择最快的
- **流式响应**：完整支持 SSE 流式输出

### 项目定位

```
┌─────────────┐     ┌───────────────┐     ┌────────────┐
│   Client    │────▶│  iflow-relay  │────▶│  iFlow API │
│ (OpenClaw)  │     │   (代理层)     │     │ (官方API)  │
└─────────────┘     └───────────────┘     └────────────┘
                           │
                           ▼
                    ┌────────────┐
                    │  元景 API  │
                    │ (备用上游)  │
                    └────────────┘
```

---

## 架构设计

### 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                         iflow-relay                             │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  HTTP入口   │  │  路由分发   │  │      协议转换层          │  │
│  │  (index.js) │─▶│ (server.js) │─▶│  • OpenAI → iFlow       │  │
│  │             │  │             │  │  • Anthropic → OpenAI   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                            │                    │
│                                            ▼                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    核心请求模块 (iflow.js)               │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │ 请求头构建  │  │  签名生成   │  │  连接池管理     │  │   │
│  │  │ User-Agent │  │ HMAC-SHA256 │  │  Keep-Alive     │  │   │
│  │  │ Session-ID │  │ Timestamp   │  │  HTTP/1.1 Only  │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                            │                    │
│                                            ▼                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    上游调度 (config.js)                  │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │ Fastest     │  │ Round-Robin │  │ 故障转移        │  │   │
│  │  │ EMA延迟统计 │  │ 轮询        │  │ 自动重试        │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 模块说明

| 模块 | 文件 | 功能 |
|------|------|------|
| 入口 | `index.js` | 启动 HTTP 服务器，加载配置 |
| 路由 | `server.js` | 请求路由、协议转换、敏感词处理 |
| 核心请求 | `iflow.js` | iFlow API 请求、请求头构建、签名 |
| 配置 | `config.js` | 环境变量解析、上游配置、凭证读取 |
| 多模态 | `multimodal.js` | 图片处理桥接 |
| 协议转换 | `anthropic.js` | Anthropic ↔ OpenAI 格式转换 |

### 请求流程

```
Client Request
      │
      ▼
┌─────────────────┐
│  协议识别       │ ─── OpenAI / Anthropic / 直接转发
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  敏感词处理     │ ─── 可选：混淆/跳过
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  上游选择       │ ─── Fastest / Round-Robin
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  请求头构建     │ ─── 模拟官方 CLI
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  签名生成       │ ─── HMAC-SHA256
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  发送到上游     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  响应处理       │ ─── 流式/非流式
└────────┬────────┘
         │
         ▼
Client Response
```

---

## 对抗检测措施

### 1. 请求头伪装

模拟官方 iFlow CLI 的请求头特征：

```
┌─────────────────────────────────────────────────────────────┐
│                    官方 CLI 请求头                           │
├─────────────────────────────────────────────────────────────┤
│  Content-Type: application/json                             │
│  Authorization: Bearer sk-xxx                                │
│  User-Agent: iFlow-Cli                                       │
│  Accept: */*                                                 │
│  Accept-Encoding: gzip, deflate    ← 注意：无 br            │
│  Accept-Language: *                                          │
│  Sec-Fetch-Mode: cors                                        │
│  Session-ID: session-xxx                                     │
│  Conversation-ID: uuid                                       │
│  X-IFlow-Signature: hmac-sha256    ← 签名                    │
│  X-IFlow-Timestamp: 1234567890     ← 时间戳                  │
│  Traceparent: 00-xxx-xxx-01        ← W3C追踪                 │
└─────────────────────────────────────────────────────────────┘
```

**实现细节**：

```javascript
// src/iflow.js
const headers = {
  'content-type': 'application/json',
  'authorization': `Bearer ${apiKey.trim()}`,
  'user-agent': 'iFlow-Cli',
  'accept': '*/*',
  'accept-encoding': 'gzip, deflate',  // 无 br，与官方一致
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
  'session-id': sessionID,
  'conversation-id': conversationID,
  'traceparent': generateTraceParent(),
};

// 签名
if (withSignature) {
  const timestamp = Date.now();
  headers['x-iflow-timestamp'] = String(timestamp);
  headers['x-iflow-signature'] = createHmac('sha256', apiKey)
    .update(`iFlow-Cli:${sessionID}:${timestamp}`)
    .digest('hex');
}
```

### 2. TLS 指纹对齐

```
┌─────────────────────────────────────────────────────────────┐
│                    TLS 连接特征                              │
├─────────────────────────────────────────────────────────────┤
│  Keep-Alive: true                  ← 持久连接                │
│  ALPN: ['http/1.1']                ← 禁用 HTTP/2             │
│  maxSockets: 20                    ← 连接池大小              │
│  scheduling: 'lifo'                ← 调度策略                │
└─────────────────────────────────────────────────────────────┘
```

**为什么禁用 HTTP/2？**
- Node.js 原生 HTTP/2 的 TLS 指纹与浏览器/CLI 不同
- 官方 CLI 使用 HTTP/1.1
- ALPN 协商为 `http/1.1` 保持指纹一致

```javascript
// src/iflow.js
const iflowHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 20,
  scheduling: 'lifo',
  ALPNProtocols: ['http/1.1'],  // 禁用 HTTP/2
});
```

### 3. 会话标识

```
┌─────────────────────────────────────────────────────────────┐
│                    会话标识处理                              │
├─────────────────────────────────────────────────────────────┤
│  Session-ID: 进程启动时生成，进程内保持一致                  │
│  Conversation-ID: 每个对话生成新的 UUID                      │
│  Traceparent: 每个请求生成新的追踪 ID                        │
└─────────────────────────────────────────────────────────────┘
```

### 4. 敏感词混淆（已禁用）

> ⚠️ **警告**：此功能已禁用，因为零宽字符可能触发服务端检测

```
原始实现（已禁用）：
┌─────────────────────────────────────────────────────────────┐
│  "Claude Code" → "Cl‍aud‌e C‍od‌e"                             │
│                     ↑ 零宽字符                               │
│                                                             │
│  风险：服务端可检测零宽字符 → 标记异常                        │
└─────────────────────────────────────────────────────────────┘

当前配置：SENSITIVE_WORDS=（空）
```

### 5. 限流保护

```
┌─────────────────────────────────────────────────────────────┐
│                    限流保护机制                              │
├─────────────────────────────────────────────────────────────┤
│  429 (Rate Limit) → 暂停 30 秒                              │
│  403 (Forbidden)   → 暂停 5 分钟                            │
│                                                             │
│  全局暂停状态，所有后续请求自动拒绝                           │
└─────────────────────────────────────────────────────────────┘
```

```javascript
// src/iflow.js
function triggerPause(statusCode) {
  const now = Date.now();
  if (statusCode === 429) {
    globalPauseUntil = Math.max(globalPauseUntil, now + 30000);
    console.warn(`[iflow] 429 rate limit, pausing for 30s`);
  } else if (statusCode === 403) {
    globalPauseUntil = Math.max(globalPauseUntil, now + 300000);
    console.warn(`[iflow] 403 forbidden, pausing for 5min`);
  }
}
```

### 6. 多模态请求处理

多模态请求（图片识别）使用简化请求头：

```
普通 Chat 请求:
┌─────────────────────────────────────────────┐
│  session-id, conversation-id, signature... │
└─────────────────────────────────────────────┘

多模态请求 (minimalHeaders):
┌─────────────────────────────────────────────┐
│  仅基本头：Authorization, User-Agent...     │
│  无 session-id, signature 等                │
└─────────────────────────────────────────────┘
```

### 对抗措施总结

| 措施 | 目的 | 状态 |
|------|------|------|
| 请求头对齐 | 模拟官方 CLI | ✅ 已实现 |
| TLS 指纹对齐 | HTTP/1.1 + Keep-Alive | ✅ 已实现 |
| 签名机制 | HMAC-SHA256 认证 | ✅ 已实现 |
| 敏感词混淆 | 绕过关键词检测 | ⚠️ 已禁用 |
| 限流保护 | 避免触发封号 | ✅ 已实现 |
| 多上游调度 | 负载均衡 + 故障转移 | ✅ 已实现 |

---

## 配置说明

### 环境变量

```bash
# .env 文件示例

# 服务端口
PORT=8327

# === 多上游配置 ===
# iFlow 官方 API
UPSTREAM_1_URL=https://apis.iflow.cn/v1
UPSTREAM_1_KEY=sk-xxx
UPSTREAM_1_SIGN=true              # iFlow 需要签名

# 元景 API（不需要签名）
UPSTREAM_2_URL=https://maas-api.ai-yuanjing.com/openapi/compatible-mode/v1
UPSTREAM_2_KEY=sk-yyy
UPSTREAM_2_SIGN=false             # 元景不需要签名

# 调度策略：fastest（自动选最快）或 roundrobin（轮询）
UPSTREAM_STRATEGY=fastest

# 默认模型
DEFAULT_MODEL=glm-5
IFLOW_MODELS=glm-5

# 超时设置
PROXY_REQUEST_TIMEOUT_MS=180000
PROXY_STREAM_HEARTBEAT_MS=15000
PROXY_MAX_BODY_BYTES=26214400

# 日志
LOG_REQUEST_HEADERS=false
LOG_RESPONSE_HEADERS=false

# 敏感词混淆（留空禁用）
SENSITIVE_WORDS=
```

### 签名配置

```bash
# iFlow 需要签名
UPSTREAM_1_SIGN=true

# 非 iFlow 不需要签名
UPSTREAM_2_SIGN=false
```

---

## 使用指南

### 快速开始

```bash
# 1. 克隆项目
git clone <repo-url>
cd iflow-relay

# 2. 安装依赖
npm install

# 3. 配置
cp .env.example .env
# 编辑 .env 填入 API Key

# 4. 启动
npm start
```

### 与 OpenClaw 集成

```json
// ~/.openclaw/openclaw.json
{
  "models": {
    "providers": {
      "iflow": {
        "baseUrl": "http://localhost:8327",
        "apiKey": "dummy",
        "api": "openai-completions",
        "models": [{"id": "glm-5"}]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "iflow/glm-5"
      }
    }
  }
}
```

### 健康检查

```bash
curl http://localhost:8327/health
# {"status": "ok"}
```

### 测试请求

```bash
curl http://localhost:8327/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"glm-5","messages":[{"role":"user","content":"hi"}]}'
```

---

## 已知问题

### 1. 账号封禁风险

iFlow 服务可能检测到代理行为并封禁账号，原因可能包括：

- **请求模式差异**：高频使用、非正常时段使用
- **内容特征**：即使混淆也可能被检测
- **账号关联**：多账号共用设备/IP

**建议**：
- 使用元景等官方 API 作为备用
- 避免高频、长时间使用
- 不要在同一账号下混用多种客户端

### 2. 敏感词混淆的争议

之前的混淆功能可能**反而增加检测风险**：

```
原始: "Claude Code"
混淆: "Cl‍aud‌e C‍od‌e" ← 包含零宽字符

服务端检测：content.includes('\u200B') → 异常
```

**建议**：保持 `SENSITIVE_WORDS=` 为空，禁用混淆。

### 3. 签名必须匹配

iFlow API 要求签名，否则请求会被拒绝：

```javascript
// 签名算法
signature = HMAC-SHA256(apiKey, `iFlow-Cli:${sessionID}:${timestamp}`)
```

---

## 文件结构

```
iflow-relay/
├── index.js           # 入口
├── package.json
├── .env.example
├── src/
│   ├── config.js      # 配置加载
│   ├── iflow.js       # 核心请求逻辑
│   ├── server.js      # HTTP 服务器
│   ├── anthropic.js   # Anthropic 协议转换
│   └── multimodal.js  # 多模态处理
└── docs/
    └── ARCHITECTURE.md
```

---

## 参考资料

- [ZeroGravity GitHub Discussions](https://github.com/NikkeTryHard/zerogravity/discussions) - 类似项目的封号讨论
- [iFlow CLI 官方文档](https://iflow.cn) - 官方客户端行为参考

---

## 更新日志

### 2026-03-04
- 修复 `accept-encoding` 与官方 CLI 一致（移除 br）
- 修复签名逻辑，默认启用，支持手动配置 `UPSTREAM_X_SIGN`
- 禁用敏感词混淆功能（可能触发检测）

### 2026-03-02
- 初始版本发布
- 支持多上游调度
- 支持 Anthropic 协议
