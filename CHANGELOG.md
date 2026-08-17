# Changelog

所有AMTools重要变更统一记录在此文件中。AMDC和AMDA不再维护独立版本。

## [1.0维护更新] - 2026-08-17

维护标签：`patch-20260817-093616`

### 变更

- 修复AMDC账号登录态探针瞬时超时后集中返回UNKNOWN的问题：保持账号检测并发不变，增加分段退避、抖动和`Retry-After`处理，并在账号同步日志中记录不含凭据的状态类别、HTTP状态、尝试次数与耗时。
- 修复AMDC同一采集周存在多条历史记录时的保留、替换、取消恢复和删除行为；删除看板中的采集周记录时同步清理该周全部现代及旧版记录。
- 修复AMDA定时Demo目标识别、首次写入、重试恢复和既有Demo复验流程；绑定单一注册目标，增加写入前空文档校验与无需重写的确定性复验入口。
- 修复AMDA飞书样式语义、XML片段读取、标题校验、表格布局、正式版一致性及白板预览格式识别，避免等价颜色误报、片段解析失败、错误目标写入和JPEG/PNG扩展名不一致导致的误判。
- 增加账号探针策略、PowerShell语法、Demo目标、飞书样式语义和正式版一致性专项测试，并扩展AMDC看板契约覆盖。

### 验证

- `npm run amdc:syntax`：通过。
- `npm run amdc:test:contract`：通过。
- `npm run amdc:test:feishu-order`：通过。
- `npm run cli:test`：通过。
- `npm run contracts:test`：通过。
- `npm run pipeline:dry-run`：通过。
- `lark-style-semantics.test.ps1`、`verify-amda-demo-target.test.ps1`和`verify-formal-parity.test.ps1`：通过。
- AMDC账号同步手动生产验证：10个账号全部首次探针通过，私有备份仓库推送与三次通知均成功。
- `git diff --check`：通过。

## [1.0维护更新] - 2026-08-13

维护标签：`patch-20260813-172345`

### 变更

- AMDC、AMDA、看板、部署、计划任务、账号备份和定时采集统一兼容Windows PowerShell 5.1，并继续优先使用PowerShell 7。
- Windows计划任务在找不到PowerShell 7时自动回退到Windows PowerShell 5.1；WSL可回退调用`powershell.exe`，原生Linux仍使用`pwsh`。
- 支持通过`AMDC_POWERSHELL`显式指定PowerShell运行时，并补充README、运维文档和契约测试中的兼容性说明。
- PowerShell脚本与AMDA SVG处理显式使用兼容的UTF-8读写方式，避免Windows PowerShell 5.1下出现中文乱码或XML损坏。

### 验证

- `npm run amdc:syntax`：通过。
- `npm run amdc:test:contract`：通过。
- `npm run cli:test`：通过。
- Windows PowerShell 5.1下的21个AMDC和AMDA PowerShell脚本语法解析：通过。
- Windows PowerShell 5.1下的看板契约、账号同步隔离、计划任务`-WhatIf`和AMDA触发器`DryRun`验证：通过。
- Windows PowerShell 5.1下的AMDA数据、图表、表格、报告契约、文档结构和正式版一致性校验：通过。
- `amdc schedule doctor --json`与看板健康检查：通过。

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
