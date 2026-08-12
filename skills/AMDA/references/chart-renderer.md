# 图表渲染流程

五张图表使用固定SVG模板和批准的独立国家图渲染器生成。模型或数据处理脚本只输出结构化JSON，不直接生成坐标和SVG。

## 数据输入

以`examples/current-report-data.json`为字段示例，必须包含`global`、`trend`、`category`、`categoryCountries`和`regions`五个对象。

- `global`提供下载侧和收入侧的US、T1、T2、T3、other百分比；每侧合计必须为100%。
- `trend`提供全部日期和三组等长序列；序列值必须落在固定30%–65%坐标轴内。
- `category`固定7行，提供品类名、下载、收入和覆盖率。
- `categoryCountries`固定7行，每行固定5个T2/T3国家代码及其份额，并同时供国家图和国家表使用。
- `regions`固定US、IN、拉美、东南亚4行，数值不能超过固定35%坐标轴。

## 渲染命令

```powershell
pwsh -File scripts/render-market-charts.ps1 `
  -DataPath examples/current-report-data.json `
  -OutputDir output/charts
```

渲染器会读取`templates/`，写入`01-global.svg`、`02-trend.svg`、`03-category.svg`、`04-countries.svg`和`05-regions.svg`；前三张及第五张依次调用三个归一化脚本，国家图由`render-category-countries-chart.ps1`按同一画布契约生成，最后统一运行`verify-chart-layout.ps1`。只有输出`MARKET_CHART_RENDER: PASS`时，才允许将SVG写入飞书画板。

## 更新原则

更新时只改变JSON中的数据、日期和必要的说明文字。不得复制旧SVG后手工移动节点，不得为单次数据新增独立卡片、调整横向坐标或改变五张图的结构。
