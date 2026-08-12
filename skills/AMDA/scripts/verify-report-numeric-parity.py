"""Check numeric parity from canonical analysis through charts and Demo tables."""

import argparse
import html
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path


def pct(value):
    return f"{float(value):.1f}%"


def chart_tokens(value):
    number = float(value)
    return {f"{number:.1f}%", f"{number:g}%"}


def close(label, actual, expected, errors, tolerance=0.11):
    if abs(float(actual) - float(expected)) > tolerance:
        errors.append(f"{label}: actual={actual}, expected={expected}")


def parse_tables(content):
    tables = []
    for table in re.findall(r"<table\b[^>]*>.*?</table>", content, re.S):
        body = re.search(r"<tbody>(.*?)</tbody>", table, re.S)
        if not body:
            continue
        rows = []
        for row in re.findall(r"<tr>(.*?)</tr>", body.group(1), re.S):
            cells = []
            for cell in re.findall(r"<td[^>]*>.*?<p[^>]*>(.*?)</p>.*?</td>", row, re.S):
                text = re.sub(r"<[^>]+>", " ", html.unescape(cell))
                cells.append(re.sub(r"\s+", " ", text).strip())
            rows.append(cells)
        tables.append(rows)
    return tables


def read_document_content(path):
    content = Path(path).read_text(encoding="utf-8")
    if content.lstrip().startswith("{"):
        payload = json.loads(content)
        content = payload.get("data", {}).get("document", {}).get("content", "")
    return str(content)


def numbers(text):
    return [float(value) for value in re.findall(r"(?<![A-Za-z])([+-]?\d+(?:\.\d+)?)%", text)]


def chart_text(path):
    root = ET.parse(path).getroot()
    return " ".join("".join(node.itertext()).strip() for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "text")


def check_country_chart_geometry(report_data, path, errors):
    root = ET.parse(path).getroot()
    rects = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "rect"]
    for index, row in enumerate(report_data["categoryCountries"]["rows"]):
        target_y = 314.0 + index * 66.0
        actual = [float(node.get("width")) for node in rects if abs(float(node.get("y", "nan")) - target_y) < 0.01]
        shares = [float(item["share"]) for item in row["countries"]]
        other = float(row.get("other", max(0.0, 100.0 - sum(shares))))
        expected = [round(1200.0 * share / 100.0, 1) for share in shares]
        expected.append(round(1200.0 * other / 100.0, 1))
        if len(actual) != len(expected):
            errors.append(f"Chart 04-countries.svg row {row['name']} has {len(actual)} bars, expected {len(expected)}")
            continue
        for bar_index, (actual_width, expected_width) in enumerate(zip(actual, expected)):
            if not math.isclose(actual_width, expected_width, abs_tol=0.2):
                errors.append(f"Chart 04-countries.svg {row['name']} bar {bar_index}: width={actual_width}, expected={expected_width}")
        if not math.isclose(sum(actual), 1200.0, abs_tol=0.2):
            errors.append(f"Chart 04-countries.svg {row['name']} must fill 100% of the bar, got {sum(actual)}")


def check_analysis_to_report_data(analysis, report_data, errors):
    for side in ("download", "income"):
        for group in ("US", "T1", "T2", "T3"):
            close(f"report-data.global.{side}.{group}", report_data["global"][side][group], analysis["global"][side][group], errors)

    for key in ("downloadT3", "incomeUSPlusT1", "coverage"):
        actual = report_data["trend"][key]
        expected = analysis["trend"][key]
        if len(actual) != len(expected):
            errors.append(f"report-data.trend.{key}: length={len(actual)}, expected={len(expected)}")
            continue
        for index, (a, e) in enumerate(zip(actual, expected)):
            close(f"report-data.trend.{key}[{index}]", a, e, errors)

    analysis_categories = {row["name"]: row for row in analysis["category"]["rows"]}
    for row in report_data["category"]["rows"]:
        expected = analysis_categories[row["name"]]
        for key in ("download", "income", "coverage"):
            close(f"report-data.category.{row['name']}.{key}", row[key], expected[key], errors)

    analysis_countries = {row["name"]: row for row in analysis["categoryCountries"]["rows"]}
    for row in report_data["categoryCountries"]["rows"]:
        expected = analysis_countries[row["name"]]["countries"]
        actual = row["countries"]
        if [item["country"] for item in actual] != [item["country"] for item in expected]:
            errors.append(f"report-data.categoryCountries.{row['name']}: country order/set differs")
        for item, source in zip(actual, expected):
            close(f"report-data.categoryCountries.{row['name']}.{item['country']}", item["share"], source["share"], errors)
        expected_other = max(0.0, 100.0 - sum(float(item["share"]) for item in expected))
        close(f"report-data.categoryCountries.{row['name']}.other", row.get("other", expected_other), expected_other, errors)

    for actual, expected in zip(report_data["regions"]["rows"], analysis["regions"]["rows"]):
        if actual["name"] != expected["name"]:
            errors.append(f"report-data.regions: row name {actual['name']} != {expected['name']}")
        for key in ("download", "income"):
            close(f"report-data.regions.{actual['name']}.{key}", actual[key], expected[key], errors)


