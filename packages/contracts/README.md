# AMTools Contracts

跨 AMDC、AMDA 和 orchestrator 的机器可读契约。

## CollectionManifest

`collection-manifest.schema.json` 描述一次采集批次及其可供分析的同步结果。manifest 只包含批次元数据和路径/状态，不包含账号凭据、访问令牌或云资源私密配置。

分析流程必须使用 `status=synced` 的 manifest，并检查 `artifacts.snapshot` 或 `artifacts.workbook` 是否明确绑定到本批次。
