# 聊天渠道连接的人工确认
状态：in-progress
Spec ID：`SPEC-chat-channel-confirmation`

本规范替代 SPEC-chat-channel-connect 的“近期 owner/admin 消息即可启动扫码”授权假设，保留其二维码与 Binding 终态行为。

- **AC-1**：Agent 提供近期消息 ID 只能准备确认请求，不调用平台 StartScan。旧版本不能绕过。
- **AC-2**：只有当前组织内 active human owner/admin 能确认；Agent（包括管理员 Agent）、普通成员、跨组织、跨 Agent/渠道/会话替换全部拒绝。
- **AC-3**：聊天显示已知渠道的确认按钮；只在显式点击时 POST，提交确认 ID、消息所在会话、消息发送 Agent 和所显示渠道。按钮提交中禁用；拒绝、过期和请求失败有可见反馈，不报成功。
- **AC-4**：确认请求五分钟有效；Redis 原子一次性领取保证重复/并发确认最多一次 StartScan；异常或进程退出不得让同一请求再次调用平台。失去缓存时关闭授权，不退回旧消息授权。
- **AC-5**：确认后原 Runtime watcher 获取本请求的 QR 并发入聊天，再运行原扫码/Binding 两阶段观察；浏览器关闭不影响 watcher。未确认、过期、确认失败不发 QR。
- **AC-6**：Agent authorization Poll 必须绑定到已人工确认的请求；拒绝未确认、别的 Agent/渠道、换 session_handle 的轮询。
- **AC-7**：移动窄屏和桌面都可点按，浅/深色使用既有 token；旧二维码消息仍可读，不新增 Core PNG 缓存。

非目标：不接个人微信/WhatsApp、不修改设置页扫码业务、不建设通用 Flow 引擎、不新增数据库表或修改第三方平台协议。
