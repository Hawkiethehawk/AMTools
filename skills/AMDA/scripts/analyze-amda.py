import argparse
import csv
import datetime as dt
import io
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "output" / "charts"
RAW_PATH = ROOT / "all-sheets-csv.json"
OUT_PATH = ROOT / "analysis-data.json"


CATEGORIES = [
    "Launcher",
    "PDF阅读器",
    "休闲",
    "壁纸",
    "文件恢复",
    "杀毒软件、清理",
    "超休闲",
]
MAIN_GROUPS = ["US", "T1", "T2", "T3"]

# The country names and group membership below mirror references/report-contract.md.
# Country codes are the codes present in the fixed workbook's Top5 fields.
COUNTRY_NAMES = {
    "AE": "阿联酋", "AR": "阿根廷", "AT": "奥地利", "AU": "澳大利亚",
    "AZ": "阿塞拜疆", "BD": "孟加拉国", "BE": "比利时", "BH": "巴林",
    "BR": "巴西", "BY": "白俄罗斯", "CA": "加拿大", "CH": "瑞士",
    "CL": "智利", "CN": "中国", "CO": "哥伦比亚", "CZ": "捷克",
    "DE": "德国", "DK": "丹麦", "DO": "多米尼加共和国", "DZ": "阿尔及利亚",
    "EC": "厄瓜多尔", "EG": "埃及", "ES": "西班牙", "FI": "芬兰",
    "FR": "法国", "GB": "英国", "GE": "格鲁吉亚", "GR": "希腊",
    "HK": "中国香港", "HU": "匈牙利", "ID": "印度尼西亚", "IE": "爱尔兰",
    "IL": "以色列", "IN": "印度", "IQ": "伊拉克", "IR": "伊朗",
    "IT": "意大利", "JO": "约旦", "JP": "日本", "KH": "柬埔寨",
    "KR": "韩国", "KW": "科威特", "KZ": "哈萨克斯坦", "LB": "黎巴嫩",
    "MA": "摩洛哥", "MM": "缅甸", "MO": "中国澳门", "MX": "墨西哥",
    "MY": "马来西亚", "NG": "尼日利亚", "NL": "荷兰", "NO": "挪威",
    "NZ": "新西兰", "OM": "阿曼", "PE": "秘鲁", "PH": "菲律宾",
    "PK": "巴基斯坦", "PL": "波兰", "PT": "葡萄牙", "QA": "卡塔尔",
    "RO": "罗马尼亚", "RU": "俄罗斯", "SA": "沙特阿拉伯", "SE": "瑞典",
    "SG": "新加坡", "TH": "泰国", "TR": "土耳其", "TW": "中国台湾",
    "UA": "乌克兰", "US": "美国", "UY": "乌拉圭", "UZ": "乌兹别克斯坦",
    "VN": "越南", "ZA": "南非",
}

GROUP_CODES = {
    "US": {"US"},
    "T1": {"AU", "CA", "DE", "DK", "ES", "FR", "HK", "JP", "KR", "NL", "NO", "NZ", "SE", "SG", "TW", "GB"},
    "T2": set("AE AT BE BR CH CL CR CY CZ EE EG FI GR GU HR HU IE IL IS IT KW MO MX NG PL PR QA RU SV TH TR VI ZA".split()),
    "T3": set("AF AL DZ AS AD AO AG AR AM AW AZ BS BH BD BB BY BZ BJ BM BT BO BA BW BN BG BF BI KH CM CV KY CF TD CO KM CG CD CI CU DJ DM DO EC GQ ET FJ GF PF GA GM GE GH GL GD GP GT GN GW GY HT HN IN ID IR IQ JM JO KZ KE KI KG LA LV LB LS LR LY LT LU MK MG MW MV ML MT MQ MR MU MF MD MN ME MA MZ MM NA NP NC NI NE OM PK PW PS PA PG PY PE PH PT RE RO RW KN LC VC SA SN RS SC SL SK SI SB SO LK SD SR SZ SY TJ TL TG TT TN TM TC UG UA UY UZ VE VN VG YE ZM ZW SS TZ CW FM MP SX VU MY".split()),
}
SUPPLEMENT_CODES = {
    "IN": {"IN", "ID"},
    "拉美": set("BR AR AW BO CL CO EC FK GF GY MX PE PY SR UY VE".split()),
    "东南亚": set("AE AF AM AZ BD BH BN BT CC CX GE IO IQ IR JO KG KH KP KZ LA LB LK MM MN MP MV MY NP OM PH PK PS SA SG SY TH TJ TL TM TR UZ VN YE".split()),
}
MAIN_BY_CODE = {code: group for group, codes in GROUP_CODES.items() for code in codes}
IAA_FOCUS_CODES = GROUP_CODES["T2"] | GROUP_CODES["T3"]


