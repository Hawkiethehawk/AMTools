# AMTools Pipeline

编排层负责把 AMDC 的批次结果交给 AMDA。总入口继续只做 manifest 校验和 dry-run，不隐式启动真实采集或飞书同步；AMDC 定时路径在 Demo 全量验收通过后，由 `apps/AMDC/scripts/run_amda_after_amdc.ps1` 调用 AMDA 正式发布器完成正式文档局部覆盖和回读验收。

## 入口

```powershell
pwsh -NoProfile -File .\orchestrator\run-pipeline.ps1 `
  -ManifestPath .\tests\fixtures\collection-manifest.example.json `
  -DryRun
```

后续真实 pipeline 必须显式区分 `collect`、`analyze` 和 `pipeline`，并沿用 AMDC/AMDA 各自的授权边界。
