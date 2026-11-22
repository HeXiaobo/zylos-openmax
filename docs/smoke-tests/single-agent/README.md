# Smoke Tests — Single Agent (OpenMax 0.5)

> 端到端冒烟测试,**单 agent 类**。验证用户经 IM(cws-comm WS 链路)给单个 agent
> 下达自然语言指令后,agent 能**完全自主**调用 zylos-openmax 的 CLI
> 完成 Issue / Task / Attempt 的状态机流转。本目录跟
> [`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/openmax/cws-deploy/-/blob/main/docs/smoke-test-design.md)
> 三个用例严格对齐,作为可执行实现。
>
> 父级 [`docs/smoke-tests/`](../) 按 agent 维度分类,本子目录承载所有"单 agent"用例。

---

## 用例清单

所有 smoke **都是 NL 驱动**(test client 发自然语言指令 → agent 自主决策跑 CLI → 双层断言:卡片体短语 + 后端旁路状态)。Smoke 0 是 cws-core REST 最小闭环(不经 agent runtime)。Smoke 13 / 16 会自动 provision 第二/第三个测试用户作为前置(自身幂等)。

| 用例 | 实际场景(NL 起点) | 主要触发的 CLI | 文档 | 脚本 |
|---|---|---|---|---|
| **0** | (脚本)用户 login → 建项目 → 归档 | auth/login + tm.project.* | [md](./smoke-0-project-create.md) | [test.js](./smoke-0-project-create.test.js) |
| **1** | "跑个 smoke-1 light issue 直到 accepted" | tm.issue/task/attempt(light 链) | [md](./smoke-1-light-single-agent.md) | [test.js](./smoke-1-light-single-agent.test.js) |
| **2** | "Smoke 2 heavy + blueprint + worker claim + KB" | tm.heavy + blueprint + worker claim + kb.page | [md](./smoke-2-heavy-blueprint-worker.md) | [test.js](./smoke-2-heavy-blueprint-worker.test.js) |
| **3** | "Smoke 3 拒收 → 返工 → 再交付" | tm.set_acceptance + 状态机边界 | [md](./smoke-3-rejection-rework.md) | [test.js](./smoke-3-rejection-rework.test.js) |
| **4** | 简单研究任务对话流(5 卡片) | tm.light + 卡片体序列 | [md](./smoke-4-simple-task-conversation.md) | [test.js](./smoke-4-simple-task-conversation.test.js) |
| **5** | 建 KB 研究工作区(folder + page + search) | kb.folder_create / page / search / node_* | [md](./smoke-5-kb-tree-and-files.md) | [test.js](./smoke-5-kb-tree-and-files.test.js) |
| **6** | 多轮文档编辑 + revision diff | kb.page_content_write / revisions / diff | [md](./smoke-6-page-revisions.md) | [test.js](./smoke-6-page-revisions.test.js) |
| **7** | 组织态势简报(我是谁/有谁/项目/会话) | core.me / member / project / comm.list | [md](./smoke-7-conversation-directory.md) | [test.js](./smoke-7-conversation-directory.test.js) |
| **8** | "建临时项目+issue,改 priority,挪过去,归档+恢复" | tm.project.update/archive/restore + issue.update/move_project + task.reassign | [md](./smoke-8-tm-metadata-edges.md) | [test.js](./smoke-8-tm-metadata-edges.test.js) |
| **9** | "起 heavy issue,blueprint 3 步合并成 2 步,worker claim 跑第一步" | blueprint.set_steps + task.list claimable + attempt 链 | [md](./smoke-9-blueprint-edges.md) | [test.js](./smoke-9-blueprint-edges.test.js) |
| **10** | "新建独立 KB,写一页,改 metadata + freeze,归档+恢复+删" | kb.create/get/update/archive/unarchive/delete + page_update/freeze/references/breadcrumb | [md](./smoke-10-kb-instance-lifecycle.md) | [test.js](./smoke-10-kb-instance-lifecycle.test.js) |
| **11** | "把这两个本地文件上传到 KB,告诉我怎么下载(不贴原始下载链接),挂个引用" | **as.\*** + kb.upload/file_create/file_preview/file_download/batch_download | [md](./smoke-11-as-kb-files.md) | [test.js](./smoke-11-as-kb-files.test.js) |
| **12** | "改 page 3 次,回滚到初版,丢回收站,恢复,永久删" | page_content_write / restore(revision) / trash / pages_trashed / restore_trash / delete | [md](./smoke-12-page-trash-restore.md) | [test.js](./smoke-12-page-trash-restore.test.js) |
| **13** | "拉同事 USER2 开群,发几条,标已读,删一条" | create_dm/group + send + get_messages + mark_read + delete_message | [md](./smoke-13-comm-conversations.md) | [test.js](./smoke-13-comm-conversations.test.js) |
| **14** | "离线后追平消息 + 搜 KB" | comm.sync + comm.search + list_conversations(includeArchived) | [md](./smoke-14-comm-sync-search.md) | [test.js](./smoke-14-comm-sync-search.test.js) |
| **15** | "我是谁 / 列 member / 列角色 / 切活跃 org" | core.me + member_get + role_list + org_switch | [md](./smoke-15-identity-and-roles.md) | [test.js](./smoke-15-identity-and-roles.test.js) |
| **16** | "邀请 USER3 入组;再邀请一个错邮箱然后撤回" | invitation_create / list / accept(by id) / revoke | [md](./smoke-16-invitations.md) | [test.js](./smoke-16-invitations.test.js) |
| **17** | "新建测试 org,切过去看看,切回原 org" | org_list + org_create + org_switch + project_list | [md](./smoke-17-multi-org.md) | [test.js](./smoke-17-multi-org.test.js) |
| **18** | "把本地图片作为附件发到我们 DM 里" | **as.upload(IM 模式)** + comm.send(attachments) + as.download/resolve(旁路)| [md](./smoke-18-im-file-attachment.md) | [test.js](./smoke-18-im-file-attachment.test.js) |

每条 smoke 都用 `sendInstruction` 触发 agent、`waitForCard` 等卡片体短语、再用 test client 直接调对应 CLI 旁路验证终态。**不强约束 agent 调了哪条 CLI**——只验证用户期望的结果到位。

---

## 共享 runner

[`lib/runner.js`](./lib/runner.js) 提供:

| 导出 | 用途 |
|---|---|
| `loadEnv()` | 校验 + 加载必需 env vars;`COCO_AUTH_TOKEN` 缺省 fallback 到 `TEST_USER_TOKEN`(带 warn) |
| `sendInstruction(env, text, opts)` | POST 指令到 cws-core(**当前 schema**:top-level `type` + 单 object content),注入 CF Access 头(若提供 env) |
| `waitForCompletion(env, predicate, opts)` | 轮询 issue 列表直到 `targetStatus`(默认 `accepted`);记录 `firstObservedStatus` + `statusTrace`;**默认 10 分钟超时**,超时时 dump 最后观测到的 issue/task/attempt 状态 |
| `runSmokeCase({...})` | Smoke 1 / Smoke 2 通用 wrapper(send + wait + assertions 三段式)|
| `tm(cmd, params)` / `listTasks(issueId)` / `listAttempts(taskId)` / `listIssuesInProject(projectId)` | tm.js CLI 调用封装 |
| `assertEq` / `assertTrue` / `assertIn` | 小型断言 helper,失败 `process.exit(1)` 并打印期望 vs 实际 |
| `log` / `ok` / `warn` / `die` | 标准化日志 |

---

## Env vars

```bash
# 必需
export COCO_API_URL=https://<your-bff-host>          # cws-core gateway(通常带 CF Access 保护)
export TEST_USER_TOKEN=<test user bearer JWT>          # /auth/login 拿到的 user access_token
export TEST_CONV_ID=<conversation uuid>                # user ↔ agent 的 DM 或 group
export TEST_AGENT_ID=<agent member uuid>               # agent 在测试 org 的 member id
export TEST_PROJECT_ID=<project uuid>                  # 用于 issue.list_in_project 过滤

# 可选 ——
export COCO_AUTH_TOKEN=<bearer>                        # 跟 TEST_USER_TOKEN 不同时才用;默认 fallback
export CF_ACCESS_CLIENT_ID=<...>.access                # 目标环境走 CF Access 时必填
export CF_ACCESS_CLIENT_SECRET=<...>                   # 同上
export COCO_TM_CLI=/path/to/tm.js                      # 覆盖默认 tm.js 路径
```

> **CF Access 必填场景**:<bff-host> 整个域名被 Cloudflare Zero Trust Access 保护。没带 service token 的请求会被 302 到 `bitlayer.cloudflareaccess.com/cdn-cgi/access/login`。本 runner 检测到两个 env 都设了才注入对应头,否则不加(留给 plain HTTP 部署场景)。
>
> **TEST_PROJECT_ID 怎么拿**:create-organization 时 cws-core 会尽力创建一个 `slug: inbox` 的默认 project;没有的话用 `node src/cli/tm.js project.create '{...}'` 手工建一个,或者 `node src/cli/tm.js project.list '{}'` 看 org 下已有项目。

---

## 跑单个用例

```bash
cd ~/zylos/workspace/zylos-openmax

node docs/smoke-tests/single-agent/smoke-1-light-single-agent.test.js
# 或
node docs/smoke-tests/single-agent/smoke-2-heavy-blueprint-worker.test.js
node docs/smoke-tests/single-agent/smoke-3-rejection-rework.test.js
```

每个用例独立工作:
- 用带毫秒时间戳的 title 创建 issue,**不需要清理状态**;多次跑会留下多个 issue,靠 title 隔离不会互相干扰
- 任意断言失败 `process.exit(1)` + stderr 打印失败字段
- 全部通过打印 `✅ Smoke N PASS` + duration + statusTrace

---

## 顺序跑全部用例

```bash
for f in docs/smoke-tests/single-agent/smoke-*.test.js; do
  echo "=========================================="
  echo "运行: $f"
  echo "=========================================="
  node "$f" || { echo "✗ $f FAILED"; exit 1; }
done
echo "✅ 所有 Smoke 用例通过"
```

> **注意**:agent runtime 是同一个 Claude session,接连多个用例之间建议**至少 1 分钟空闲间隔**让上一个对话完整收敛。Smoke 3 自身就涉及两轮指令 + 中间 set_acceptance(false),需要 agent 能处理"被打断 + 状态再启动"的语境切换。

---

## 与 cws-deploy 设计的对照

[`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/openmax/cws-deploy/-/blob/main/docs/smoke-test-design.md) 是冒烟测试的设计来源,描述:

