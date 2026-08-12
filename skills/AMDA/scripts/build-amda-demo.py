import argparse
import html
import json
import re
from pathlib import Path


def esc(value):
    return html.escape(str(value), quote=False)


def rich(value):
    rendered = esc(value)
    for token in ("<br/>", "<latex>", "</latex>", "<ol>", "</ol>", '<li seq="auto">', "</li>"):
        rendered = rendered.replace(esc(token), token)
    return rendered


def pct(value):
    if value is None:
        return "--"
    number = float(value)
    if abs(number) < 0.0005:
        number = 0.0
    return f"{number:.1f}%"


def signed(value):
    if value is None:
        return "--"
    number = float(value)
    if abs(number) < 0.0005:
        number = 0.0
    return f"{number:+.1f}%"


def latest_direction(previous, current):
    """Describe the latest week using the actual preceding week value."""
    if previous is None or current is None:
        return "最新周数据不足"
    delta = float(current) - float(previous)
    if delta > 0.05:
        return "最新周上升"
    if delta < -0.05:
        return "最新周回落"
    return "最新周基本持平"


def li(text, nested=None):
    suffix = nested if nested else ""
    return f'<li seq="auto">{rich(text)}{suffix}</li>'


def ordered(items):
    return "<ol>" + "".join(items) + "</ol>"


def callout(items, emoji, background, border):
    background_colors = {
        "light-blue": "rgb(240,244,255)",
        "light-green": "rgb(240,251,239)",
    }
    border_colors = {
        "blue": "rgb(130,167,252)",
        "green": "rgb(142,224,133)",
    }
    background = background_colors.get(background, background)
    border = border_colors.get(border, border)
    return f'<callout emoji="{emoji}" background-color="{background}" border-color="{border}">{ordered([li(item) for item in items])}</callout>'


def table(headers, rows, widths, left_columns=None):
    left_columns = set(left_columns or [])
    colgroup = "<colgroup>" + "".join(f'<col width="{width}"/>' for width in widths) + "</colgroup>"
    head = "<thead><tr>" + "".join(
        f'<th background-color="rgb(242,243,245)" vertical-align="middle"><p align="center"><b>{esc(header)}</b></p></th>'
        for header in headers
    ) + "</tr></thead>"
    body_rows = []
    for row in rows:
        cell_parts = []
        for index, value in enumerate(row):
            align = "left" if index in left_columns else "center"
            cell_parts.append(f'<td vertical-align="middle"><p align="{align}">{rich(value)}</p></td>')
        cells = "".join(cell_parts)
        body_rows.append(f"<tr>{cells}</tr>")
    return f"<table>{colgroup}{head}<tbody>{''.join(body_rows)}</tbody></table>"


def svg_board(path):
    content = Path(path).read_text(encoding="utf-8")
    if "<svg" not in content:
        raise RuntimeError(f"Chart is not SVG: {path}")
    return f'<whiteboard type="svg">{content}</whiteboard>'


def find_cite(source_path):
    source = Path(source_path).read_text(encoding="utf-8")
    if source.lstrip().startswith("{"):
        payload = json.loads(source)
        source = str(payload["data"]["document"]["content"])
    match = re.search(r"<cite\b[^>]*>(?:.*?)</cite>|<cite\b[^>]*/>", source, re.S)
    if not match:
        raise RuntimeError("Formal document readback does not contain the workbook cite")
    return match.group(0)


