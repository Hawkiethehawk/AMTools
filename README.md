# AMTools

AMTools 是面向应用市场研究的数据采集与分析工具集，统一包含 AMDC、AMDA 和跨模块编排。

当前版本：`1.0`。AMDC和AMDA作为仓库内组件，不再维护独立版本。

公开仓库：`https://gitee.com/Hawkiethehawk/AMTools`。

## 模块

- `apps/AMDC`：账号认证、榜单采集、国别富化、缓存、历史记录、Excel、飞书同步和本地看板。
- `skills/AMDA`：已批准数据的统计分析、国家分组、IAA/IAP 洞察、标准图表和飞书报告草稿。
- `packages/contracts`：AMDC 与 AMDA 共用的数据契约。
- `orchestrator`：仓库级检查、契约校验和流程编排。

AMDC 和 AMDA 保持独立运行边界，只通过版本化契约交换数据。账号登录态、缓存、日志、运行产物和本地资源配置均被 Git 忽略。

## 安装

需要 Node.js 18+、Python 3、PowerShell 7 和 `openpyxl`。Windows 使用 PowerShell 7 运行部署脚本：

```powershell
git clone https://gitee.com/Hawkiethehawk/AMTools.git
Set-Location .\AMTools
pwsh.exe -NoProfile -File .\apps\AMDC\scripts\deploy.ps1
```

部署脚本安装仓库依赖，注册 `amtools` 和 `amdc`，并将 AMDA 注册到本机 Agent Skill 目录。飞书工具链使用根项目锁定的 `@larksuite/cli`，不依赖全局版本。

## 私有配置

运行 `amdc setup` 后，在被 Git 忽略的 `apps/AMDC/amdc-config.json` 中填写本机配置。飞书表格和账号备份仓库分别使用：

```json
{
  "integrations": {
    "feishuSheetUrl": "",
    "accountRepositoryUrl": ""
  }
}
```

也可以使用 `AMDC_FEISHU_SHEET_URL` 和 `AMDC_ACCOUNT_REPOSITORY_URL` 临时覆盖。账号备份仓库必须保持私有。

AMDA 的数据工作簿和正式文档地址保存在 `%LOCALAPPDATA%\am-market-analytics\resources.json`，也可以通过 `AM_MARKET_ANALYTICS_CONFIG` 指定其他本机文件。真实资源地址、令牌和账号信息不得写入仓库。

## 命令入口

人工操作 AMDC 时使用本地看板；Agent 使用同一 CLI 的 JSON 接口。`amtools amdc ...` 仅保留兼容转发。

```powershell
amdc doctor --json
amdc status --json
amdc start
amdc collect plan --week 2030-01-07 --json

amtools doctor --json
amtools version --json
amtools amda analyze --raw <raw-json> --output <analysis-json>
amtools pipeline validate .\tests\fixtures\collection-manifest.example.json
```

`amdc config show --json` 只返回私有集成是否已配置，不输出资源地址。真实采集、飞书同步、正式文档写入和远程推送均需要用户明确授权。

## 检查

```powershell
npm run cli:test
npm run contracts:test
npm run amdc:syntax
npm run amdc:test:contract
npm run amdc:test:feishu-order
npm run pipeline:dry-run
```

## 许可

`apps/AMDC` 的许可见其 `LICENSE`。其他目录如未提供单独许可文件，则保留相应权利。
