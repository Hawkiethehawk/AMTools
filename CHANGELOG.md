# Changelog

所有AMTools重要变更统一记录在此文件中。AMDC和AMDA不再维护独立版本。

## [1.0维护更新] - 2026-08-13

维护标签：`patch-20260813-163632`

### 变更

- 将项目规则集中到仓库根目录，并删除AMDC子目录中的重复规则入口。
- 扩充项目README，补充功能、安装、命令、采集、分析、自动化与安全说明，并加入脱敏后的看板截图。
- 账号同步通知绕过故障代理，增加重试、超时控制和最终失败上抛。

### 验证

- `pwsh -NoProfile -File apps/AMDC/scripts/account-sync.test.ps1`：通过。
- `npm run cli:test`：通过。
- `npm run amdc:syntax`：通过。

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
