# 对话内通用渠道连接 — OpenMAX Tasks

- [x] **T1** 增加 `channel.connect` 参数规划与四个平台白名单（AC-1）。
- [x] **T2** 写入通用 `openmax.channel-qr.v1` content/metadata 消息，并最小化模型 stdout（AC-1、AC-5）。
- [x] **T3** 对 `already_connected` 和 `connection_in_progress` 不发二维码、不启动 watcher（AC-7）。
- [x] **T4** 将扫码授权与 Binding 等待拆成 5 分钟/17 分钟两个阶段（AC-6）。
- [x] **T5** watcher 异常时仍发送失败终态并清理私有状态文件（AC-6）。
- [x] **T6** 覆盖四平台消息、敏感输出边界、扫码过期、Binding pending/error/timeout 和最终读取测试（AC-1、AC-3、AC-5、AC-6、AC-7）。
- [x] **T7** 补齐 requirements/design/tasks，与 Core/FE 使用同一 AC-1～AC-9，并声明微信/WhatsApp 为 Phase-1 非目标。
- [x] **T8** 已运行全部 `src/**/*.test.js`。

## Definition of Done

- Tool 模型输出与本地状态都遵守数据最小化边界。
- 扫码成功不会因二维码 TTL 到期而误报 Binding 失败。
- watcher 的所有终态都可见且有界。
- 三仓使用同一 Spec ID、AC 编号和 Phase-1 边界。
