# Smoke 11 — AS 工件 + KB 文件集成(NL 驱动)

> **验证目标**:用户用自然语言让 agent 把本地两个文件上传到默认 KB,
> 告知下载方式(不贴原始下载链接),在另一个 folder 下挂一份引用,试一下批量下载。验证
> agent 能用 `as.upload / as.url / as.download / as.resolve / kb.upload /
> kb.file_create / kb.file_preview / kb.file_download / kb.file_batch_download`
> 这一组文件向命令完成"研究材料归档 + 共享"的真实场景。
>
> 唯一覆盖 **as.js**(整个文件)的 smoke。

---

## 1. 前置:test client 在 /tmp 造 fixture

```js
const pngPath = `/tmp/Smoke11-<TS>.png`   // ~8KB,TS 入字节避免 dedup
const mdPath  = `/tmp/Smoke11-<TS>.md`    // ~12KB markdown text
```

Agent 在 host 上有 Bash 工具可以读 /tmp,所以 NL 直接给路径即可。

---

## 2. NL 文本

### Round 1 — 上传 + 拿链接

```
我本地有两个研究材料,在 /tmp/Smoke11-<TS>.png 和 /tmp/Smoke11-<TS>.md,
你帮我:
1. 这两个文件都上传到默认知识库根目录(用 KB 高层 upload 接口)
2. 上传完告诉我每个文件怎么下载

报给我两个 artifactId + 两个 nodeId + 下载方式。
```

### Round 2 — 挂引用 + 批量下载

```
顺手再做两件事:
1. 在默认 KB 下面新建一个 folder 叫 "Smoke11-<TS>/refs",
   把刚才那个 PNG 文件(用 artifactId)在这个新 folder 下挂一份引用(file_create)
2. 然后批量下载这两个文件(原 PNG 和 MD,用 batch_download),
   验证一次能拿到两个 URL

完成后报新 folder id、引用 file 节点 id、batch_download 返回了几条记录。
```

---

## 3. 断言表(11)

### 卡片体(5)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 150s 内到,含 ≥ 2 artifactId,且**不含**原始下载链接(短时效 / 可能一次性,只给 agent 当场取用) |
| 2 | 1 | round1 表达"上传完成"语义 |
| 3 | 2 | round2 在 90s 内到,含 folder id + 引用 file id + "batch / 批量" 语义 |
| 4 | 2 | round2 提到批量下载返回 ≥ 2 条 |
| 5 | 2 | round2 提到 "Smoke11-<TS>/refs" folder |

### 旁路(6)

| # | 阶段 | 断言 |
|---|---|---|
| 6 | round1 | KB 树里能找到一个 file 节点的 name 含 `Smoke11-<TS>.png` 或 `.md` |
| 7 | round1 | 旁路下载第一个文件 → byte hash == 原 fixture |
| 8 | round2 | KB 树里找到 folder `Smoke11-<TS>/refs` |
| 9 | round2 | 该 folder 下至少 1 个 child(是 PNG 引用) |
| 10 | round2 | 该引用 child 的 artifact_id == 原 PNG 的 artifactId(同一份 blob) |
| 11 | round2 | kb.file_batch_download(2 个 nodeId)返 ≥ 2 条 |

---

## 4. 跑法

```bash
node docs/smoke-tests/smoke-11-as-kb-files.test.js
```

预期 3-5 分钟。
