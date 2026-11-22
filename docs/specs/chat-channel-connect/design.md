# 对话内通用渠道连接 — OpenMAX 设计

> 安全修订：下文原始直接 Start→QR 流程已由 [SPEC-chat-channel-confirmation](../chat-channel-confirmation/design.md) 替换。Start 仅返回人工确认请求；Runtime 先发确认卡，等待 Human 点击后才发 QR。Authorization Poll 新增 `confirmation_id`，禁止裸 session；后半段 Binding watcher 与旧 QR 协议保持不变。

## 规范边界

本文件是 `SPEC-chat-channel-connect` 的 Runtime leg，AC 编号引用同目录 requirements 和主设计 §10。Core 与 Web 分别在各自同名 spec 记录接口和展示实现。

## Tool 流程

```text
Agent → channel.connect(channelType, conversationId, sourceMessageId)
  ↓
Core Start
  ├─ already_connected / connection_in_progress → 返回 Agent，不发二维码
  └─ awaiting_user_scan
       ├─ 向 cws-comm 写 openmax.channel-qr.v1
       ├─ 模型 stdout 只写 awaiting_user_scan + channel_type + TTL
       └─ 启动 detached watcher
```

结构化消息的 content 与 `metadata.context` 中的 `channel-qr` item（`audience: "ui"`，其 `data`；message context phase 2 起不再写 `metadata.openmax_channel_qr`）使用相同展示投影，包含 `channel_type + qr_ref + expires_at`；不包含 `session_handle` 或平台凭据。

## 两阶段 watcher

```text
authorization phase（最多二维码 TTL / 5 分钟）
  pending ──3s──> poll authorization
  expired/cancelled/error → 对应终态文本
  connected + binding.connected → 成功文本
  connected + binding.pending → binding phase

binding phase（最多 17 分钟）
  pending ──3s──> Core read-only Binding Status
  connected → 成功文本
  error/disconnected/not_found → 失败文本
  deadline → 最终读取一次 → connected 或 timeout
```

Start 是唯一携带 `source_message_id` 的请求。后续 authorization Poll 只携带 `channel_type + session_handle`，Binding Status 只携带 `channel_type`，因此最初消息超过 10 分钟不会打断已合法启动的连接。

watcher 以 `error` 作为异常默认终态，并在 `finally` 中尽力发送终态消息和删除状态文件。二维码数据与 session handle 不进入模型 stdout；session handle 只存在私有临时状态文件中。

## 验收 → 测试映射

| AC | 本仓承载 | 跨仓承载 |
| --- | --- | --- |
| AC-1 | `buildChannelQRMessage emits one generic structured card for every platform` | Core 四平台 Start；FE parser/E2E |
| AC-2 | 无布局职责 | FE 卡片与窄屏 E2E |
| AC-3 | `pollChannelUntilTerminal expires when the QR is never scanned` | FE parser/计时/Error Boundary 测试 |
| AC-4 | 消息构造仅使用 `qr_ref`，不消费 PNG | Core Tool 路径边界测试/审查 |
| AC-5 | connect 返回断言及 `buildChannelQRMessage` 测试；模型 stdout 排除敏感字段 | Core 响应最小化 |
| AC-6 | authorization→Binding 切换、pending/error、独立 deadline、最终读取、异常终态测试 | Core Poll/Status 测试 |
| AC-7 | `channelStartResultWithoutQR suppresses redundant QR sessions` | Core live Binding 抑制测试 |
| AC-8 | Tool 每次 Start 独立，requirements 明示扫码前可能重复出码 | Core StartScan 无 Flow 设计 |
| AC-9 | 不调用设置页 API | FE 四个平台设置页 E2E |

## 状态文件

状态仅包含 `orgId`、`channelType`、`conversationId`、`sessionHandle` 和 `scanDeadlineMs`。随机 token 只作为子进程入参；目录和文件权限分别为 `0700/0600`。二维码消息发送失败、watcher 终态或异常都会清理文件。

## Phase-1 扩展边界

个人微信和 WhatsApp 是“先 pending Binding、后 Runtime 生成并轮换二维码”，与本期“先平台授权二维码、后 Binding”不同。它们不加入当前 `PLATFORM_CHANNELS`，后续实现必须另设 runtime-QR 执行器，不能复用当前 StartScan 假装已经支持。