- 跟 Harness 测试的边界(冒烟:main CLI + cws-core gateway 集成视角;Harness:超前功能,直连 cws-work)
- 三个用例的具体 tm.js / kb.js 调用流 + 断言要点
- 状态机守卫(rejected → executing 必须被拒;只能走 rejected → reopened → executing)

本目录是**可执行实现**:
- 把设计里的 22 个 tm.js / kb.js 命令翻译成黑盒 IM 指令,由 agent 自主组装调用
- 把每个 phase 的断言收敛成可机器验证的字段比对(见每个 `.md` 的 "断言总表")
- runner 处理 CF Access / cws-core schema / tm.js 路径解析等基础设施细节

如果设计文档跟实现有冲突,以**设计文档为准**;实现里若做了简化(例如 Smoke 2 用 1 个 Worker step + 2 个 Lead step 而不是 3 Worker step),会在用例 `.md` 的"与设计差异"段落里说清楚。

---

## 失败排查速查

| 现象 | 可能原因 | 排查 |
|---|---|---|
| `Missing required env: XXX` | env var 没 export | runner 头部检查所有必需 env |
| `sendInstruction HTTP 302 / Location: cloudflareaccess` | 缺 CF Access 头 | 设 `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` |
| `sendInstruction HTTP 422 ... expected required property type to be present` | 你 fork 了 runner 但 schema 改回了旧形状 | 对齐 `runner.js:sendInstruction` 的 body 形状 |
| `sendInstruction HTTP 401/403` | `TEST_USER_TOKEN` 失效/过期 | 重 `POST /auth/login` 拿新 access_token |
| `sendInstruction HTTP 404` | `TEST_CONV_ID` 不存在或测试 user 不是该会话 member | `core.me` 查身份 + `tm.js issue.list_in_project` 验 org 通联 |
| `tm.js {"error":"fetch failed"}` | tm.js 没走 CF Access,或 COCO_API_URL 不对 | 确认 `COCO_TM_CLI` 指向带 cf-access.js 的副本(默认就是 installed skill 那个) |
| `waitForCompletion timed out after 600000ms` | agent 没收到指令 / 卡某一步 | runner 自动 dump 最后观测;另看 agent runtime 日志 `pm2 logs zylos-openmax` |
| `first_observed_status ≠ executing`(Smoke 1)| TM 把 Light 也走了 draft | 查 cws-work 的 light mode 状态机定义 |
| Smoke 3 在 `set_acceptance(false)` 之后状态没到 `rejected` | issue.set_acceptance 入参 schema 漂移 | 看 tm.js set_acceptance 帮助 + cws-core /api/v1/issues/{id}/acceptance contract |

---

## 不在本目录范围

- **agent 给用户回复的 IM 文本内容** — 不验。功能正确性由 TM 状态字段覆盖
- **失败 / 重试 / 取消 / 超时** — 走单独 Smoke 系列
- **AS(ArtifactStore)集成** — 0.5 冒烟不涉及
- **多 agent 真正分布式**(不同 runtime)— Smoke 2 的 Worker 角色用同一个 agent 模拟,跟设计文档一致;真正多 agent 走 Harness 测试

---

## Design 参考

- 上游设计:[`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/openmax/cws-deploy/-/blob/main/docs/smoke-test-design.md)
- Agent skill 行为规范:[`cws-work/docs/skill-design/agent-skill-spec.md`](https://git.coco.xyz/openmax/cws-work/-/blob/main/docs/skill-design/agent-skill-spec.md)
- KB / AS 操作模式:[`cws-work/docs/skill-design/kb-as-operations-reference.md`](https://git.coco.xyz/openmax/cws-work/-/blob/main/docs/skill-design/kb-as-operations-reference.md)
