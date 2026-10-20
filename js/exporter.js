// Builds files for accounting software, receipt photo bundles and full backups,
// and hands them to the iPhone share sheet (Save to Files, AirDrop, Mail, ...).

import { getAllEntries, getFile, putEntry, putFile, clearEverything } from './db.js';
import { businessName, settings, replaceSettings } from './settings.js';
import { base64ToBlob, blobToBase64, parseISODate, safeFileName } from './util.js';

function fmtDate(iso, format) {
  const d = parseISODate(iso);
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  if (format === 'DMY') return `${dd}/${mm}/${yyyy}`;
  if (format === 'ISO') return iso;
  return `${mm}/${dd}/${yyyy}`;
}

function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Neutralise spreadsheet formulas (a vendor name starting with "=" etc.).
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
// Bank-style imports treat spending as negative and refunds as positive.
const spend = (n) => money(-(Number(n) || 0));

function label(e) {
  const f = e.fields;
  return [f.vendor, f.description].filter(Boolean).join(' - ') || 'Expense';
}

export const FORMAT_BUILDERS = {
  csv: {
    suffix: 'spreadsheet',
    build(entries, df) {
      const header = ['Date', 'Vendor', 'Description', 'Category', 'Amount', 'Tax', 'Tip', 'Subtotal', 'Currency',
        'Payment Method', 'Business', 'Notes', 'Status', 'Source', 'Receipt Link', 'Entry ID'];
      const rows = entries.map((e) => {
        const f = e.fields;
        return [fmtDate(f.date, df), f.vendor, f.description, f.category || 'Uncategorized', money(f.total), money(f.tax),
          money(f.tip), money(f.subtotal), f.currency, f.paymentMethod, businessName(e.businessId), f.notes,
          !e.reviewed && e.reviewReasons?.length ? 'Needs review' : 'OK', e.source, e.sheet?.receiptUrl || '', e.id];
      });
      return toCSV([header, ...rows]);
    },
  },
  quickbooks: {
    suffix: 'quickbooks',
    build(entries, df) {
      const rows = entries.map((e) => [fmtDate(e.fields.date, df), `${label(e)} (${e.fields.category || 'Uncategorized'})`, spend(e.fields.total)]);
      return toCSV([['Date', 'Description', 'Amount'], ...rows]);
    },
  },
  xero: {
    suffix: 'xero',
    build(entries, df) {
      const rows = entries.map((e) => [fmtDate(e.fields.date, df), spend(e.fields.total), e.fields.vendor, e.fields.description, e.fields.category || '']);
      return toCSV([['Date', 'Amount', 'Payee', 'Description', 'Reference'], ...rows]);
    },
  },
  wave: {
    suffix: 'wave',
    build(entries, df) {
      const rows = entries.map((e) => [fmtDate(e.fields.date, df), `${label(e)} (${e.fields.category || 'Uncategorized'})`, spend(e.fields.total)]);
      return toCSV([['Date', 'Description', 'Amount'], ...rows]);
    },
  },
};

export function exportFile(entries, formatId, rangeLabel) {
  const builder = FORMAT_BUILDERS[formatId] || FORMAT_BUILDERS.csv;
  const sorted = [...entries].sort((a, b) => a.fields.date.localeCompare(b.fields.date) || a.createdAt - b.createdAt);
  const text = '﻿' + builder.build(sorted, settings().dateFormat); // BOM so Excel reads accents correctly
  const name = safeFileName(`Expenses ${rangeLabel} ${builder.suffix}`) + '.csv';
  return new File([text], name, { type: 'text/csv' });
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
    const base = safeFileName(`${e.fields.date} ${e.fields.vendor || 'Receipt'} ${money(e.fields.total)}`);
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
