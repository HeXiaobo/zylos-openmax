# Smoke 4 — 简单任务 · 对话全流程(P0 五卡片闭环)

> **验证目标**:用户在 Agent DM 中下达一条**简单研究任务**(单 agent 能独立
> 完成、无需多 agent 协作),Agent **自主**走完 v0.5 设计文档定义的 5 张
> 卡片闭环:`任务分析 → 开始执行 → 执行进度 → 交付 → 验收完成`。同时验证
> 这些卡片背后产生的真实状态变更:在「默认项目」下创建问题、产物存进「默认
> 知识库」、最终 issue 状态进入 closed/accepted 并落到 项目归档 tab。
>
> 对照设计:wiki `openmax-v0.5-features-20260524-latest`
> 表格行 23–27(对话 · 简单任务 · P0)。
>
> **关系**:Smoke 4 是产品语义层的冒烟,**关心 agent 怎么"说"** —— 看
> 卡片渲染、消息体里的关键短语;Smoke 1/2/3 是接口层的冒烟,关心 agent 怎么
> "做" —— 看 tm.js 状态机调用结果。两者**互补、不能互相替代**。

---

## 1. 测试架构

```
┌─ TEST CLIENT (smoke-4-simple-task-conversation.test.js) ─────────────┐
│                                                                       │
│ [Phase 1] sendInstruction("请帮我做一份近期 AI 工具的竞品分析…")    │
│              ↓                                                        │
│ [Phase 2] poll conversation messages 直到 agent 回复 "任务分析" 卡    │
│              · 短语断言:                                              │
│                ▸ "简单研究任务" / "独立完成"                          │
│                ▸ "默认项目" / "默认知识库"                            │
│                ▸ 含 "是否确认执行" 之类的 confirm 询问                │
│                ↓                                                       │
│ [Phase 3] sendInstruction("确认")                                    │
│              ↓                                                        │
│ [Phase 4] poll 等 "开始执行" 卡 + tm.js 旁路验证 issue 已建出来       │
│              · 卡片断言:含 "已在项目「默认项目」下创建问题"         │
│              · 旁路断言:在 默认项目 下能 list 到一条 mode=light /    │
│                                heavy 的 issue,status ∈                │
│                                {draft,pending_approval,executing}     │
│                ↓                                                       │
│ [Phase 5] poll 等 "执行进度" 卡(可能 1 张也可能 N 张)               │
│              · 至少一张消息含 "✅" / "进展" / "完成" 字眼            │
│                ↓                                                       │
│ [Phase 6] poll 等 "交付" 卡                                          │
│              · 卡片断言:含 "请验收" + 文件清单(>=1 行能链到 KB)   │
│              · 旁路断言:KB 里能搜到至少 1 个 page,标题含 issue     │
│                                title 或 task title                    │
│              · 旁路断言:issue.status == "delivered"                  │
│                ↓                                                       │
│ [Phase 7] sendInstruction("确认验收")                                │
│              ↓                                                        │
│ [Phase 8] poll 等 "验收完成" 卡 + 旁路验证终态                       │
│              · 卡片断言:含 "已关闭" + "已归档"                       │
│              · 旁路断言:issue.status == "accepted"                   │
│              · 旁路断言:issue.archived_at 非空 / 不在 active list 中 │
│                ↓                                                       │
│ [Phase 9] 深度断言(见下文 §3 总表)                                  │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 2. 前置条件

| 资源 | 用途 |
|---|---|
| cws-core / cws-comm / cws-work / cws-kb 在目标环境部署且健康 | 接口可用 |
| 测试 Org 下有 **「默认项目」** | Agent 用这个作为简单任务默认落点 |
| 测试 Org 下有 **「默认知识库」** | Agent 产物自动归档目标 |
| 测试 DM 会话 `TEST_CONV_ID` | 已存在,user + agent 双方都是 member |
| Agent runtime 加载 v0.5 卡片渲染 skill | 否则 Phase 2 / 4 / 6 / 8 的卡片断言会挂 |

> **重要前提**:`smoke-4` 的"卡片"断言假设 agent runtime 已经按 v0.5 设计
> 在 openmax skill 里实现了 5 张卡片的渲染。如果 agent 这边还是按
> Smoke 1/2/3 那样发纯文本日志,Smoke 4 会在 Phase 2 卡住直到超时 —— 这
> **正是**这条用例的价值:它把"会做 tm.js 调用"和"会按 v0.5 UX 说话"
> 两件事**分开度量**。

### Env vars

```bash
COCO_API_URL=https://<your-bff-host>
TEST_USER_TOKEN=<user JWT, org-scoped>
TEST_CONV_ID=<user ↔ agent DM uuid>
TEST_AGENT_ID=<agent member_id>
TEST_DEFAULT_PROJECT_ID=<默认项目 id>   # ← Smoke 4 新加,用来旁路验证
TEST_DEFAULT_KB_ID=<默认知识库 id>      # ← Smoke 4 新加
CF_ACCESS_CLIENT_ID=<...>.access        # 若 目标环境走 CF Access
CF_ACCESS_CLIENT_SECRET=<...>
```

> 不再用 `TEST_PROJECT_ID` —— Smoke 4 的核心断言之一就是 agent 必须**自动
> 选**「默认项目」,所以这里换成 `TEST_DEFAULT_PROJECT_ID` 给旁路验证用,
> 不传给 agent。

---

## 3. 指令文本

> 这个 case 的"agent input"是**一段自然语言**,不再像 Smoke 1/2/3 那样
> 把要做的 tm 操作一条条列出来。完整把决策权交给 agent。

### Phase 1(发起任务)

```
帮我做一份近期主流 AI Coding 工具的竞品分析报告。
重点对比 Cursor、Windsurf、Claude Code、Codex 这 4 个的核心功能、
定价、目标用户。不用做特别复杂,有个大概对比就行,这周五前给我,我准备拿来给团队评审。
```

> **设计意图**:刻意不指定项目、不指定 KB、不指定 issue 类型 —— 让 agent
> 自己判断"这是简单任务,默认项目 + 默认 KB 即可"。
> 「这周五前给我」「给团队评审」是跨时间信号:单人在对话里能很快做完的请求不再
> 弹建单卡,带上截止时间和评审后这条仍走 New-Issue Intake → Issue 闭环。

### Phase 3(确认)

```
确认
```

### Phase 7(验收)

```
确认验收
```

> Phase 3 / 7 是用户对 agent 卡片的应答,**短文本 + 一个明确动词**。
> agent 端的对应识别能力(把"确认"映射成确认执行、把"确认验收"映射成
> set_acceptance=true)也是这条 case 顺带在测的产品语义。

---

## 4. 断言总表(20 条)

### 卡片体(message body) — 12 条

| # | Phase | 断言 |
|---|---|---|
| 1 | 2 | "任务分析"卡片在 30s 内到达 |
| 2 | 2 | 卡片体含 "简单" 或 "single agent" 类语义关键词 |
| 3 | 2 | 卡片体含 "默认项目" |
| 4 | 2 | 卡片体含 "默认知识库" |
| 5 | 2 | 卡片体含确认询问(`是否确认 / 确认执行 / 是否开始` 任一) |
| 6 | 4 | "开始执行"卡片在用户确认后 15s 内到达 |
| 7 | 4 | 卡片体含 "已在项目「默认项目」" |
| 8 | 4 | 卡片体含 "开始执行" 或 "完成后会通知你验收" 字样 |
| 9 | 5–6 | 至少 1 张"执行进度"卡(含 `✅` / `进展` / `完成` 任一) |
| 10 | 6 | "交付"卡片在 phase 4 之后 ≤ 90s 内到达(简单任务上限) |
| 11 | 6 | 卡片体含 "请验收" |
| 12 | 8 | "验收完成"卡片在确认验收后 15s 内到达,且含 "已关闭" + "已归档" |

### 旁路状态(走 tm.js / kb.js 查后端) — 8 条

| # | 阶段 | 断言 |
|---|---|---|
| 13 | 4 之后 | `issue.list_in_project(默认项目)` 能找到一条新 issue,title 命中本轮 Phase 1 主题(如 "AI Coding 工具" / "竞品分析" 中任一关键词) |
| 14 | 4 之后 | 该 issue 的 `project_id` == `TEST_DEFAULT_PROJECT_ID` |
| 15 | 6 之后 | issue.status ∈ {`delivered`} (尚未 accept) |
| 16 | 6 之后 | `kb.search` 用 issue title 关键词搜,至少 1 条命中 page,且 page 所属 KB == `TEST_DEFAULT_KB_ID` |
| 17 | 8 之后 | issue.status == `accepted` |
| 18 | 8 之后 | issue.acceptance_source == `explicit` |
| 19 | 8 之后 | issue 在默认状态过滤(active)的 `issue.list_in_project` 中**不再出现**,但在 `status=archived` 过滤下能找回 |
| 20 | 8 之后 | KB 里那条产物 page 仍然存在(未被一并删除/trash) |

> **设计点**:#15 接受"delivered"而不是要求"executing → delivered"两次都
> 命中,是因为简单任务可能 sub-second 跑完,poll 1s 难抓中间态。Smoke 1
> 早期版本踩过这个坑,#15 这里就直接放宽。

---

## 5. 跑法

```bash
cd ~/zylos/workspace/zylos-openmax

