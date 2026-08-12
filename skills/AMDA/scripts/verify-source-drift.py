"""Compare the current workbook export with the previous export.

This check is deliberately non-blocking: a warning records historical
backfill or correction so the report remains reproducible without treating a
legitimate new weekly sheet as a failure.
"""

import argparse
import csv
import hashlib
import io
import json
import re
from pathlib import Path


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def signature(sheet):
    text = str(sheet.get("data", {}).get("annotated_csv", ""))
    clean = re.sub(r"(?m)^\[row=\d+\]\s?", "", text)
    rows = list(csv.reader(io.StringIO(clean)))
    header_index = next((i for i, row in enumerate(rows) if "应用标题" in row), None)
    if header_index is None:
        raise RuntimeError(f"缺少字段头:{sheet.get('name')}")
    header = rows[header_index]
    valid_rows = []
    for row in rows[header_index + 1 :]:
        if row and re.fullmatch(r"\d+", row[0].strip()):
            valid_rows.append(row[: len(header)] + [""] * max(0, len(header) - len(row)))
    canonical = json.dumps(
        {"header": header, "rows": valid_rows},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "records": len(valid_rows),
        "sha256": hashlib.sha256(canonical).hexdigest(),
    }


def sheet_map(payload):
    return {str(sheet["name"]): sheet for sheet in payload.get("sheets", [])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    current_payload = load(args.current)
    current_sheets = sheet_map(current_payload)
    current_signatures = {name: signature(sheet) for name, sheet in current_sheets.items()}
    result = {
        "current_source": current_payload.get("source", {}),
        "baseline_path": str(args.baseline),
        "baseline_found": Path(args.baseline).is_file(),
        "current_sheet_count": len(current_sheets),
        "status": "PASS",
        "new_sheets": [],
        "removed_sheets": [],
        "overlap_sheets": [],
        "record_count_changes": [],
        "content_changes": [],
    }

    if not result["baseline_found"]:
        result["message"] = "未找到上一份来源快照，本次建立首个可比基线"
    else:
        baseline_payload = load(args.baseline)
        baseline_sheets = sheet_map(baseline_payload)
        baseline_signatures = {name: signature(sheet) for name, sheet in baseline_sheets.items()}
        current_names = set(current_sheets)
        baseline_names = set(baseline_sheets)
        result["new_sheets"] = sorted(current_names - baseline_names)
        result["removed_sheets"] = sorted(baseline_names - current_names)
        overlap = sorted(current_names & baseline_names)
        result["overlap_sheets"] = overlap
        for name in overlap:
            current = current_signatures[name]
            baseline = baseline_signatures[name]
            if current["records"] != baseline["records"]:
                result["record_count_changes"].append({
                    "sheet": name,
                    "baseline": baseline["records"],
                    "current": current["records"],
                })
            if current["sha256"] != baseline["sha256"]:
                result["content_changes"].append(name)
        historical_changes = bool(result["removed_sheets"] or result["record_count_changes"] or result["content_changes"])
        if historical_changes:
            result["status"] = "WARN"
            result["message"] = "重叠历史工作表存在记录数或内容变化，已保留警告并继续分析"
        else:
            result["message"] = "重叠历史工作表未发现记录数或内容变化"

    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SOURCE_DRIFT_CHECK: {result['status']}")
    print(result["message"])
    if result["new_sheets"]:
        print(f"new_sheets={','.join(result['new_sheets'])}")
    if result["record_count_changes"]:
        print(f"record_count_changes={len(result['record_count_changes'])}")
    if result["content_changes"]:
        print(f"content_changes={len(result['content_changes'])}")


if __name__ == "__main__":
    main()
