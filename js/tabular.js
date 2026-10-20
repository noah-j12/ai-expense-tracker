// Reads a spreadsheet layout (header row + some data rows) from a CSV/TSV/Excel file or pasted text.

import { findHeaderRow, openWorkbook, readSheetRows } from './xlsx.js';

export function parseDelimited(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = ['\t', ',', ';'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Turns raw rows into { headers, rows } where rows are the data rows under the header.
export function toTable(raw) {
  const headerIdx = findHeaderRow(raw);
  if (headerIdx < 0) return { headers: [], rows: [] };
  const headers = (raw[headerIdx] || []).map((h) => String(h ?? '').trim());
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  const rows = raw.slice(headerIdx + 1).filter((r) => (r || []).some((v) => String(v ?? '').trim()));
  return { headers, rows };
}

export function tableFromText(text) {
  const raw = parseDelimited(text.trim());
  // A pasted column of names (one per line) rather than a header row.
  if (raw.length > 1 && raw.every((r) => r.length === 1)) {
    return { headers: raw.map((r) => r[0].trim()).filter(Boolean), rows: [] };
  }
  return toTable(raw);
}

export function isExcelFile(file) {
  return /\.xlsx$/i.test(file.name || '') || /spreadsheetml/.test(file.type || '');
}

// For Excel files, `tab` picks the sheet (defaults to the first one).
export async function readTableFile(file, { tab } = {}) {
  if (isExcelFile(file) || /\.xls$/i.test(file.name || '')) {
    const wb = await openWorkbook(file);
    const name = tab || wb.sheets[0]?.name;
    return { ...toTable(await readSheetRows(wb, name)), tabs: wb.sheets.map((s) => s.name), tab: name };
  }
  if (/\.numbers$/i.test(file.name || '')) {
    throw new Error('Numbers files can\'t be read directly. In Numbers, use File > Export To > CSV or Excel, then pick that file.');
  }
  return tableFromText(await file.text());
}
