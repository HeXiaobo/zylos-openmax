# Smoke 15 — 身份/角色/Org Switch(NL 驱动)

> **验证目标**:用户用自然语言问 agent "我是谁 / 这组织里有谁 / 能分配
> 哪些角色 / 把活跃 org 切到 X" —— 跟 Smoke 7 的 directory 简报同款套路,
> 但聚焦 identity + roles + org_switch。
>
> 覆盖 **core.js**:`core.me`、`core.member_get`、`core.role_list`、
>   `core.org_switch`(本 smoke 用同 org no-op 验证调用面)
>
> 不覆盖(gavin 排除):`core.platform_agent_delete`(`core.platform_agent_create` 已移除,OPENM-1069)

---

## 1. NL 文本

```
帮我盘一下我的身份和这个组织的角色情况:
1. 我是谁(返 member_id + role + display name + kind)
2. 这组织里有多少 member(列前 3 个的 name + kind),挑一个不是我的 member 去 get 一下,
   把那个 member 的字段告诉我
3. 这个 org 里有哪些角色可以分配(role_list,scope=org)
4. 把活跃 org 切到我当前这个 org(同 org 是 no-op,但需要走通 org_switch),
   切完再 me 一次确认 org_id 还是原来这个

整理成一条结构化简报。
```

---

## 2. 断言表(9)

### 卡片体(4)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 120s 内到,含 member_id(uuid)+ role |
| 2 | 1 | 含 member 列表语义 + 另一个 member 详情 |
| 3 | 1 | 含 role / 角色 列表 |
| 4 | 1 | 含 org_switch 已切完 / no-op 语义 |

### 旁路(5)

| # | 阶段 | 断言 |
|---|---|---|
| 5 | round1 | core.me 返 member_id + org_id |
| 6 | round1 | core.member_list ≥ 1 |
| 7 | round1 | core.role_list 数组含 owner/member/admin slugs 任一 |
| 8 | round1 | 切完后 core.me.org_id 不变 |
| 9 | round1 | 旁路直接调 core.org_switch(目标 = 当前 org)真的返了 200 信封:`org_id` 与入参一致 + `access_token` 是非空 string —— 防止 CLI 静默 400 / 无 body 时被断言 8 漏过(2026-06-04 root-caused 过一次) |

---

## 3. 跑法

预期 2-3 分钟。
