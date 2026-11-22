# 设计

三仓协同：Core 为安全权威，OpenMAX 负责发确认卡/等待确认/发二维码/原 watcher，FE 只发起人工确认。

1. Tool Start 保留来源消息核验作为准备请求的门槛（不是操作授权），返回 `awaiting_user_confirmation + confirmation_id + expires_at`。
2. Tool 发 `openmax.channel-confirm.v1`，正文和 metadata 均含渠道、确认 ID、有效期；目标 Agent 使用真实消息 sender_id，不信消息 body 的 agent_id。
3. FE 显式点击后调用 `POST /api/v1/channel-connection-confirmations/{confirmation_id}/confirm`，携带显示的 Agent/渠道/会话，Core 必须精确比对已保存请求并重新验证 active Human 和 owner/admin。
4. Redis 保存不可变请求范围和有限期结果；确认前5分钟，记录最多30分钟；SET NX 领取键保留超过记录有效期，不删除重放保护。确认超时/崩溃不给同一请求自动第二次 Start。缓存故障 fail closed。
5. `POST /api/v1/agent-tools/channel-connections/confirmation` 为 Agent 自限域只读；确认后仅该 Agent 能读到 QR/session。Runtime 用 confirmation_id 等待，发送 QR 后复用两阶段 watcher。
6. 原 authorization Poll 增加 confirmation_id 并核对已批准的 session_handle 和渠道；Binding Status 保持只读。
7. 确认返回已接受不等于渠道已连接。成功仍仅由 Binding connected 判定。

无新增 SQL/RPC；临时授权数据不落审计数据库，30分钟缓存不是长期授权审计。SDK 新端点随 Core 契约发布；FE 在 SDK 未发布期间仅允许复用 coreFetch 的显式临时例外（须交接负责人补 typed path）。

## 验收映射
| AC | 承载 |
| --- | --- |
| AC-1/2/4/6 | Core HTTP 授权回归与 app 并发/TTL 测试；服务端安全行为 |
| AC-3 | FE 按钮集成测试 + chat-channel-confirmation E2E 请求体断言；应用编排 |
| AC-5 | Runtime 等待确认/二维码/两阶段 watcher 单元测试；跨仓真实扫码联调另验 |
| AC-7 | 共享卡片组件测试、Storybook 双主题和375px E2E；展示契约 |

治理：沿用既有 API/React Query/UI/i18n 约定，不新增通用框架规则。部署必须三仓配套；旧 Runtime 遇新 Core 的 awaiting_user_confirmation 不能误报发码。

## 边界与上线注意

- 确认状态为 awaiting_user_confirmation → starting → ready/error；ready 的结果可能是扫码会话，也可能是 already_connected/connection_in_progress。确认成功不等于 Binding connected。
- 一次性约束只针对同一个 confirmation_id；独立提出的两张卡仍需分别人工确认，不宣称完成跨请求 Flow 去重。
- Redis 作为授权状态存储须禁用会提前逐键淘汰领取标记的 eviction 策略；不能将 claim 键单独清理或恢复到旧快照。丢失整条请求时返回过期/不可用，不恢复旧授权。Runtime 进程丢失的自动接管仍不在本期范围内。
- 本期仅 HTTP 暴露人工确认，无新增 RPC/SQL/迁移。沿用现有 BFF 的 snake_case 字段；agent_member_id 为组织 member UUID，identity_id 只在服务端记录。确认记录是短期授权状态，不是长期审计日志。
- 三仓须配套部署，旧 Tool 的 bare-session Poll 将被拒绝；已打开的旧扫码会话需重新发起。不修改设置页四个平台的接口。
- FE 固定 SDK alpha.119 未声明人工确认端点，暂用已有 coreRequest → coreFetch 传输；现有 SDK 漂移守卫会在 SDK 声明此路径后要求迁回 typed client。发布/迁移须交接 SDK 负责人（Noah），本次不手动发布 SDK。
