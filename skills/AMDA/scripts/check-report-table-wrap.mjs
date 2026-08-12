import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const xmlPath = process.argv[2];
if (!xmlPath) {
  console.error('usage: node check.mjs <demo.xml> [padding]');
  process.exit(1);
}
const padding = Number(process.argv[3] || 10);
const fontSize = Number(process.argv[4] || 14);
const xml = readFileSync(xmlPath, 'utf8');

// Convert the AMDA DocxXML subset to plain HTML tables, keeping structure and widths.
function tableToHtml(tableXml) {
  let html = tableXml
    .replace(/<colgroup>/g, '<colgroup>')
    .replace(/<col ([^>]*)\/>/g, (m, attrs) => {
      const width = /width="(\d+)"/.exec(attrs)?.[1] || '100';
      return `<col style="width:${width}px"/>`;
    })
    .replace(/<th([^>]*)>/g, '<th$1>')
    .replace(/<td([^>]*)>/g, '<td$1>')
    .replace(/<p([^>]*)>/g, (m, attrs) => {
      const align = /align="([^"]+)"/.exec(attrs)?.[1] || 'left';
      return `<div class="para" data-align="${align}">`;
    })
    .replace(/<\/p>/g, '</div>')
    .replace(/<br\/>/g, '<br/>');
  return `<table>${html}</table>`;
}

const tableMatches = [...xml.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)].map((m) => m[1]);
const page = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body { margin:0; padding:16px;
              font-family: "Microsoft YaHei", "Noto Sans SC", "PingFang SC", -apple-system, "Segoe UI", sans-serif;
              font-size: ${fontSize}px; }
  table { border-collapse: collapse; table-layout: fixed; margin-bottom: 24px;
          font-family: inherit; font-size: inherit; }
  th, td { padding: 8px ${padding}px; border: 1px solid #d9e1ea; vertical-align: middle; }
  .para { margin: 0; }
  .measure { position: absolute; visibility: hidden; white-space: nowrap; pointer-events: none; }
</style></head><body>
${tableMatches.map(tableToHtml).join('\n')}
<div id="report" style="display:none"></div>
</body></html>`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page2 = await context.newPage();
await page2.setContent(page, { waitUntil: 'load' });

const report = await page2.evaluate(() => {
  const rows = [];
  const tables = document.querySelectorAll('table');
  tables.forEach((table, ti) => {
    const widths = [...table.querySelectorAll('col')].map((c) => parseFloat(c.style.width));
    const cells = table.querySelectorAll('th, td');
    cells.forEach((cell, ci) => {
      const colIndex = cell.cellIndex;
      if (colIndex < 0 || colIndex >= widths.length) return;
      const colWidth = widths[colIndex];
      const pad = parseFloat(getComputedStyle(cell).paddingLeft) + parseFloat(getComputedStyle(cell).paddingRight);
      const available = colWidth - pad;
      const paras = cell.querySelectorAll('.para');
      paras.forEach((para) => {
        const segments = [];
        let cur = '';
        for (const node of para.childNodes) {
          if (node.nodeName === 'BR') {
            segments.push(cur);
            cur = '';
          } else {
            cur += node.textContent;
          }
        }
        segments.push(cur);
        segments.forEach((seg) => {
          const span = document.createElement('span');
          span.className = 'measure';
          span.textContent = seg;
          document.body.appendChild(span);
          const w = span.getBoundingClientRect().width;
          span.remove();
          rows.push({
            table: ti + 1,
            col: colIndex + 1,
            width: colWidth,
            available: +available.toFixed(1),
            textWidth: +w.toFixed(1),
            text: seg,
            wrap: w > available + 0.5,
          });
        });
      });
    });
  });
  return rows;
});

await browser.close();

const wraps = report.filter((r) => r.wrap);
console.log(`font=${fontSize}px padding=${padding}px lines=${report.length} wrapLines=${wraps.length}`);
for (const w of wraps) {
  console.log(`  T${w.table} col${w.col} avail=${w.available} need=${w.textWidth} :: ${w.text}`);
}
const marginCases = report.filter((r) => !r.wrap && r.available - r.textWidth < 10);
console.log(`tightLines (slack<10px)=${marginCases.length}`);
for (const m of marginCases) {
  console.log(`  T${m.table} col${m.col} avail=${m.available} need=${m.textWidth} slack=${(m.available - m.textWidth).toFixed(1)} :: ${m.text}`);
}

const byCol = new Map();
for (const r of report) {
  const key = `${r.table}:${r.col}`;
  const cur = byCol.get(key);
  if (!cur || r.textWidth > cur.max) byCol.set(key, { table: r.table, col: r.col, max: r.textWidth, text: r.text });
}
console.log('--- max need per column (colWidth, avail, maxNeed) ---');
for (const [key, v] of [...byCol.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
  const table = report.find((r) => r.table === v.table && r.col === v.col);
  console.log(`  T${v.table} col${v.col} width=${table.width} avail=${table.available} maxNeed=${v.max.toFixed(1)} :: ${v.text}`);
}
