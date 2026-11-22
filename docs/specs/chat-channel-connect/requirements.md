# 对话内通用渠道连接

状态：implemented
Spec ID：`SPEC-chat-channel-connect`

安全修订见 [SPEC-chat-channel-confirmation](../chat-channel-confirmation/requirements.md)：Tool 先发确认卡，Human owner/admin 点击后才发二维码；近期消息只作请求上下文而不是授权证明。原 QR/Binding 验收继续适用；允许短期 Redis 确认记录，不引入通用 Flow。

## 跨仓规范关系

本能力横跨 `cws-core`、`zylos-openmax` 与 `cws-fe`。验收编号以主设计文档《对话内 Channel Tool 连接方案》§10 为基线，三仓沿用同一组 AC，不允许在单仓重新编号或赋予不同含义。

- Core leg：`cws-core/docs/specs/chat-channel-connect/`
- Runtime leg：本目录
- Web leg：`cws-fe/docs/specs/chat-channel-connect/`

本仓负责 Agent Tool 参数规划、结构化二维码消息、模型输出最小化和本地有界 watcher；服务端鉴权与 Binding 持久状态由 Core/Connect 负责。

## 背景

Agent 从可信 `message-context` 取得 `conversation_id` 和 `source_message_id`，调用 `channel.connect` 发起平台授权。Tool 把二维码消息直接写入当前会话，并在后台观察扫码授权与 Binding 终态。

## 共享验收标准

- **AC-1（统一协议）**：四个平台均产生 `openmax.channel-qr.v1` 结构化消息；Web 仅为 Agent 消息、已知 schema 和 `feishu|lark|dingtalk|wecom` 渲染通用卡片。
- **AC-2（紧凑展示）**：卡片顶部显示平台名，最大宽度 288px、二维码视觉区 160px，并在 375px 窄屏中不横向溢出。
- **AC-3（安全降级）**：`qr_ref` 缺失、过期、UTF-8 长度超过 1800 bytes，或二维码编码器拒绝输入时，原位置显示同尺寸、包含图标和文字的过期态，不使消息树崩溃。
- **AC-4（PNG 边界）**：对话 Tool 路径只传递短期 `qr_ref`，不得在 Core 解码或缓存平台授权 PNG，也不得为此新增公开图片路由；设置页和运行时二维码已有的受控 PNG 能力不在删除范围内。
- **AC-5（模型数据最小化）**：Tool 的模型可见输出不得包含 `qr_ref`、`session_handle`、平台凭据或本地状态文件路径。
- **AC-6（成功判定）**：扫码成功后必须等待 Binding 变为 `connected` 才追加成功消息；Binding `pending`、失败、扫码过期和 watcher 异常不得误报成功或静默结束。
- **AC-7（重复连接）**：现有 Binding 为 `connected` 或 `pending` 时，普通连接请求不得创建新二维码或新 watcher。
- **AC-8（Phase-1 已知限制）**：扫码完成前尚无 Binding，同一渠道的重复请求可能创建多个短期扫码会话；该限制必须显式记录，不得伪装成已实现的 Flow 去重。
- **AC-9（设置页回归）**：Agent 设置页既有的飞书、Lark、钉钉和企业微信扫码/手动连接流程保持可用。

## Runtime 约束

- Tool 仅接受 `feishu|lark|dingtalk|wecom`，且必须从可信上下文取得 UUID conversation 和 source message。
- 二维码展示期最长 5 分钟；扫码成功后切换到 Binding Status，不能继续用二维码 TTL 限制组件安装和连接。
- Binding watcher 最长等待 17 分钟，用于覆盖 cws-connect 15 分钟 stale-pending 回收及一分钟 sweep 余量；达到上限前做最后一次状态读取。
- watcher 的本地状态目录为 `0700`、文件为 `0600`，不保存 `qr_ref`、来源消息或平台凭据，终态后删除。

## Phase-1 非目标

- **不支持个人微信（`wechat`）和 WhatsApp 的对话内连接。** Tool 必须显式拒绝这两个值；其运行时二维码上报与轮换属于后续阶段。
- 不新增 Redis/数据库 Flow、跨实例 watcher 接管或扫码前严格去重。
- 不动态更新历史二维码消息；终态通过新文本消息追加。
- 不覆盖 Slack、Teams 等其他渠道。
