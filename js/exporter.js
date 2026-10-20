// Builds files for accounting software, spreadsheets (CSV or Excel), the user's own Excel workbook,
// receipt photo bundles and full backups, and hands them to the iPhone share sheet.

import { getAllEntries, getFile, putEntry, putFile, clearEverything } from './db.js';
import { ID_HEADER, fieldValue, formatExportDate } from './fields.js';
import { hasMultipleBusinesses, settings, replaceSettings } from './settings.js';
import { base64ToBlob, blobToBase64, safeFileName } from './util.js';
import { addSheet, buildWorkbook, openWorkbook, readSheetRows, findHeaderRow, saveWorkbook, upsertRows } from './xlsx.js';

const MONEY_FIELDS = new Set(['total', 'totalNegative', 'subtotal', 'tax', 'tip']);
export const typeOfField = (field) => (field === 'date' ? 'date' : MONEY_FIELDS.has(field) ? 'money' : 'text');

const raw = (key) => (e) => fieldValue(e, key, { sheet: true });
const labelWithCategory = (e) => `${raw('vendorDescription')(e) || 'Expense'} (${raw('category')(e)})`;

// Each column: { header, type, get(entry) } with raw values (numbers, ISO dates).
function columnsFor(formatId) {
  if (formatId?.startsWith('tpl:')) {
    const t = settings().exportTemplates.find((x) => `tpl:${x.id}` === formatId);
    if (t) return t.columns.map((c) => ({ header: c.header, type: typeOfField(c.field), get: c.field ? raw(c.field) : () => '' }));
  }
  switch (formatId) {
    case 'quickbooks':
    case 'wave':
      // Bank-style imports: spending is negative.
      return [
        { header: 'Date', type: 'date', get: raw('date') },
        { header: 'Description', type: 'text', get: labelWithCategory },
        { header: 'Amount', type: 'money', get: raw('totalNegative') },
      ];
    case 'xero':
      return [
        { header: 'Date', type: 'date', get: raw('date') },
        { header: 'Amount', type: 'money', get: raw('totalNegative') },
        { header: 'Payee', type: 'text', get: raw('vendor') },
        { header: 'Description', type: 'text', get: raw('description') },
        { header: 'Reference', type: 'text', get: (e) => e.fields.category || '' },
      ];
    default:
      return [
        ['Date', 'date'], ['Vendor', 'vendor'], ['Description', 'description'], ['Category', 'category'], ['Amount', 'total'],
        ['Tax', 'tax'], ['Tip', 'tip'], ['Subtotal', 'subtotal'], ['Currency', 'currency'], ['Payment Method', 'paymentMethod'],
        ...(hasMultipleBusinesses() ? [['Books', 'book']] : []),
        ['Notes', 'notes'], ['Status', 'status'], ['Source', 'source'], ['Receipt Link', 'receipt'],
      ].map(([header, field]) => ({ header, type: typeOfField(field), get: raw(field) }));
  }
}

// Accounting-software imports must stay CSV; spreadsheet and custom layouts can be Excel.
export function supportsExcel(formatId) {
  return formatId === 'csv' || Boolean(formatId?.startsWith('tpl:'));
}

function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Neutralise spreadsheet formulas (a vendor name starting with "=" etc.).
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportFile(entries, formatId, rangeLabel, fileType = 'csv') {
  const columns = columnsFor(formatId);
  const sorted = [...entries].sort((a, b) => a.fields.date.localeCompare(b.fields.date) || a.createdAt - b.createdAt);
  const values = sorted.map((e) => columns.map((c) => c.get(e)));
  const df = settings().dateFormat;
  const suffix = formatId?.startsWith('tpl:')
    ? settings().exportTemplates.find((x) => `tpl:${x.id}` === formatId)?.name || 'custom'
    : { quickbooks: 'QuickBooks', xero: 'Xero', wave: 'Wave' }[formatId] || '';
  const base = safeFileName(`Expenses ${rangeLabel} ${suffix}`.trim());

  if (fileType === 'xlsx' && supportsExcel(formatId)) {
    const blob = buildWorkbook({ sheetName: 'Expenses', columns, rows: values, dateFormat: df });
    return new File([blob], `${base}.xlsx`, { type: blob.type });
  }
  const text = [columns.map((c) => c.header), ...values.map((row) => row.map((v, i) => {
    const type = columns[i].type;
    if (type === 'date') return formatExportDate(v, df);
    if (type === 'money') return v === '' ? '' : (Number(v) || 0).toFixed(2);
    return v;
  }))].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return new File(['﻿' + text], `${base}.csv`, { type: 'text/csv' }); // BOM so Excel reads accents correctly
}

// ---------- The user's own Excel workbook ----------