def round1(value):
    if value is None:
        return None
    rounded = round(float(value) + 1e-10, 1)
    return 0.0 if rounded == 0 else rounded


def pct(value):
    return f"{round1(value):.1f}%"


def signed_pct(value):
    return f"{round1(value):+.1f}%"


def safe_relative_change(previous, current):
    if previous is None or current is None or abs(previous) < 1e-12:
        return None
    return (current - previous) / previous * 100.0


def parse_sheet_date(name):
    for fmt in ("%Y%m%d", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(name, fmt).date()
        except ValueError:
            continue
    return None


def parse_annotated_csv(text):
    # The workbook has one CSV logical record per row. Remove the annotation
    # prefix before feeding the RFC-4180 text to the standard parser.
    clean = re.sub(r"(?m)^\[row=\d+\]\s?", "", text)
    return list(csv.reader(io.StringIO(clean)))


def parse_top5(value):
    if value is None:
        return {}
    text = str(value).strip()
    if not text or text.startswith("—") or "无内购收入" in text:
        return {}
    result = defaultdict(float)
    for code, raw in re.findall(r"\b([A-Z]{2})\s+([0-9]+(?:\.[0-9]+)?)%", text):
        result[code] += float(raw)
    return dict(result)


def load_records():
    source = json.loads(RAW_PATH.read_text(encoding="utf-8"))
    sheets = []
    records = []
    header_expected = None
    for sheet in source["sheets"]:
        name = sheet["name"]
        date = parse_sheet_date(name)
        if date is None:
            continue
        rows = parse_annotated_csv(sheet["data"]["annotated_csv"])
        header_index = next((i for i, row in enumerate(rows) if "应用标题" in row), None)
        if header_index is None:
            raise RuntimeError(f"缺少字段头:{name}")
        header = rows[header_index]
        if header_expected is None:
            header_expected = header
        elif header != header_expected:
            raise RuntimeError(f"字段头不一致:{name}")
        valid_rows = 0
        for row in rows[header_index + 1 :]:
            row = row + [""] * (len(header) - len(row))
            seq_text = row[0].strip() if row else ""
            if not re.fullmatch(r"\d+", seq_text):
                continue
            record = dict(zip(header, row[: len(header)]))
            record["_sheet"] = name
            record["_date"] = date.isoformat()
            record["_sequence"] = int(seq_text)
            record["_download_top5"] = parse_top5(record.get("近30天下载国Top5"))
            record["_income_top5"] = parse_top5(record.get("近30天收入国Top5"))
            records.append(record)
            valid_rows += 1
        sheets.append({"name": name, "date": date.isoformat(), "records": valid_rows, "range": sheet.get("range")})
    sheets.sort(key=lambda item: item["date"])
    records.sort(key=lambda item: (item["_date"], item["_sequence"]))
    return sheets, records, header_expected or []


def side_entries(record, side):
    return record["_download_top5"] if side == "download" else record["_income_top5"]


def main_shares(entries):
    total = sum(entries.values())
    if total <= 0:
        return None
    out = {group: 0.0 for group in MAIN_GROUPS}
    for code, value in entries.items():
        group = MAIN_BY_CODE.get(code)
        if group is None:
            continue
        out[group] += value / total * 100.0
    out["other"] = max(0.0, 100.0 - sum(out.values()))
    return out


def supplement_shares(entries):
    total = sum(entries.values())
    if total <= 0:
        return None
    return {
        group: sum(value for code, value in entries.items() if code in codes) / total * 100.0
        for group, codes in SUPPLEMENT_CODES.items()
    }


def aggregate(records, side, supplement=False):
    group_names = list(SUPPLEMENT_CODES) if supplement else MAIN_GROUPS + ["other"]
    group_sum = {group: 0.0 for group in group_names}
    code_sum = defaultdict(float)
    valid = 0
    for record in records:
        entries = side_entries(record, side)
        shares = supplement_shares(entries) if supplement else main_shares(entries)
        if shares is None:
            continue
        valid += 1
        for group, value in shares.items():
            group_sum[group] += value
        total = sum(entries.values())
        for code, value in entries.items():
            code_sum[code] += value / total * 100.0
    means = {group: (group_sum[group] / valid if valid else None) for group in group_names}
    return {"shares": means, "valid": valid, "codes": dict(code_sum)}


def country_shares(records, side, group=None):
    # For a named main group, return the country's share within that group's
    # aggregated Top5 structure. For group=None, return the overall Top5 share.
    numerator = defaultdict(float)
    denominator = 0.0
    valid = 0
    for record in records:
        entries = side_entries(record, side)
        total = sum(entries.values())
        if total <= 0:
            continue
        valid += 1
        if group is None:
            denominator += 1.0
            for code, value in entries.items():
                numerator[code] += value / total * 100.0
        else:
            group_codes = GROUP_CODES.get(group, set())
            group_share = sum(value for code, value in entries.items() if code in group_codes) / total * 100.0
            if group_share <= 0:
                continue
            denominator += group_share
            for code, value in entries.items():
                if code in group_codes:
                    numerator[code] += value / total * 100.0
    if denominator <= 0:
        return {"shares": {}, "valid": valid, "denominator": 0.0}
    multiplier = 1.0 if group is None else 100.0
    return {
        "shares": {code: value / denominator * multiplier for code, value in numerator.items()},
        "valid": valid,
        "denominator": denominator,
    }


def top_country_lines(stats, limit=5, include_share=True):
    items = sorted(stats["shares"].items(), key=lambda item: (-item[1], item[0]))[:limit]
    if include_share:
        return [f"{COUNTRY_NAMES.get(code, code)}（{pct(value)}）" for code, value in items]
    return [COUNTRY_NAMES.get(code, code) for code, _ in items]


def top_country_codes(stats, limit=5):
    return [code for code, _ in sorted(stats["shares"].items(), key=lambda item: (-item[1], item[0]))[:limit]]


def list_text(lines):
    return "<br/>".join(lines)


def stats_for_window(records, side, window):
    return aggregate(records, side, supplement=window == "supplement")


def main_metric_row(label, values):
    all_value = values["all"]
    previous = values["previous"]
    recent = values["recent"]
    change = safe_relative_change(previous, recent)
    return {
        "label": label,
        "all": round1(all_value),
        "previous": round1(previous),
        "recent": round1(recent),
        "change": round1(change),
    }


def build_report_tables(records, windows, categories):
    all_records, previous_records, recent_records = windows
    # Table 1: main group overview.
    global_download = aggregate(all_records, "download")
    global_download_recent = aggregate(recent_records, "download")
    global_income = aggregate(all_records, "income")
    global_income_recent = aggregate(recent_records, "income")
    group_rows = []
    for group in MAIN_GROUPS:
        d_all, d_recent = global_download["shares"][group], global_download_recent["shares"][group]
        i_all, i_recent = global_income["shares"][group], global_income_recent["shares"][group]
        if group == "US":
            role = "收入侧高价值层<br/>下载侧占比低"
        elif group == "T1":
            role = "与US共同构成收入侧高价值层"
        elif group == "T2":
            role = "下载侧规模层"
        else:
            role = "下载侧规模层<br/>收入侧方向性观察"
        group_rows.append({
            "group": group,
            "download_all": round1(d_all),
            "download_recent": round1(d_recent),
            "income_all": round1(i_all),
            "income_recent": round1(i_recent),
            "role": role,
        })

    # Table 2: global weekly trend.
    trend_rows = []
    for label, side, group, metric in [
        ("下载侧T3", "download", "T3", "main"),
        ("收入侧US+T1", "income", "US+T1", "main"),
        ("收入数据覆盖率", "income", None, "coverage"),
    ]:
        weekly = []
        for date in categories["dates"]:
            week_records = [record for record in all_records if record["_date"] == date]
            if metric == "coverage":
                value = sum(1 for record in week_records if record["_income_top5"]) / len(week_records) * 100.0
            else:
                stats = aggregate(week_records, side)
                if group == "US+T1":
                    value = stats["shares"]["US"] + stats["shares"]["T1"]
                else:
                    value = stats["shares"][group]
            weekly.append(value)
        row = main_metric_row(label, {
            "all": sum(weekly) / len(weekly),
            "previous": sum(weekly[-8:-4]) / 4,
            "recent": sum(weekly[-4:]) / 4,
        })
        row["min"] = round1(min(weekly))
        row["max"] = round1(max(weekly))
        row["latest"] = round1(weekly[-1])
        trend_rows.append(row)

    # Table 3 and 4: category decisions and category country focus.
    category_rows = []
    category_country_rows = []
    for category in CATEGORIES:
        cat_all = [record for record in all_records if record.get("品类") == category]
        cat_recent = [record for record in recent_records if record.get("品类") == category]
        d_all = aggregate(cat_all, "download")
        d_recent = aggregate(cat_recent, "download")
        i_all = aggregate(cat_all, "income")
        i_recent = aggregate(cat_recent, "income")
        coverage = i_all["valid"] / len(cat_all) * 100.0 if cat_all else 0.0
        coverage_recent = i_recent["valid"] / len(cat_recent) * 100.0 if cat_recent else 0.0
        download_focus = d_all["shares"]["T2"] + d_all["shares"]["T3"]
        recent_download_focus = d_recent["shares"]["T2"] + d_recent["shares"]["T3"]
        income_groups = sorted(
            ((group, i_all["shares"][group]) for group in MAIN_GROUPS),
            key=lambda item: (-item[1], item[0]),
        )
        if income_groups[0][1] + income_groups[1][1] >= 50:
            selected_groups = {income_groups[0][0], income_groups[1][0]}
            iap_layer = "+".join(group for group in MAIN_GROUPS if group in selected_groups)
            iap_value = income_groups[0][1] + income_groups[1][1]
        else:
            iap_layer = income_groups[0][0]
            iap_value = income_groups[0][1]
        if coverage < 50:
            iap_layer += "（方向性）"
        signal_change = safe_relative_change(download_focus, recent_download_focus)
        if signal_change is None:
            signal = "近期样本不足"
        elif abs(signal_change) < 5:
            signal = f"下载侧T2+T3为{pct(download_focus)}<br/>最近4周{pct(recent_download_focus)}方向稳定"
        elif signal_change > 0:
            signal = f"下载侧T2+T3由{pct(download_focus)}升至{pct(recent_download_focus)}<br/>近期变化{signed_pct(signal_change)}"
        else:
            signal = f"下载侧T2+T3由{pct(download_focus)}降至{pct(recent_download_focus)}<br/>近期变化{signed_pct(signal_change)}"
        category_rows.append({
            "category": category,
            "iaa_layer": "T2+T3",
            "iap_layer": iap_layer,
            "iap_value": round1(iap_value),
            "coverage": round1(coverage),
            "coverage_recent": round1(coverage_recent),
            "download_focus": round1(download_focus),
            "income_focus": round1(i_all["shares"]["US"] + i_all["shares"]["T1"]),
            "download_focus_recent": round1(recent_download_focus),
            "income_focus_recent": round1(i_recent["shares"]["US"] + i_recent["shares"]["T1"]),
            "signal": signal,
            "records": len(cat_all),
            "income_valid": i_all["valid"],
        })
        country_all = country_shares(cat_all, "download")
        country_recent = country_shares(cat_recent, "download")
        top_codes = [code for code in top_country_codes(country_all, len(country_all["shares"])) if code in IAA_FOCUS_CODES][:5]
        country_lines = []
        for code in top_codes:
            all_share = country_all["shares"].get(code, 0.0)
            recent_share = country_recent["shares"].get(code, 0.0)
            country_lines.append(f"{COUNTRY_NAMES.get(code, code)}（{pct(all_share)}/{pct(recent_share)}）")
        category_country_rows.append({
            "category": category,
            "core_group": "T2/T3",
            "countries": country_lines,
            "country_codes": top_codes,
            "all_recent": [
                {"country": code, "share": round1(country_all["shares"].get(code, 0.0)), "recent": round1(country_recent["shares"].get(code, 0.0))}
                for code in top_codes
            ],
        })

    # Table 5: group-country diagnosis.
    diagnosis_rows = []
    diagnosis_specs = [(group, False) for group in MAIN_GROUPS] + [(group, True) for group in ["IN", "拉美", "东南亚"]]
    for group, supplement in diagnosis_specs:
        if supplement:
            d_all = aggregate(all_records, "download", supplement=True)["shares"][group]
            d_recent = aggregate(recent_records, "download", supplement=True)["shares"][group]
            i_all = aggregate(all_records, "income", supplement=True)["shares"][group]
            i_recent = aggregate(recent_records, "income", supplement=True)["shares"][group]
            country_group = None
            group_codes = SUPPLEMENT_CODES[group]
            d_country_all = country_shares(all_records, "download")
            d_country_recent = country_shares(recent_records, "download")
            top_codes = [code for code, _ in sorted(((c, v) for c, v in d_country_all["shares"].items() if c in group_codes), key=lambda item: (-item[1], item[0]))[:5]]
        else:
            d_all = global_download["shares"][group]
            d_recent = global_download_recent["shares"][group]
            i_all = global_income["shares"][group]
            i_recent = global_income_recent["shares"][group]
            country_group = group
            d_country_all = country_shares(all_records, "download", group)
            d_country_recent = country_shares(recent_records, "download", group)
            top_codes = top_country_codes(d_country_all, 5)
        country_names = [COUNTRY_NAMES.get(code, code) for code in top_codes]
        concentration = sum(d_country_all["shares"].get(code, 0.0) for code in top_codes)
        if len(country_names) == 0:
            country_names = ["有效国家样本不足"]
        source_codes = []
        for code in top_codes:
            delta = d_country_recent["shares"].get(code, 0.0) - d_country_all["shares"].get(code, 0.0)
            source_codes.append((delta, COUNTRY_NAMES.get(code, code)))
        source_codes.sort(reverse=True)
        rising = [name for delta, name in source_codes if delta > 0.8][:2]
        falling = [name for delta, name in source_codes if delta < -0.8][:2]
        if group == "US":
            obs = "下载侧占比低<br/>收入侧为高价值层"
        elif group == "T1":
            support = "、".join((country_names + ["重点国家"])[:3])
            obs = f"下载侧由{support}支撑<br/>收入侧全历史为{pct(i_all)}，最近4周为{pct(i_recent)}"
        elif group == "T2":
            lead = country_names[0] if country_names else "重点国家"
            obs = f"前五国约占T2的{pct(concentration)}，{lead}是核心<br/>收入侧全历史为{pct(i_all)}，最近4周为{pct(i_recent)}"
        elif group == "T3":
            obs = f"前五国约占T3的{pct(concentration)}"
            if rising:
                obs += f"<br/>最近4周与{ '、'.join(rising) }上升同步变化"
            else:
                obs += "<br/>近期重点国家未显示同步上升"
            if falling:
                obs += f"<br/>{ '、'.join(falling) }回落可能削弱近期增幅"
            else:
                obs += "<br/>近期变化保持方向性观察"
        elif group == "IN":
            obs = f"{ '、'.join(country_names[:2]) }覆盖IN主要下载侧份额<br/>最近4周与{ '、'.join(rising) if rising else '重点国家' }变化同步"
            obs += f"<br/>收入侧全历史为{pct(i_all)}，最近4周为{pct(i_recent)}"
        elif group == "拉美":
            lead = "、".join(country_names[:2]) if country_names else "重点国家"
            obs = f"{lead}约占拉美下载侧主要份额<br/>最近4周与{ '、'.join(rising) if rising else '重点国家' }变化同步"
            obs += "<br/>收入侧仅作补充观察"
        else:
            lead = "、".join(country_names[:3]) if country_names else "重点国家"
            obs = f"下载侧重点{lead}<br/>最近4周与{ '、'.join(rising) if rising else '重点国家' }变化同步"
            obs += f"<br/>收入侧全历史为{pct(i_all)}，最近4周为{pct(i_recent)}<br/>收入侧重点组与下载侧可不同"
        diagnosis_rows.append({
            "group": group,
            "countries": country_names,
            "download_all": round1(d_all),
            "download_recent": round1(d_recent),
            "income_all": round1(i_all),
            "income_recent": round1(i_recent),
            "concentration": round1(concentration),
            "observation": obs,
            "download_country_all": {code: round1(d_country_all["shares"].get(code, 0.0)) for code in top_codes},
            "download_country_recent": {code: round1(d_country_recent["shares"].get(code, 0.0)) for code in top_codes},
            "income_country_all": {},
            "income_country_recent": {},
        })

    return {
        "global_rows": group_rows,
        "trend_rows": trend_rows,
        "category_rows": category_rows,
        "category_country_rows": category_country_rows,
        "diagnosis_rows": diagnosis_rows,
    }


def build_output():
    sheets, records, headers = load_records()
    dates = [sheet["date"] for sheet in sheets]
    if not dates:
        raise RuntimeError("没有合格的日期命名周表")
    all_records = records
    previous_dates = set(dates[-8:-4])
    recent_dates = set(dates[-4:])
    previous_records = [record for record in records if record["_date"] in previous_dates]
    recent_records = [record for record in records if record["_date"] in recent_dates]
    if len(recent_dates) != 4 or len(previous_dates) != 4:
        raise RuntimeError("不足8个周表，无法计算前4周与最近4周")

    all_codes = Counter()
    unknown_codes = Counter()
    unassigned_codes = Counter()
    duplicate_keys = Counter()
    for record in records:
        duplicate_keys[(
            record["_date"],
            record.get("应用标题", "").strip(),
            record.get("品类", "").strip(),
            record.get("发行商", "").strip(),
            record.get("Tag路径", "").strip(),
        )] += 1
        for side in ("download", "income"):
            for code in side_entries(record, side):
                all_codes[code] += 1
                if code not in COUNTRY_NAMES:
                    unknown_codes[code] += 1
                elif code not in MAIN_BY_CODE:
                    unassigned_codes[code] += 1
    duplicate_records = sum(count - 1 for count in duplicate_keys.values() if count > 1)
    download_valid = sum(1 for record in records if record["_download_top5"])
    income_valid = sum(1 for record in records if record["_income_top5"])
    categories_present = sorted({record.get("品类") for record in records})
    if categories_present != sorted(CATEGORIES):
        raise RuntimeError(f"品类集合不符合固定7品类:{categories_present}")

    global_download = aggregate(all_records, "download")
    global_income = aggregate(all_records, "income")
    global_download_recent = aggregate(recent_records, "download")
    global_income_recent = aggregate(recent_records, "income")
    weekly_download_t3 = []
    weekly_income_us_t1 = []
    weekly_coverage = []
    for date in dates:
        week_records = [record for record in records if record["_date"] == date]
        download_week = aggregate(week_records, "download")["shares"]
        income_week = aggregate(week_records, "income")["shares"]
        weekly_download_t3.append(round1(download_week["T3"]))
        weekly_income_us_t1.append(round1(income_week["US"] + income_week["T1"]))
        weekly_coverage.append(round1(sum(1 for record in week_records if record["_income_top5"]) / len(week_records) * 100.0))

    category_rows = []
    category_country_rows = []
    for category in CATEGORIES:
        cat_records = [record for record in records if record.get("品类") == category]
        d = aggregate(cat_records, "download")["shares"]
        i = aggregate(cat_records, "income")["shares"]
        i_valid = aggregate(cat_records, "income")["valid"]
        category_rows.append({
            "name": category,
            "download": round1(d["T2"] + d["T3"]),
            "income": round1(i["US"] + i["T1"]),
            "coverage": round1(i_valid / len(cat_records) * 100.0 if cat_records else 0.0),
        })
        country = country_shares(cat_records, "download")
        top_codes = [code for code in top_country_codes(country, len(country["shares"])) if code in IAA_FOCUS_CODES][:5]
        category_country_rows.append({
            "name": category,
            "countries": [{"country": code, "share": round1(country["shares"].get(code, 0.0))} for code in top_codes[:5]],
        })

    region_download = aggregate(records, "download", supplement=True)["shares"]
    region_income = aggregate(records, "income", supplement=True)["shares"]
    regions = {
        "note": "IN、拉美、东南亚为可重叠观察组，不与主分层相加；US为主分层，仅为对照纳入此图",
        "rows": [
            {"name": "US", "download": round1(global_download["shares"]["US"]), "income": round1(global_income["shares"]["US"])},
            {"name": "IN", "download": round1(region_download["IN"]), "income": round1(region_income["IN"])},
            {"name": "拉美", "download": round1(region_download["拉美"]), "income": round1(region_income["拉美"])},
            {"name": "东南亚", "download": round1(region_download["东南亚"]), "income": round1(region_income["东南亚"])},
        ],
    }
    report_tables = build_report_tables(records, (all_records, previous_records, recent_records), {"dates": dates})
    out = {
        "metadata": {
            "sheet_count": len(sheets),
            "sheets": sheets,
            "start_date": dates[0],
            "end_date": dates[-1],
            "records": len(records),
            "download_valid_records": download_valid,
            "income_valid_records": income_valid,
            "download_missing_rate": round1((len(records) - download_valid) / len(records) * 100.0),
            "income_missing_rate": round1((len(records) - income_valid) / len(records) * 100.0),
            "duplicate_records": duplicate_records,
            "duplicate_key_fields": ["日期", "应用标题", "品类", "发行商", "Tag路径"],
            "unknown_country_codes": dict(unknown_codes),
            "unassigned_country_codes": dict(unassigned_codes),
            "country_codes_seen": sorted(all_codes),
            "headers": headers,
            "category_record_counts": {category: sum(1 for record in records if record.get("品类") == category) for category in CATEGORIES},
            "latest_week_record_count": sum(1 for record in records if record["_date"] == dates[-1]),
        },
        "global": {
            "subtitle": f"下载侧与收入侧的Top5国家地区份额结构·单位：%·{dates[0].replace('-', '/')}至{dates[-1].replace('-', '/')}",
            "download": {key: round1(value) for key, value in global_download["shares"].items()},
            "income": {key: round1(value) for key, value in global_income["shares"].items()},
            "download_recent": {key: round1(value) for key, value in global_download_recent["shares"].items()},
            "income_recent": {key: round1(value) for key, value in global_income_recent["shares"].items()},
        },
        "trend": {
            "subtitle": f"{dates[0].replace('-', '/')}–{dates[-1].replace('-', '/')}·按周统计·单位：%",
            "dates": [date.replace('-', '/') for date in dates],
            "downloadT3": weekly_download_t3,
            "incomeUSPlusT1": weekly_income_us_t1,
            "coverage": weekly_coverage,
        },
        "category": {
            "note": "同一品类中，上下两条分别对应下载T2+T3与收入US+T1；右列为收入数据覆盖率",
            "rows": category_rows,
        },
        "regions": regions,
        "categoryCountries": {
            "note": "每个品类下载侧T2/T3范围内Top5重点国家份额·其余浅灰为其他/未纳入重点范围·柱长按0–100%绝对比例展示·单位：%",
            "rows": category_country_rows,
        },
        "report": report_tables,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": "ANALYSIS_DATA_SAVED",
        "sheets": len(sheets),
        "records": len(records),
        "download_valid": download_valid,
        "income_valid": income_valid,
        "start_date": dates[0],
        "end_date": dates[-1],
        "unknown_codes": dict(unknown_codes),
        "unassigned_codes": dict(unassigned_codes),
        "bytes": OUT_PATH.stat().st_size,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build canonical AMDA analysis data from exported weekly sheets")
    parser.add_argument("--raw", default=str(RAW_PATH))
    parser.add_argument("--output", default=str(OUT_PATH))
    args = parser.parse_args()
    RAW_PATH = Path(args.raw)
    OUT_PATH = Path(args.output)
    build_output()
