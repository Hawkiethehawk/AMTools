import argparse
import json
from pathlib import Path


IAA_CODES = set(
    "AE AT BE BR CH CL CR CY CZ EE EG FI GR GU HR HU IE IL IS IT KW MO MX NG PL PR QA RU SV TH TR VI ZA "
    "AF AL DZ AS AD AO AG AR AM AW AZ BS BH BD BB BY BZ BJ BM BT BO BA BW BN BG BF BI KH CM CV KY CF TD CO KM CG CD CI CU DJ DM DO EC GQ ET FJ GF PF GA GM GE GH GL GD GP GT GN GW GY HT HN IN ID IR IQ JM JO KZ KE KI KG LA LV LB LS LR LY LT LU MK MG MW MV ML MT MQ MR MU MF MD MN ME MA MZ MM NA NP NC NI NE OM PK PW PS PA PG PY PE PH PT RE RO RW KN LC VC SA SN RS SC SL SK SI SB SO LK SD SR SZ SY TJ TL TG TT TN TM TC UG UA UY UZ VE VN VG YE ZM ZW SS TZ CW FM MP SX VU MY".split()
)


def number(value):
    value = float(value)
    if abs(value) > 100:
        value /= 100.0
    rounded = round(value, 1)
    return 0.0 if rounded == 0 else rounded


def normalized_side(values):
    result = {key: number(value) for key, value in values.items()}
    result["other"] = round(100.0 - sum(result[key] for key in ("US", "T1", "T2", "T3")), 1)
    if result["other"] < 0:
        raise RuntimeError(f"Rounded global side exceeds 100: {result}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    metadata = source["metadata"]
    start = metadata["start_date"]
    end = metadata["end_date"]

    category_rows = []
    for row in source["category"]["rows"]:
        category_rows.append({
            "name": row["name"],
            "download": number(row["download"]),
            "income": number(row["income"]),
            "coverage": number(row["coverage"]),
        })

    category_country_rows = []
    for row in source["categoryCountries"]["rows"]:
        candidates = []
        for country in row["countries"]:
            code = str(country["country"])
            if code in IAA_CODES:
                candidates.append({"country": code, "share": number(country["share"])})
        candidates.sort(key=lambda item: (-item["share"], item["country"]))
        if len(candidates) < 5:
            raise RuntimeError(f"{row['name']} has fewer than five T2/T3 country rows")
        countries = candidates[:5]
        other = number(100.0 - sum(item["share"] for item in countries))
        if other < 0:
            raise RuntimeError(f"{row['name']} country shares exceed 100%: {countries}")
        category_country_rows.append({"name": row["name"], "countries": countries, "other": other})

    trend = source["trend"]
    report = {
        "global": {
            "subtitle": "下载侧与收入侧的Top5国家地区份额结构·单位：%",
            "download": normalized_side(source["global"]["download"]),
            "income": normalized_side(source["global"]["income"]),
        },
        "trend": {
            "subtitle": f"{start}至{end}·按周统计·单位：%",
            "dates": [date[5:].replace("-", "/") for date in trend["dates"]],
            "downloadT3": [number(value) for value in trend["downloadT3"]],
            "incomeUSPlusT1": [number(value) for value in trend["incomeUSPlusT1"]],
            "coverage": [number(value) for value in trend["coverage"]],
        },
        "category": {
            "note": "同一品类中，上下两条分别对应下载T2+T3与收入US+T1；右列为收入数据覆盖率",
            "rows": category_rows,
        },
        "categoryCountries": {
            "note": "每个品类展示下载侧T2/T3范围内Top5重点国家及全历史份额；其余浅灰为其他/未纳入重点范围；柱长按0–100%绝对比例展示",
            "rows": category_country_rows,
        },
        "regions": {
            "note": "IN、拉美、东南亚为可重叠观察组，不与主分层相加；US为主分层，仅为对照纳入此图",
            "rows": [
                {"name": row["name"], "download": number(row["download"]), "income": number(row["income"])}
                for row in source["regions"]["rows"]
            ],
        },
    }
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": "REPORT_DATA_SAVED", "sheets": metadata["sheet_count"], "records": metadata["records"], "charts": 5}, ensure_ascii=False))


if __name__ == "__main__":
    main()
