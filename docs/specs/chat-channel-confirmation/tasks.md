# 实施清单

- [x] Core 短期确认记录、Human 确认与扫码轮询绑定
- [x] OpenMAX 确认卡与后台确认等待，保留原 QR/Binding watcher
- [x] FE 通用确认按钮、失败/过期状态、SDK 临时例外登记
- [x] 安全回归、并发/时效、Runtime、FE 集成与 E2E 验证
- [x] 更新旧规范的授权假设与部署说明
- [x] 治理评估：沿用已有约定，无需新增全局框架规则
- [ ] 三仓配套部署后的真实平台扫码联调；本轮未操作真实渠道授权
- [ ] Core HTTP 契约发布后，由 SDK 负责人完成 typed path 迁移

## 本地验证（2026-09-07）

- Core：make ci、verify-boundaries、确认服务 race 测试通过；HTTP 回归覆盖 owner/admin、Agent-admin 拒绝、范围替换、未确认 Poll、只读确认查询及重复确认。
- OpenMAX：src 下798个测试通过，含 channel 的16个测试。根 npm test 会额外跑需要真实环境配置的 smoke/integration，因缺环境变量不通过，不能将单元测试结果当作真实扫码验收。
- FE：类型检查、lint、35个相关单测通过；全量 Web 4802 passed / 9 skipped；共享 QR 组件3个测试通过。
- E2E：2个场景（确认成功/403拒绝）各复跑5次，最终10/10通过；包含真实 UI→API 请求体断言、375px和浅/深色截图。不是对真实 Core/平台的集成授权证明。
- 本机 E2E 显式使用空闲端口3468和 legacy 测试登录，避免原3456服务、.env.local 的 Logto 干扰；测试文件临时测量/请求结束竞态已修正。全量 Web 的扫描测试需暂移 macOS apps/.DS_Store 后运行，测试完成恢复，不修改该无关测试。
- 本次提交不包含本地 dev.sh / port-forward 脚本或用户已有 next.config.ts 改动；运行目录同步与备份不属于仓库提交。