COCO_API_URL=https://<your-bff-host> \
TEST_USER_TOKEN=<...> \
TEST_CONV_ID=<...> \
TEST_AGENT_ID=<...> \
TEST_DEFAULT_PROJECT_ID=<...> \
TEST_DEFAULT_KB_ID=<...> \
CF_ACCESS_CLIENT_ID=<...> CF_ACCESS_CLIENT_SECRET=<...> \
node docs/smoke-tests/smoke-4-simple-task-conversation.test.js
```

**典型耗时**:60 - 180 秒(简单任务上限,5 张卡片 + 2 次用户应答)。

退出码:
- `0` —— 全 20 条通过
- `1` —— 至少一条失败(stderr 打印失败位置 + 失败时已收到的卡片预览)
- `2` —— 必填 env 缺失 / 默认项目或 KB 不存在

---

## 6. 与 Smoke 1/2/3 的差别

| 维度 | Smoke 1/2/3 | Smoke 4 |
|---|---|---|
| 指令风格 | 显式列出每一步 tm 调用 | 一段自然语言,让 agent 决策 |
| 关注 | 状态机正确性 | UX 卡片正确性 + 自动决策正确性 |
| 卡片渲染 | 不要求 | **要求**(由 openmax v0.5 skill 实现) |
| 默认项目/KB 选用 | 必须显式传 | 必须 agent 自动选 |
| 用户多轮交互 | 0–1 次 | **2 次**(确认 + 验收) |
| 失败定位 | 通常是 tm/RPC 层 bug | 通常是 prompt / 卡片模板 bug |

Smoke 4 是 **第一个把"对话产品语义"纳入冒烟范围**的用例。后续 Smoke 5
对应同表的「复杂任务」行(多 Agent 协作 + Blueprint 审批 + Worker claim
分发,P0 同),沿用一样的"卡片体 + 旁路状态"双层断言架构。