// Reads the tabs and header layout of a workbook the user picked.
export async function inspectWorkbook(file) {
  const wb = await openWorkbook(file);
  const tabs = [];
  for (const sheet of wb.sheets) {
    const rows = await readSheetRows(wb, sheet.name);
    const headerIdx = findHeaderRow(rows);
    const headers = headerIdx < 0 ? [] : (rows[headerIdx] || []).map((h) => String(h ?? '').trim());
    const data = headerIdx < 0 ? [] : rows.slice(headerIdx + 1).filter((r) => (r || []).some((v) => String(v ?? '').trim()));
    tabs.push({ name: sheet.name, headers, rows: data });
  }
  return tabs;
}

/**
 * Adds every expense that isn't in the workbook yet and updates ones edited in the app since the
 * last update. Columns are matched by header name, so the user can reorder their columns freely.
 * Returns { file, added, updated, missingHeaders }.
 */
export async function updateExcelWorkbook(file, entries) {
  const { tab, columns } = settings().excel;
  if (!tab) throw new Error('Set up your Excel file first in Settings → Excel file.');
  const mapped = columns.filter((c) => c.field);
  const wb = await openWorkbook(file);
  if (!wb.sheets.some((s) => s.name === tab)) {
    await addSheet(wb, tab, columns.map((c) => c.header));
  }
  const rows = await readSheetRows(wb, tab);
  const headerIdx = findHeaderRow(rows);
  const present = new Set((rows[headerIdx] || []).map((h) => String(h ?? '').trim()));
  const addHeaders = columns.filter((c) => c.add).map((c) => c.header);
  const missingHeaders = mapped.filter((c) => !c.add && !present.has(c.header)).map((c) => c.header);
  if (mapped.some((c) => !c.add) && missingHeaders.length === mapped.filter((c) => !c.add).length) {
    throw new Error(`None of the expected columns were found on the "${tab}" tab. If you renamed them, set the columns up again in Settings → Excel.`);
  }
  const items = entries
    .filter((e) => e.aiStatus === 'done' || e.aiStatus === 'skipped')
    .sort((a, b) => a.fields.date.localeCompare(b.fields.date) || a.createdAt - b.createdAt) // new rows in date order
    .map((e) => ({
      id: e.id,
      dirty: e.excel?.version !== e.updatedAt,
      values: Object.fromEntries(mapped.map((c) => [c.header, { value: fieldValue(e, c.field, { sheet: true }), type: typeOfField(c.field) }])),
    }));
  const result = await upsertRows(wb, { tab, idHeader: ID_HEADER, items, addHeaders });
  return { file: await saveWorkbook(wb), added: result.added, updated: result.updated, missingHeaders, ids: items.map((i) => i.id) };
}

export async function receiptFiles(entries) {
  const seen = new Set();
  const files = [];
  for (const e of entries) {
    if (!e.fileId || seen.has(e.fileId)) continue;
    seen.add(e.fileId);
    const blob = await getFile(e.fileId);
    if (!blob) continue;
    const ext = blob.type === 'application/pdf' ? 'pdf' : 'jpg';
    const base = safeFileName(`${e.fields.date} ${e.fields.vendor || 'Receipt'} ${(Number(e.fields.total) || 0).toFixed(2)}`);
    let name = `${base}.${ext}`;
    for (let i = 2; files.some((f) => f.name === name); i++) name = `${base} (${i}).${ext}`;
    files.push(new File([blob], name, { type: blob.type }));
  }
  return files;
}

// Share sheet on iPhone; plain download elsewhere. Returns false if the user cancelled.
export async function deliverFiles(files, title) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      // Fall through to download if sharing failed for another reason.
    }
  }
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return true;
}

// ---------- Backup & restore ----------

export async function backupFile({ includeKey = false } = {}) {
  const s = structuredClone(settings());
  if (!includeKey) s.ai.apiKey = '';
  const entries = await getAllEntries();
  const files = [];
  for (const id of new Set(entries.map((e) => e.fileId).filter(Boolean))) {
    const blob = await getFile(id);
    if (blob) files.push({ id, type: blob.type, data: await blobToBase64(blob) });
  }
  const payload = { app: 'ai-expense-tracker', version: 1, createdAt: new Date().toISOString(), settings: s, entries, files };
  const stamp = new Date().toISOString().slice(0, 10);
  return new File([JSON.stringify(payload)], `AI Expense Tracker backup ${stamp}.json`, { type: 'application/json' });
}

export async function restoreBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not a valid backup.');
  }
  if (data?.app !== 'ai-expense-tracker' || !Array.isArray(data.entries)) {
    throw new Error('That file is not an AI Expense Tracker backup.');
  }
  const keepKey = settings().ai.apiKey;
  await clearEverything();
  for (const f of data.files || []) await putFile(f.id, base64ToBlob(f.data, f.type));
  for (const e of data.entries) await putEntry(e);
  const next = data.settings;
  if (!next.ai.apiKey) next.ai.apiKey = keepKey;
  next.setupDone = true;
  await replaceSettings(next);
  return data.entries.length;
}
