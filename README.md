# iflow-relay

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`iflow-relay` 是一个轻量级的 iFlow API 反向代理，提供 OpenAI 兼容接口。

## 特性

- **协议兼容**：支持 OpenAI Chat Completions 和 Anthropic Messages API
- **请求伪装**：模拟官方 iFlow CLI 的请求特征
- **TLS 指纹对齐**：使用 Node.js 实现，与官方 iFlow CLI（Node.js 编写）TLS 指纹完全一致
- **多上游支持**：支持多个上游 API，自动选择最快的
- **签名认证**：支持 iFlow API 签名机制
- **流式响应**：完整支持 SSE 流式输出
- **ACP 模式**：通过官方 iFlow CLI 通信，避免封号风险

## 为什么使用 Node.js？

**核心原因：TLS 指纹对齐**

官方 iFlow CLI 使用 Node.js 编写，选择 Node.js 实现 iflow-relay 可以确保：

| 特征 | Node.js (iflow-relay) | 其他语言 (Rust/Go) |
|------|----------------------|-------------------|
| TLS 指纹 | ✅ 与官方 CLI 一致 | ❌ 指纹不同，易被检测 |
| HTTP/1.1 行为 | ✅ 完全一致 | ⚠️ 可能有细微差异 |
| 连接复用 | ✅ Keep-Alive 行为一致 | ⚠️ 实现可能不同 |

```
官方 iFlow CLI 请求 → Node.js HTTP Client → TLS 指纹 A
iflow-relay 请求    → Node.js HTTP Client → TLS 指纹 A (相同)
其他语言实现       → Rust/Go HTTP Client  → TLS 指纹 B (不同!)
```

服务端可以通过 TLS 指纹识别客户端类型，使用相同运行时可避免被检测。

## 架构

iflow-relay 支持两种模式：

### HTTP 模式（默认）

```
┌─────────────┐     ┌───────────────┐     ┌────────────┐
│   Client    │────▶│  iflow-relay  │────▶│  iFlow API │
│ (OpenClaw)  │     │   (代理层)     │     │ (主上游)   │
└─────────────┘     └───────────────┘     └────────────┘
                           │
                           ▼
                    ┌────────────┐
                    │  其他上游  │
                    │ (备用/视觉) │
                    └────────────┘
```

### ACP 模式（推荐）

ACP (Agent Communication Protocol) 模式通过本地 iFlow CLI 通信，使用官方客户端的完整行为：

```
┌─────────────┐     ┌───────────────┐     ┌─────────────┐     ┌────────────┐
│   Client    │────▶│  iflow-relay  │────▶│  iFlow CLI  │────▶│  iFlow API │
│ (OpenClaw)  │     │  (ACP 模式)    │     │ (官方客户端) │     │            │
└─────────────┘     └───────────────┘     └─────────────┘     └────────────┘
                                                 │
                           WebSocket JSON-RPC ◀──┘
                           (完全模拟官方行为)
```

**ACP 模式优势**：
- ✅ 使用官方 CLI，请求行为完全一致
- ✅ 避免因请求特征差异导致封号
- ✅ 支持流式响应
- ✅ 自动管理会话

详细架构和对抗检测措施请查看 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

### 安装

```bash
git clone https://github.com/ryfineZ/iflow-relay.git
cd iflow-relay
npm install
```

### 配置

```bash
cp .env.example .env
# 编辑 .env 填入 API Key
```

### 运行

```bash
npm start
```

默认监听：`http://127.0.0.1:8327`

### 健康检查

```bash
curl http://localhost:8327/health
# {"status":"ok"}
```

## 支持的接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/v1/models` | GET | 模型列表 |
| `/v1/models/{id}` | GET | 模型详情 |
| `/v1/chat/completions` | POST | OpenAI Chat Completions |
| `/v1/messages` | POST | Anthropic Messages |
| `/v1/messages/count_tokens` | POST | Token 估算 |

## 环境变量

### 基础配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8327` | 服务端口 |
| `DEFAULT_MODEL` | `glm-5` | 默认模型 |
| `IFLOW_MODELS` | `glm-5` | 模型列表 |

### 多上游配置

```bash
# 主上游 - iFlow 官方 API（需要签名）
UPSTREAM_1_URL=https://apis.iflow.cn/v1
UPSTREAM_1_KEY=sk-xxx
UPSTREAM_1_SIGN=true

# 备用上游 - 任意 OpenAI 兼容 API（不需要签名）
UPSTREAM_2_URL=https://api.example.com/v1
UPSTREAM_2_KEY=sk-yyy
UPSTREAM_2_SIGN=false

# 调度策略：fastest（自动选最快）或 roundrobin（轮询）
UPSTREAM_STRATEGY=fastest
```

