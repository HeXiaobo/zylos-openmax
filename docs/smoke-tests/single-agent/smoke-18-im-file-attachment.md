# Smoke 18 — IM 文件附件 round-trip(NL 驱动)

> **验证目标**:用户用自然语言让 agent 把一个本地文件**作为附件**发到当前
> 会话里(DM 模式),覆盖 cws-comm IM 上传链路(`/api/v1/conversations/
> {cid}/uploads/prepare` + finalize)+ `comm.send` 带 attachments 的消息体。
> 这条路径是 Smoke 11 (KB 上传)**没覆盖**的一面 —— Smoke 11 走的是
> `/api/v1/uploads/prepare`(KB 模式),不带 conversationId。
>
> 覆盖 **as.js**(IM 模式):
>   `as.upload {filePath, conversationId, mediaType?, ...}` →
>   底层 `uploadMedia()` 走 `/conversations/{cid}/uploads/prepare` +
>   `/conversations/uploads/finalize`,返回 `{mediaId, artifactId, fileName, mimeType, sizeBytes}`
>
> 覆盖 **comm.js**:
>   `comm.send` 带 `attachments: [{artifact_id, file_name, content_type, size_bytes}]`
>   的消息体(IMAGE/FILE 类型)
>
> 覆盖 **as.js**(下行验证):
>   `as.url` / `as.download` / `as.resolve`(test client 旁路确认 blob 内容一致)

---

## 1. 前置:test client 在 /tmp 造 fixture

```js
const imgPath = `/tmp/Smoke18-<TS>.png`   // ~8KB
```

Agent 在 host 上有 Bash 工具可以读 /tmp,所以 NL 直接给路径即可。

---

## 2. NL 文本(1 轮)

```
我本地有张图,路径 /tmp/Smoke18-<TS>.png,你帮我:
1. 把它作为附件发到我们这个 DM 里(不要走 KB,直接 IM 附件模式)
2. 发完用一条单独的文字消息回我,报 artifactId / fileName / sizeBytes

记得是 IM 模式上传(/conversations/{cid}/uploads/prepare),不是 KB 模式。
```

---

## 3. 断言表(8)

### 卡片体(3)

| # | 断言 |
|---|---|
| 1 | round1 文字回复在 90s 内到,且含 artifactId(uuid)+ fileName |
| 2 | 回复表达"已发 / 发完 / uploaded / 附件" 语义 |
| 3 | 回复含 sizeBytes(数字)且 ≥ 1024(fixture > 1KB) |

### 旁路(5)

| # | 阶段 | 断言 |
|---|---|---|
| 4 | round1 | `GET /conversations/{cid}/messages` 在 cursor 之后能找到一条 **type=IMAGE 或 FILE** 的 agent 消息(不是 AGENT_TEXT)|
| 5 | round1 | 该消息 `content.attachments[0].artifact_id` == 回复里报的 artifactId(同一份 blob)|
| 6 | round1 | 该消息 `content.attachments[0].file_name` 匹配 `/Smoke18-.+\.(png\|jpg\|jpeg)/`,`size_bytes` == 原 fixture 字节数 |
| 7 | round1 | `as.download {artifactId}` 拿到的本地文件 SHA-256 hash == 原 fixture hash(byte-for-byte 一致)|
| 8 | round1 | `as.resolve {uri:"artifact://{artifactId}"}` 返回的 URL 也能 GET 200 且 hash 同 #7 |

---

## 4. 跑法

```bash
node docs/smoke-tests/smoke-18-im-file-attachment.test.js
```

预期 ~60-90s(1 轮,fixture 很小,主要等 agent NL→action 反应时间)。

---

## 5. 备注

- IM 上传跟 KB 上传**共用同一个底层 prepare/finalize 形状**,只是路径前缀不同(`/conversations/{cid}/uploads/...` vs `/uploads/...`),body 字段也略不同(IM 不带 parent_id,KB 带)。本 smoke 严格验证 IM 模式那一条路径活着。
- 如果 cws-as 服务 / cws-comm 上传 pod 没起,prepare 阶段会撞 CF 502,assertion 1 直接 timeout。这跟 Smoke 11 早期撞的是同一个上游(见 2026-06-04 13:05 现场)。
- comm.send 支持两种带附件的写法:简写 `{text?, attachments:[...]}`(或字符串 `content` + 顶层 `attachments`),由 CLI 按附件类型生成 IMAGE / FILE 消息;或预构造的 `{content_type, body, attachments}` 对象。两种写法下每个附件都必须是 snake_case 的 `{artifact_id, file_name, content_type, size_bytes}`(`artifact_id` / `file_name` / `content_type` 为非空字符串,`artifact_id` 取 `as.upload` 返回的 `artifactId`),缺字段或带驼峰键(`artifactId` / `fileName` / `mimeType` / `contentType` / `sizeBytes`)会在发送前报错,不做任何改写。规则详见 `references/comm-operations.md`。