def nested(lines):
    return ordered([li(line) for line in lines])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis", required=True)
    parser.add_argument("--report-data", required=True)
    parser.add_argument("--cite-source", required=True)
    parser.add_argument("--charts-dir", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    analysis = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    chart_data = json.loads(Path(args.report_data).read_text(encoding="utf-8"))
    metadata = analysis["metadata"]
    report = analysis["report"]
    start = metadata["start_date"]
    end = metadata["end_date"]
    sheets = metadata["sheet_count"]
    records = metadata["records"]
    download_valid = metadata["download_valid_records"]
    income_valid = metadata["income_valid_records"]
    download_coverage = 100.0 * download_valid / records if records else 0.0
    income_coverage = 100.0 * income_valid / records if records else 0.0

    global_rows = {row["group"]: row for row in report["global_rows"]}
    trend_rows = {row["label"]: row for row in report["trend_rows"]}
    category_rows = {row["category"]: row for row in report["category_rows"]}
    category_country_rows = {row["category"]: row for row in report["category_country_rows"]}
    diagnosis_rows = {row["group"]: row for row in report["diagnosis_rows"]}

    d = chart_data["global"]["download"]
    i = chart_data["global"]["income"]
    dr = analysis["global"]["download_recent"]
    ir = analysis["global"]["income_recent"]
    t3 = trend_rows["下载侧T3"]
    income = trend_rows["收入侧US+T1"]
    coverage = trend_rows["收入数据覆盖率"]
    latest_t3 = chart_data["trend"]["downloadT3"][-1]
    latest_income = chart_data["trend"]["incomeUSPlusT1"][-1]
    latest_coverage = chart_data["trend"]["coverage"][-1]
    previous_t3 = chart_data["trend"]["downloadT3"][-2]
    previous_income = chart_data["trend"]["incomeUSPlusT1"][-2]
    previous_coverage = chart_data["trend"]["coverage"][-2]
    t3_latest_direction = latest_direction(previous_t3, latest_t3)
    income_latest_direction = latest_direction(previous_income, latest_income)
    coverage_latest_direction = latest_direction(previous_coverage, latest_coverage)
    min_t3, max_t3 = min(chart_data["trend"]["downloadT3"]), max(chart_data["trend"]["downloadT3"])
    min_income, max_income = min(chart_data["trend"]["incomeUSPlusT1"]), max(chart_data["trend"]["incomeUSPlusT1"])
    min_cov, max_cov = min(chart_data["trend"]["coverage"]), max(chart_data["trend"]["coverage"])

    high_coverage = sorted(analysis["category"]["rows"], key=lambda row: -float(row["coverage"]))[:2]
    high_iaa = sorted(analysis["category"]["rows"], key=lambda row: -float(row["download"]))[:3]
    low_coverage = sorted(analysis["category"]["rows"], key=lambda row: float(row["coverage"]))[:3]

    opening = f'<p>基于{find_cite(args.cite_source)}的全量历史周度数据整理，供审校确认。确认前不会覆盖正式市场分析文档。</p>'
    chunks = [f"<title>{esc(args.title)}</title>", opening]

    chunks.append("<h1>核心观点速读</h1>")
    chunks.append(ordered([
        li(f"截至{end}，下载侧T3最近4周均值为{pct(t3['recent'])}，前4周均值为{pct(t3['previous'])}，4周均值变化为{signed(t3['change'])}；最新周为{pct(latest_t3)}，{t3_latest_direction}，仍是IAA主规模层"),
        li(f"收入侧US+T1最近4周均值为{pct(income['recent'])}，前4周均值为{pct(income['previous'])}，4周均值变化为{signed(income['change'])}；最新周为{pct(latest_income)}，{income_latest_direction}，收入数据覆盖率由{pct(coverage['previous'])}变为{pct(coverage['recent'])}，收入侧只作方向性观察"),
        li(f"{high_coverage[0]['name']}和{high_coverage[1]['name']}的收入数据覆盖率分别为{pct(high_coverage[0]['coverage'])}和{pct(high_coverage[1]['coverage'])}，收入侧结构相对清晰"),
        li(f"{high_iaa[0]['name']}、{high_iaa[1]['name']}和{high_iaa[2]['name']}下载侧T2+T3分别为{pct(high_iaa[0]['download'])}、{pct(high_iaa[1]['download'])}和{pct(high_iaa[2]['download'])}，IAA规模集中在T2/T3"),
        li(f"印度和巴西是下载侧跨品类重点，东南亚全历史下载侧为{pct(chart_data['regions']['rows'][3]['download'])}、收入侧为{pct(chart_data['regions']['rows'][3]['income'])}；收入侧高占比国家只作方向性参考"),
    ]))

    chunks.append("<h1>数据范围与口径</h1>")
    scope_items = [
        li(f"固定工作簿内本次纳入{start}至{end}的{sheets}个有效周度工作表，包含{start}和{end}"),
        li(f"样本为{records}条“应用×周”记录，覆盖Launcher、PDF阅读器、休闲、壁纸、文件恢复、杀毒软件、清理、超休闲7个品类"),
        li(f"Top5国家地区份额的计算方式：仅当分母大于0且记录存在有效Top5数据时，单条记录内的归一化份额为<latex>p_{{i,g}}^{{(s)}}=x_{{i,g}}^{{(s)}}/\\sum_{{h\\in\\mathrm{{Top5}}_{{i}}^{{(s)}}}}x_{{i,h}}^{{(s)}}</latex>，再以<latex>P_{{g}}^{{(s)}}=\\frac{{1}}{{N_s}}\\sum_{{i\\in V_s}}p_{{i,g}}^{{(s)}}\\times100\\%</latex>在应用×周记录之间等权聚合。结果表示Top5国家地区份额结构，不代表实际下载量或结算收入" + nested([
            "i (index)：一条“应用×周”记录",
            "s (side)：统计侧别，取下载侧或收入侧",
            "g (group)：待计算的国家地区分组",
            "h (Top5 country or region index)：一条记录内Top5国家或地区的索引",
            "x (raw share value)：记录内某国家地区的原始Top5份额值",
            "p (normalized share)：单条记录内归一化后的份额",
            "P (aggregated share)：跨应用×周记录等权聚合后的份额",
            "V_s (valid record set)：侧别s存在有效Top5数据且分母大于0的记录集合",
            "N_s (record count)：有效记录集合V_s中的记录数",
            "Top5 (top five countries or regions)：每条记录中排名前五的国家或地区",
        ])),
        li(f"收入数据覆盖率的定义和计算方式：某一品类中存在有效收入国Top5信息的“应用×周”记录占该品类全部“应用×周”记录的比例，仅当全部记录数大于0时计算<latex>C_c=\\frac{{R_c}}{{A_c}}\\times100\\%</latex>" + nested([
            "C (coverage rate)：收入数据覆盖率",
            "c (category)：品类",
            "R_c (valid income records)：品类c中存在有效收入国Top5信息的记录数",
            "A_c (all records)：品类c中全部“应用×周”记录数",
        ])),
        li(f"下载侧有效记录{download_valid}条，收入侧有效记录{income_valid}条，下载侧覆盖率{pct(download_coverage)}，收入数据覆盖率{pct(income_coverage)}。主分层按US、T1、T2、T3顺序互斥归类，IN、拉美、东南亚为可重叠观察组。下载侧只用于判断IAA (in-app advertising)用户规模和潜在广告库存偏好，收入侧只用于判断IAP (in-app purchase)收入偏好"),
    ]
    chunks.append(ordered(scope_items))

    chunks.append("<h1>一、全球分组概览：规模层与收入层分离</h1>")
    chunks.append(svg_board(Path(args.charts_dir) / "01-global.svg"))
    chunks.append(callout([
        f"全历史下载侧T3为{pct(d['T3'])}、T2为{pct(d['T2'])}，合计{pct(d['T3'] + d['T2'])}；最近4周T3为{pct(dr['T3'])}，IAA规模仍由T2/T3承接",
        f"全历史收入侧US为{pct(i['US'])}、T1为{pct(i['T1'])}、T3为{pct(i['T3'])}；最近4周US+T1为{pct(ir['US'] + ir['T1'])}，IAP重点以各品类收入侧分组和覆盖率为准",
        f"收入数据覆盖率全历史{pct(income_coverage)}、最近4周{pct(coverage['recent'])}，收入侧跨分层比较只作方向性观察",
    ], "💡", "light-blue", "blue"))
    chunks.append(table(
        ["主分层", "下载侧全历史", "下载侧最近4周", "收入侧全历史", "收入侧最近4周", "分组角色"],
        [
            ["US", pct(d["US"]), pct(dr["US"]), pct(i["US"]), pct(ir["US"]), "收入侧高价值层<br/>下载侧占比低"],
            ["T1", pct(d["T1"]), pct(dr["T1"]), pct(i["T1"]), pct(ir["T1"]), "与US共同构成<br/>收入侧高价值层"],
            ["T2", pct(d["T2"]), pct(dr["T2"]), pct(i["T2"]), pct(ir["T2"]), "IAA规模补充层<br/>收入侧占比中等"],
            ["T3", pct(d["T3"]), pct(dr["T3"]), pct(i["T3"]), pct(ir["T3"]), "IAA主规模层<br/>收入侧占比最高"],
        ], [66, 108, 117, 108, 117, 304]
    ))
    chunks.append(callout([
        "下载侧规模结构由T2/T3主导，收入侧结构由US+T1与T3共同构成",
        "T3下载侧与收入侧占比都较高，是双向占比靠前的分层",
        "收入数据覆盖率不足时，收入侧跨分层结论保持方向性",
    ], "✅", "light-green", "green"))

    chunks.append("<h1>二、近期趋势与数据可信度</h1>")
    chunks.append(svg_board(Path(args.charts_dir) / "02-trend.svg"))
    chunks.append(callout([
        f"{sheets}周内下载侧T3周度范围为{pct(min_t3)}至{pct(max_t3)}，最新周{end}为{pct(latest_t3)}，{t3_latest_direction}但仍处于主要区间",
        f"收入侧US+T1周度范围为{pct(min_income)}至{pct(max_income)}，最新周为{pct(latest_income)}，{income_latest_direction}且需结合覆盖率解读",
        f"收入数据覆盖率周度范围为{pct(min_cov)}至{pct(max_cov)}，最新周为{pct(latest_coverage)}，{coverage_latest_direction}，单周结论不宜外推",
    ], "💡", "light-blue", "blue"))
    chunks.append(table(
        ["指标", "全历史", "前4周", "最近4周", "近期变化", "近期特征"],
        [
            ["下载侧T3", pct(t3["all"]), pct(t3["previous"]), pct(t3["recent"]), signed(t3["change"]), f"维持主要区间<br/>{t3_latest_direction}"],
            ["收入侧US+T1", pct(income["all"]), pct(income["previous"]), pct(income["recent"]), signed(income["change"]), f"{income_latest_direction}<br/>需结合覆盖率解读"],
            ["收入数据覆盖率", pct(coverage["all"]), pct(coverage["previous"]), pct(coverage["recent"]), signed(coverage["change"]), f"{coverage_latest_direction}<br/>不做精确收入排序"],
        ], [122, 66, 65, 75, 80, 412]
    ))
    chunks.append("<p></p>")
    chunks.append(callout([
        f"T3下载侧最近4周均值为{pct(t3['recent'])}，前4周均值为{pct(t3['previous'])}，表内近期变化比较两段4周均值；最新周为{pct(latest_t3)}，结构方向未变",
        f"收入侧US+T1最近4周均值为{pct(income['recent'])}，但覆盖率为{pct(coverage['recent'])}；最新周为{pct(latest_income)}，{income_latest_direction}，升幅需结合样本解读",
        f"{sheets}周内收入侧波动较大，单周结论不宜外推",
    ], "✅", "light-green", "green"))

    chunks.append("<h1>三、品类×分组结构：规模层与收入层分开看</h1>")
    chunks.append(svg_board(Path(args.charts_dir) / "03-category.svg"))
    chunks.append(callout([
        f"{high_iaa[0]['name']}、{high_iaa[1]['name']}和{high_iaa[2]['name']}下载侧T2+T3分别为{pct(high_iaa[0]['download'])}、{pct(high_iaa[1]['download'])}和{pct(high_iaa[2]['download'])}，IAA规模主要来自T2/T3",
        f"{high_coverage[0]['name']}和{high_coverage[1]['name']}收入数据覆盖率分别为{pct(high_coverage[0]['coverage'])}和{pct(high_coverage[1]['coverage'])}，收入侧更适合做横向观察",
        f"{low_coverage[0]['name']}收入数据覆盖率仅为{pct(low_coverage[0]['coverage'])}，收入侧结构仅作方向性参考",
    ], "💡", "light-blue", "blue"))

    cat_table_rows = []
    for name in ["Launcher", "PDF阅读器", "休闲", "壁纸", "文件恢复", "杀毒软件、清理", "超休闲"]:
        row = category_rows[name]
        iap_layer = row["iap_layer"]
        iap_value = row.get("iap_value", row.get("income_focus"))
        iap_note = "<br/>".join([
            f"下载侧T2+T3为{pct(row['download_focus'])}",
            f"收入侧{iap_layer}为{pct(iap_value)}",
            f"收入数据覆盖率为{pct(row['coverage'])}",
        ])
        cat_table_rows.append([name, row["iaa_layer"], iap_layer, pct(row["coverage"]), iap_note])
    chunks.append(table(["品类", "IAA规模层", "IAP观察层", "收入数据覆盖率", "近期信号"], cat_table_rows, [122, 90, 89, 122, 397], left_columns=[2]))
    chunks.append(callout([
        "休闲和超休闲收入数据覆盖率较高，收入侧结构更适合作为横向观察",
        "Launcher、壁纸和文件恢复下载侧T2+T3占比较高，IAA规模结构较稳定",
        "杀毒软件、清理与低覆盖率品类的收入侧结构仅作方向性参考",
    ], "✅", "light-green", "green"))

    chunks.append("<h2>分品类IAA重点国家</h2>")
    chunks.append(svg_board(Path(args.charts_dir) / "04-countries.svg"))
    chunks.append(callout([
        "印度在全部7个品类均居下载侧前列，巴西在各品类均进入重点国家组合",
        "印度尼西亚在多个品类进入前五，南亚和东南亚国家组合随品类分化",
        "本图只展示固定T2/T3范围内的下载侧重点国家及其份额，不能替代收入侧判断",
    ], "💡", "light-blue", "blue"))
    country_table_rows = []
    for name in ["Launcher", "PDF阅读器", "休闲", "壁纸", "文件恢复", "杀毒软件、清理", "超休闲"]:
        row = category_country_rows[name]
        names = []
        shares = []
        for item, display in zip(row["all_recent"], row["countries"]):
            names.append(display.split("（", 1)[0])
            shares.append(f"{pct(item['share'])}/{pct(item['recent'])}")
        country_table_rows.append([name, "T2/T3", "<br/>".join(names), "<br/>".join(shares)])
    chunks.append(table(["品类", "IAA核心分组", "下载侧重点国家", "全历史/最近4周"], country_table_rows, [122, 174, 236, 288]))
    chunks.append(callout([
        "印度和巴西是跨品类下载侧重点国家，印度尼西亚在多个品类进入前五",
        "Launcher、壁纸和休闲的重点国家组合更集中于印度及亚洲与拉美国家",
        "分品类国家表只解释IAA规模层结构，不把下载侧重点延伸为IAP重点",
    ], "✅", "light-green", "green"))

    chunks.append("<h1>四、组内国家诊断：国家用于解释分组稳定性</h1>")
    chunks.append(svg_board(Path(args.charts_dir) / "05-regions.svg"))
    chunks.append(callout([
        f"T3下载侧全历史为{pct(d['T3'])}、最近4周为{pct(dr['T3'])}，重点国家集中在印度、印度尼西亚、巴基斯坦、越南和孟加拉国",
        f"拉美下载侧全历史为{pct(chart_data['regions']['rows'][2]['download'])}，东南亚下载侧为{pct(chart_data['regions']['rows'][3]['download'])}，补充组与主分层可重叠",
        f"收入侧有效记录覆盖率为{pct(income_coverage)}，国家收入结构只作方向性观察",
    ], "💡", "light-blue", "blue"))
    diag_rows = []
    diag_order = ["US", "T1", "T2", "T3", "IN", "拉美", "东南亚"]
    display_names = {"US": "US", "T1": "T1", "T2": "T2", "T3": "T3", "IN": "IN观察组", "拉美": "拉美观察组", "东南亚": "东南亚观察组"}
    for group in diag_order:
        row = diagnosis_rows[group]
        diag_rows.append([
            display_names[group],
            "<br/>".join(row["countries"]),
            pct(row["download_all"]),
            pct(row["download_recent"]),
            f"{pct(row['income_all'])}/{pct(row['income_recent'])}",
            row["observation"],
        ])
    chunks.append(table(["分组/观察组", "重点国家", "下载侧全历史", "下载侧最近4周", "收入全/近4周", "观察结论"], diag_rows, [108, 94, 108, 117, 111, 282]))
    chunks.append(callout([
        "T3下载侧重点国家集中，印度和印度尼西亚的变化会影响分组近期波动",
        "拉美和东南亚用于补充区域变化，不与US、T1、T2、T3相加",
        "收入侧覆盖率不足时，组内国家收入结构只作方向性观察",
    ], "✅", "light-green", "green"))

    chunks.append("<h1>五、总结</h1>")
    summary_items = [
        li("整体数据特征", nested([
            f"数据范围与记录：本次分析覆盖{sheets}个有效周度工作表和{records}条“应用×周”记录，下载侧有效记录{download_valid}条，收入侧有效记录{income_valid}条",
            f"下载侧结构：下载侧Top5国家地区份额更多集中在T3和T2，全历史合计{pct(d['T3'] + d['T2'])}",
            f"收入侧结构：收入侧US+T1合计{pct(i['US'] + i['T1'])}，T3仍占{pct(i['T3'])}",
            "口径边界：这些结果描述Top5国家地区份额结构，不能替代实际下载量或结算收入",
        ])),
        li("发展趋势", nested([
            f"下载侧趋势：下载侧T3最近4周为{pct(t3['recent'])}，前4周为{pct(t3['previous'])}，最新周为{pct(latest_t3)}，方向维持高位",
            f"收入侧趋势：收入侧US+T1最近4周为{pct(income['recent'])}，但收入数据覆盖率为{pct(coverage['recent'])}，收入侧上升只能作方向性观察",
            f"补充地区组：拉美下载侧为{pct(chart_data['regions']['rows'][2]['download'])}，东南亚下载侧为{pct(chart_data['regions']['rows'][3]['download'])}，两组只用于解释区域变化",
            f"可信度边界：收入数据覆盖率最近4周为{pct(coverage['recent'])}，趋势信号不外推为精确收入结论",
        ])),
        li("IAA品类与国家重心", nested([
            f"品类结构：{high_iaa[0]['name']}、{high_iaa[1]['name']}、{high_iaa[2]['name']}下载侧T2+T3为{pct(high_iaa[0]['download'])}、{pct(high_iaa[1]['download'])}、{pct(high_iaa[2]['download'])}",
            "重点国家：印度和巴西是跨品类下载侧重点，印度尼西亚在多个品类进入前五",
            "国家边界：下载侧国家只用于解释IAA规模结构，不延伸为IAP收入判断",
        ])),
        li("IAP重点", nested([
            f"高覆盖品类：{high_coverage[0]['name']}和{high_coverage[1]['name']}收入数据覆盖率分别为{pct(high_coverage[0]['coverage'])}和{pct(high_coverage[1]['coverage'])}",
            f"收入侧结构：{high_coverage[0]['name']}和{high_coverage[1]['name']}的收入侧US+T1分别为{pct(category_rows[high_coverage[0]['name']]['income_focus'])}和{pct(category_rows[high_coverage[1]['name']]['income_focus'])}",
        ])),
        li("覆盖率限制", nested([
            f"收入侧覆盖率：全历史为{pct(income_coverage)}，最近4周为{pct(coverage['recent'])}",
            f"低覆盖品类：{low_coverage[0]['name']}、{low_coverage[1]['name']}和{low_coverage[2]['name']}的收入数据覆盖率较低",
            "判断口径：收入侧缺失记录不按零收入处理，低覆盖率品类只保留方向性观察",
        ])),
    ]
    chunks.append(ordered(summary_items))
    chunks.append("<p>注：所有比例均按“应用×周”记录等权聚合Top5国家地区份额。下载侧缺失不参与下载计算，收入侧缺失不按零收入处理</p>")

    Path(args.output).write_text("\n".join(chunks) + "\n", encoding="utf-8")
    print(json.dumps({"status": "AMDA_DEMO_XML_SAVED", "title": args.title, "whiteboards": 5, "tables": 5, "h1": 7}, ensure_ascii=False))


if __name__ == "__main__":
    main()