### 视觉模型桥接

iflow-relay 支持**双模型编排**，让不支持视觉的上游也能处理图片：

```
┌─────────────┐     ┌───────────────┐     ┌─────────────────┐
│   图片请求  │────▶│  iflow-relay  │────▶│  视觉模型(Qwen) │
│             │     │  (自动桥接)    │     │  提取图片内容   │
└─────────────┘     └───────────────┘     └─────────────────┘
                           │
                           ▼ 视觉模型返回文本描述
                    ┌───────────────┐
                    │  主上游模型   │
                    │  (非视觉模型) │
                    └───────────────┘
```

**工作原理**：
1. 检测请求中是否包含图片
2. 如有图片，先用视觉模型（如 Qwen3-VL-Plus）提取内容
3. 将图片描述注入请求，转发给主上游模型
4. 支持任意非视觉模型获得视觉理解能力

**配置示例**：

```bash
# 启用多模态桥接
MM_ENABLED=true
MM_EXTRACTOR_MODEL=qwen3-vl-plus    # 视觉提取模型
MM_MAX_IMAGES=4                      # 单次最多处理图片数
MM_TIMEOUT_MS=12000                  # 视觉提取超时
```

### 其他配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_REQUEST_TIMEOUT_MS` | `180000` | 请求超时 |
| `PROXY_STREAM_HEARTBEAT_MS` | `15000` | 流式心跳间隔 |
| `LOG_REQUEST_HEADERS` | `false` | 记录请求头 |
| `SENSITIVE_WORDS` | 见说明 | 敏感词列表（留空禁用） |

## ACP 模式

ACP (Agent Communication Protocol) 模式通过本地 iFlow CLI 通信，使用官方客户端的完整行为，是目前最安全的方案。

### 为什么推荐 ACP 模式？

HTTP 模式虽然模拟了请求头和 TLS 指纹，但服务端仍可能通过其他特征检测代理行为。ACP 模式直接复用官方 CLI：

- **完全一致的请求行为**：使用官方 CLI 的 WebSocket 协议
- **自动处理认证**：复用 `iflow login` 的凭证
- **无需配置 API Key**：从 `~/.iflow/` 自动读取

### 启用 ACP 模式

```bash
# 1. 安装 iFlow CLI
npm install -g @anthropics/iflow-cli

# 2. 登录
iflow login

# 3. 启动 iFlow CLI（ACP 服务器模式）
iflow --acp-port 8090 &

# 4. 配置 iflow-relay
ACP_ENABLED=true
ACP_PORT=8090

# 5. 启动 iflow-relay
npm start
```

### ACP 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ACP_ENABLED` | `false` | 启用 ACP 模式 |
| `ACP_PORT` | `8090` | iFlow CLI ACP 端口 |
| `ACP_TIMEOUT` | `180` | ACP 请求超时（秒） |
| `ACP_DEBUG` | `false` | 启用 ACP 调试日志 |

### ACP 模式工作原理

```
1. iflow-relay 检测到 ACP_ENABLED=true
2. 检测本地 iFlow CLI 是否运行 (ws://127.0.0.1:8090/acp)
3. 如 iFlow CLI 可用，使用 ACP 协议通信
4. 否则回退到 HTTP 模式
```

### 健康检查

```bash
# 基础健康检查
curl http://localhost:8327/health

# ACP 状态检查
curl http://localhost:8327/health/acp
# {"status":"ok","acp":{"enabled":true,"available":true,"connected":true,"port":8090}}
```

## 对抗检测

iflow-relay 实现了多种措施来模拟官方 CLI 行为：

| 措施 | 说明 |
|------|------|
| 请求头对齐 | 与官方 CLI 完全一致的请求头 |
| TLS 指纹 | HTTP/1.1 + Keep-Alive，禁用 HTTP/2 |
| 签名机制 | HMAC-SHA256 签名认证 |
| 会话标识 | Session-ID + Conversation-ID |
| 限流保护 | 遇 429/403 自动暂停 |

⚠️ **注意**：敏感词混淆功能已禁用，因为零宽字符可能触发服务端检测。

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 与 OpenClaw 集成

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

## 已知问题

### 账号封禁风险

使用反向代理可能触发服务端的检测机制，导致账号被封禁。建议：

- 使用官方 API 作为主要方案
- 避免高频、长时间使用
- 不要在同一账号下混用多种客户端

## 许可证

MIT License
