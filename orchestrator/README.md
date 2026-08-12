# AMTools Pipeline

编排层负责把 AMDC 的批次结果交给 AMDA。第一阶段只实现 manifest 校验和 dry-run，避免在总入口中隐式启动真实采集、飞书同步或正式文档覆盖。

## 入口

```powershell
pwsh -NoProfile -File .\orchestrator\run-pipeline.ps1 `
  -ManifestPath .\tests\fixtures\collection-manifest.example.json `
  -DryRun
```

后续真实 pipeline 必须显式区分 `collect`、`analyze` 和 `pipeline`，并沿用 AMDC/AMDA 各自的授权边界。
