# AMTools AI Agent 操作手册

## 适用范围

本文档供在本机仓库中操作 AMTools 的 AI Agent 使用。所有命令默认从当前 Git 仓库根目录执行，不假定盘符、用户名或其他工作区。

| 模块 | 目录 | 责任 |
|---|---|---|
| AMDC | `apps/AMDC` | 账号认证、榜单采集、缓存、历史、Excel、飞书同步和本地看板 |
| AMDA | `skills/AMDA` | 已批准数据分析、国家分组、标准图表和飞书报告草稿 |
| Contracts | `packages/contracts` | 跨模块数据契约 |
| Orchestrator | `orchestrator` | 仓库级检查和流程编排 |

AMDC 与 AMDA 通过 `CollectionManifest` 或不可变数据快照交接，不直接读取对方的运行中间状态。

## 安全边界

- `apps/AMDC/amdc-config.json`、`.amdc-userdata*`、`Cache/`、`logs/` 和 `output/` 是本机私有状态，不得读取后贴入对话、提交或上传。
- AMDA 的固定资源地址只保存在本机私有资源配置，不写入仓库、日志或报告正文。
- 账号备份目标必须是私有仓库。不得把登录态复制到 AMTools、AI 或其他公开仓库。
- 语法检查、契约测试、只读诊断和 dry-run 可以直接执行。
- 真实采集、飞书同步、通知、正式文档写入、账号备份和远程推送需要用户明确授权。
- `--yes` 只是落实授权的命令参数，不构成授权本身。

## 环境定位

PowerShell 中先解析仓库根目录：

```powershell
$repoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw '当前目录不在 AMTools Git 仓库中' }
Set-Location -LiteralPath $repoRoot
```

AMDC 项目目录为 `Join-Path $repoRoot 'apps\AMDC'`，AMDA 项目目录为 `Join-Path $repoRoot 'skills\AMDA'`。不要硬编码本机盘符。

## 私有配置

AMDC 使用被 Git 忽略的 `apps/AMDC/amdc-config.json`。飞书表格和账号备份仓库地址位于：

```json
{
  "integrations": {
    "feishuSheetUrl": "",
    "accountRepositoryUrl": ""
  }
}
```

对应环境变量为 `AMDC_FEISHU_SHEET_URL` 和 `AMDC_ACCOUNT_REPOSITORY_URL`。`amdc config show --json` 只返回是否已配置，不返回地址。

AMDA 默认读取 `%LOCALAPPDATA%\am-market-analytics\resources.json`；`AM_MARKET_ANALYTICS_CONFIG` 可以覆盖路径。先运行 `skills/AMDA/scripts/verify-local-resource-config.ps1`，只记录 PASS/FAIL，不输出配置内容。

## 基础检查

```powershell
npm run cli:test
npm run contracts:test
npm run amdc:syntax
npm run amdc:test:contract
npm run amdc:test:feishu-order
npm run pipeline:dry-run
amtools doctor --json
amdc doctor --json
```

这些命令不得启动真实采集或写入外部服务。机器接口同时检查退出码和 JSON 中的 `ok` 字段：`0` 表示成功，`2` 表示参数或计划错误，`3` 表示环境或状态检查未通过，`1` 表示运行时错误。

## AMDC 人工流程

1. 执行 `amdc status` 检查账号状态。
2. 执行 `amdc start` 启动本地看板。
3. 在看板选择采集周、账号、品类、深度和采集模式。
4. 人工确认后启动采集。
5. 在历史记录中检查结果；飞书同步需要再次确认。

周锚点必须是周一，格式为 `YYYY-MM-DD`。缓存采集会在线核对目标周榜单；线上快照变化、重复排名、历史排名不一致或跨过定稿边界时，受影响品类自动转为全新采集。

## AMDC Agent 流程

Agent 必须先生成签名计划，再由用户审查：

```powershell
amdc collect plan --week 2030-01-07 --account .amdc-userdata --top-depth 100 --json
```

报告计划中的 `mode`、`weekAnchors`、`accounts`、`categories`、`topDepth`、`listOnly` 和 `skipExcel`。用户确认后才能执行：

```powershell
amdc collect run ".\apps\AMDC\Cache\plans\<plan-id>.json" --yes --json
amdc run status <batch-id> --json
amdc run wait <batch-id> --timeout-seconds 43200 --json
amdc history list --json
```

计划签名覆盖全部字段，编辑后会被拒绝。需要修改参数时重新生成计划。Agent 批次来源为 `ai`，不会自动同步飞书、发送定时通知或触发 AMDA。

同步单条历史记录需要单独授权：

```powershell
amdc sync feishu <history-id> --yes --json
```

## AMDA 流程

1. 校验本机私有资源配置。
2. 与用户确认分析截止日期和纳入、排除的周表。
3. 读取已授权的数据快照并完成数据质量检查。
4. 在 `skills/AMDA/output/charts/` 生成图表和中间文件。
5. 创建新的 Demo 文档并完成 API 回读和可见渲染检查。
6. 用户确认后才可覆盖正式文档；覆盖后重新回读和验收。

不得绕过 `skills/AMDA/SKILL.md` 中的固定资源、日期确认、报告契约和 Demo/正式版边界。

## Windows 计划任务

两个任务分别是每天09:05的账号状态检查与私有备份，以及每周三09:30的上周数据采集。仓库XML不包含本机路径；安装脚本会优先注入PowerShell 7，未安装时注入Windows PowerShell 5.1，并写入项目目录和脚本路径。

只读检查：

```powershell
amdc schedule doctor --json
```

安装或修复任务会修改系统状态，需要用户授权并在管理员PowerShell中执行：

```powershell
amdc schedule install --yes
amdc schedule doctor --json
```

任务使用`InteractiveToken`，执行用户必须保持登录，锁屏不影响运行。`Ready`只表示任务可运行，仍需检查`lastTaskResultHex`。任务失败时先核对实际PowerShell路径和版本、项目路径、私有配置、网络和登录态；运行时选择顺序为PowerShell 7优先、Windows PowerShell 5.1回退。

账号同步 dry-run 不推送仓库、不发送通知：

```powershell
$amdcDir = Join-Path $repoRoot 'apps\AMDC'
& $(if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { 'pwsh.exe' } else { 'powershell.exe' }) -NoProfile -File (Join-Path $amdcDir 'scripts\sync-account-profiles.ps1') -ProjectDir $amdcDir -DryRun
```

## 变更验证

代码修改后至少执行：

```powershell
git diff --check
npm run cli:test
npm run contracts:test
npm run amdc:syntax
npm run amdc:test:contract
npm run amdc:test:feishu-order
npm run pipeline:dry-run
```

涉及计划任务时增加 `amdc schedule doctor --json`；涉及 AMDA 时增加其资源、数据、图表和报告契约校验。未执行真实采集、飞书同步或正式写入时，反馈中必须明确说明。

## 禁止事项

- 不输出账号邮箱、令牌、Cookie、登录态目录内容或私有资源地址。
- 不删除有效登录态、配置、缓存或历史记录，除非用户明确指定范围。
- 不用真实周任务测试部署和迁移。
- 不把旧仓库或归档目录作为运行来源。
- 不以“命令无报错”代替结果回读、契约检查和可见验收。
