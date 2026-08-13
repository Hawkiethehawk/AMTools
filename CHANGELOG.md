# Changelog

所有AMTools重要变更统一记录在此文件中。AMDC和AMDA不再维护独立版本。

## [1.0.1] - 2026-08-13

### 修复

- AMDC 看板首次进入或旧版默认设置迁移时，默认选择全部登录态有效或已有有效令牌的账号，不再固定选择前三个账号。
- 仅在用户实际调整账号复选框或使用全部启用/停用操作时，将账号池记录为手动选择，保留后续自定义设置。

### 版本规则

- AMTools 恢复三段 SemVer：修复递增 Patch，功能或 UI 更新递增 Minor，破坏兼容性更新递增 Major。
- 版本对象每次远端发布都更新版本记录并创建同版本标签。

### 验证

- AMDC 看板脚本语法检查：通过。
- AMDC 看板契约测试：通过。
- AMTools CLI 契约测试：通过。

## [1.0] - 2026-08-12

### 变更

- AMTools启用仓库级统一版本，AMDC和AMDA取消独立版本。
- 版本号统一使用“主版本.次版本”两级格式。
- 统一CLI、项目文档和AMDC看板只展示AMTools版本。
- AMDC既有CHANGELOG保留为统一版本体系启用前的组件历史。

### 验证

- `npm run cli:test`：通过。
- `npm run contracts:test`：通过。
- `npm run amdc:syntax`：通过。
- `npm run amdc:test:contract`：通过。
- `npm run amdc:test:feishu-order`：通过。
- `npm run pipeline:dry-run`：通过。