def check_demo_tables(analysis, demo_content, errors):
    tables = parse_tables(demo_content)
    if len(tables) != 5:
        errors.append(f"Demo table count={len(tables)}, expected=5")
        return
    report = analysis["report"]

    expected_global = report["global_rows"]
    for actual, expected in zip(tables[0], expected_global):
        values = [value for cell in actual[1:5] for value in numbers(cell)]
        expected_values = [expected[key] for key in ("download_all", "download_recent", "income_all", "income_recent")]
        if len(values) != 4:
            errors.append(f"Demo global row {expected['group']} has {len(values)} numeric values")
        else:
            for index, (value, target) in enumerate(zip(values, expected_values)):
                close(f"Demo.global.{expected['group']}[{index}]", value, target, errors)

    expected_trend = report["trend_rows"]
    for actual, expected in zip(tables[1], expected_trend):
        values = [value for cell in actual[1:5] for value in numbers(cell)]
        expected_values = [expected[key] for key in ("all", "previous", "recent", "change")]
        if len(values) != 4:
            errors.append(f"Demo trend row {expected['label']} has {len(values)} numeric values")
        else:
            for index, (value, target) in enumerate(zip(values, expected_values)):
                close(f"Demo.trend.{expected['label']}[{index}]", value, target, errors)

    expected_category = report["category_rows"]
    for actual, expected in zip(tables[2], expected_category):
        values = numbers(actual[3]) + numbers(actual[4])
        expected_values = [expected["coverage"], expected["download_focus"], expected["iap_value"], expected["coverage"]]
        if len(values) != 4:
            errors.append(f"Demo category row {expected['category']} has {len(values)} numeric values")
        else:
            for index, (value, target) in enumerate(zip(values, expected_values)):
                close(f"Demo.category.{expected['category']}[{index}]", value, target, errors)

    expected_countries = report["category_country_rows"]
    for actual, expected in zip(tables[3], expected_countries):
        values = numbers(actual[3])
        expected_values = [value for item in expected["all_recent"] for value in (item["share"], item["recent"])]
        if len(values) != len(expected_values):
            errors.append(f"Demo categoryCountries row {expected['category']} has {len(values)} numeric values")
        else:
            for index, (value, target) in enumerate(zip(values, expected_values)):
                close(f"Demo.categoryCountries.{expected['category']}[{index}]", value, target, errors)

    expected_diag = report["diagnosis_rows"]
    for actual, expected in zip(tables[4], expected_diag):
        values = numbers(actual[2]) + numbers(actual[3]) + numbers(actual[4])
        expected_values = [expected[key] for key in ("download_all", "download_recent", "income_all", "income_recent")]
        if len(values) != 4:
            errors.append(f"Demo diagnosis row {expected['group']} has {len(values)} numeric values")
        else:
            for index, (value, target) in enumerate(zip(values, expected_values)):
                close(f"Demo.diagnosis.{expected['group']}[{index}]", value, target, errors)


def check_chart_values(analysis, report_data, charts_dir, errors):
    expected = {
        "01-global.svg": [
            report_data["global"][side][group]
            for side in ("download", "income")
            for group in ("US", "T1", "T2", "T3")
        ],
        "02-trend.svg": [report_data["trend"][key][-1] for key in ("downloadT3", "incomeUSPlusT1", "coverage")],
        "03-category.svg": [value for row in report_data["category"]["rows"] for value in (row["download"], row["income"], row["coverage"])],
        "04-countries.svg": [item["share"] for row in report_data["categoryCountries"]["rows"] for item in row["countries"]],
        "05-regions.svg": [value for row in report_data["regions"]["rows"] for value in (row["download"], row["income"])],
    }
    for name, values in expected.items():
        path = Path(charts_dir) / name
        if not path.is_file():
            errors.append(f"Missing chart {name}")
            continue
        if name == "04-countries.svg":
            check_country_chart_geometry(report_data, path, errors)
            continue
        text = chart_text(path)
        for value in values:
            tokens = chart_tokens(value)
            if not any(token in text for token in tokens):
                errors.append(f"Chart {name} is missing source value {pct(value)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis", required=True)
    parser.add_argument("--report-data", required=True)
    parser.add_argument("--demo", required=True)
    parser.add_argument("--charts-dir", required=True)
    args = parser.parse_args()

    analysis = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    report_data = json.loads(Path(args.report_data).read_text(encoding="utf-8"))
    demo_content = read_document_content(args.demo)
    errors = []
    check_analysis_to_report_data(analysis, report_data, errors)
    check_demo_tables(analysis, demo_content, errors)
    check_chart_values(analysis, report_data, args.charts_dir, errors)
    if errors:
        print("REPORT_NUMERIC_PARITY: FAIL")
        for error in errors:
            print(f"- {error}")
        raise SystemExit(1)
    print("REPORT_NUMERIC_PARITY: PASS")


if __name__ == "__main__":
    main()
