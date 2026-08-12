#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Authoritative no-wrap check for AMDA report tables using the Feishu PDF export.

Usage:
  python pdf-wrap-check.py --pdf <exported.pdf> --xml <source.xml> [--output <result.json>]

Exit code 0 when every expected table cell line renders on a single PDF line.
Exit code 1 when at least one expected line is wrapped; a JSON report is written
to --output (default: wrap-report.json) and a human-readable list is printed.
"""
import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET

import fitz  # PyMuPDF


def norm(text):
    return re.sub(r"\s+", "", text)


def expected_lines(xml_path):
    """Return [(table_index, column_index, phrase), ...] from the AMDA DocxXML."""
    with open(xml_path, encoding="utf-8") as fh:
        xml = fh.read()
    root = ET.fromstring("<root>" + xml + "</root>")
    result = []
    for ti, table in enumerate(root.findall("table")):
        for tr in table.findall("./thead/tr") + table.findall("./tbody/tr"):
            cells = tr.findall("th") if tr.tag == "thead" else tr.findall("td")
            for ci, cell in enumerate(cells):
                for para in cell.findall("p"):
                    lines = []
                    cur = para.text or ""
                    for child in para:
                        if child.tag == "br":
                            lines.append(cur)
                            cur = ""
                        else:
                            cur += "".join(child.itertext())
                        cur += child.tail or ""
                    lines.append(cur)
                    for line in lines:
                        text = norm(line)
                        if text:
                            result.append((ti + 1, ci + 1, text))
    return result


def pdf_lines(pdf_path):
    doc = fitz.open(pdf_path)
    lines = []
    for pno in range(doc.page_count):
        words = doc[pno].get_text("words")
        groups = {}
        for w in words:
            key = (pno, w[5], w[6])
            groups.setdefault(key, []).append(w)
        for key, ws in groups.items():
            ws.sort(key=lambda w: w[0])
            text = norm("".join(w[4] for w in ws))
            if text:
                lines.append((pno + 1, text))
    doc.close()
    return lines


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--xml", required=True)
    parser.add_argument("--output", default="wrap-report.json")
    args = parser.parse_args()

    expected = expected_lines(args.xml)
    lines = pdf_lines(args.pdf)
    line_texts = [t for _, t in lines]
    wraps = []
    for ti, ci, phrase in expected:
        if not any(phrase == lt for lt in line_texts):
            wraps.append({"table": ti, "col": ci, "phrase": phrase})

    report = {
        "ok": len(wraps) == 0,
        "expected_lines": len(expected),
        "pdf_lines": len(line_texts),
        "wrapped_lines": len(wraps),
        "wraps": wraps,
    }
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    if wraps:
        print(f"WRAP_CHECK: FAIL (wrapped_lines={len(wraps)})")
        for w in wraps:
            print(f"  T{w['table']} col{w['col']}: {w['phrase']}")
        return 1
    print(f"WRAP_CHECK: PASS (expected_lines={len(expected)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
