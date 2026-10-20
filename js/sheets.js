// Optional Google Sheets sync. The user pastes a small Apps Script into their own Google Sheet and
// deploys it as a web app; this app then POSTs rows (and receipt photos for Drive) to that URL.
// Works with any tab and column layout: columns are matched by header name, and the script keeps a
// hidden ID column so it can find the app's rows again. Nothing runs on our side.

import { getFile, kvGet, kvSet, putEntry } from './db.js';
import { ID_HEADER, fieldValue } from './fields.js';
import { hasMultipleBusinesses, settings } from './settings.js';
import { getEntry, listEntries } from './entries.js';
import { blobToBase64, emit, safeFileName } from './util.js';

export const SCRIPT_VERSION = 2;
export const sheetsState = { error: '', lastSync: null };

export function defaultSheetColumns() {
  return [
    ['Date', 'date'], ['Vendor', 'vendor'], ['Description', 'description'], ['Category', 'category'], ['Amount', 'total'],
    ['Tax', 'tax'], ['Tip', 'tip'], ['Payment Method', 'paymentMethod'], ...(hasMultipleBusinesses() ? [['Books', 'book']] : []),
    ['Notes', 'notes'], ['Status', 'status'], ['Receipt', 'receipt'],
  ].map(([header, field]) => ({ header, field }));
}

// Signed in to a script but no tab/columns chosen yet.
export function sheetsLinked() {
  const s = settings().sheets;
  return Boolean(s.url && s.secret);
}

export function sheetsConnected() {
  const s = settings().sheets;
  return sheetsLinked() && Boolean(s.tab) && s.columns.some((c) => c.field);
}

async function call(payload, url = settings().sheets.url, secret = settings().sheets.secret) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      // text/plain keeps this a "simple" request, which Apps Script web apps accept cross-origin.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, secret }),
      redirect: 'follow',
    });
  } catch {
    const err = new Error('Could not reach Google Sheets. Check your connection.');
    err.offline = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error('Google sent back an unexpected reply. Make sure you copied the Web app URL and set access to "Anyone".');
  }
  if (!data.ok) throw new Error(data.error || 'Google Sheets reported an error.');
  return data;
}

// Returns { name, tabs: [{ name, headerRow, headers, rows, sample }] }.
export async function sheetsInfo(url = settings().sheets.url, secret = settings().sheets.secret) {
  const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url) && /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  if (!local && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
    throw new Error('That doesn\'t look like an Apps Script web app URL. It should start with https://script.google.com/');
  }
  const data = await call({ action: 'info' }, url, secret);
  if ((data.version || 1) < SCRIPT_VERSION) {
    throw new Error('Your sheet has an older version of the script. Copy the script again from this screen, paste it over the old one, then Deploy > Manage deployments > Edit > New version.');
  }
  return data;
}

export async function prepareTab({ tab, headers, addHeaders }) {
  return call({ action: 'setup', tab, headers, addHeaders });
}

export async function distinctValues(tab, headers) {
  if (!headers.length) return {};
  return (await call({ action: 'distinct', tab, headers })).values || {};
}

function receiptName(e, type) {
  const ext = type === 'application/pdf' ? 'pdf' : 'jpg';
  return safeFileName(`${e.fields.date} ${e.fields.vendor || 'Receipt'} ${e.fields.total}`) + '.' + ext;
}

let syncing = false;

export async function syncSheets() {
  if (!sheetsConnected() || syncing) return;
  syncing = true;
  const { tab, columns } = settings().sheets;
  const mapped = columns.filter((c) => c.field);
  const receiptHeader = mapped.find((c) => c.field === 'receipt')?.header || null;
  const dateHeaders = mapped.filter((c) => c.field === 'date').map((c) => c.header);
  try {
    const deletes = (await kvGet('sheetDeletes')) || [];
    if (deletes.length) {
      await call({ action: 'delete', tab, ids: deletes });
      await kvSet('sheetDeletes', []);
    }

    const all = await listEntries();
    // Split entries share one photo; reuse its Drive link instead of uploading it twice.
    const knownUrls = new Map(all.filter((e) => e.fileId && e.sheet?.receiptUrl).map((e) => [e.fileId, e.sheet.receiptUrl]));
    // Oldest first, so new rows land in date order below the existing ones.
    const dirty = all
      .filter((e) => e.sheet?.dirty && (e.aiStatus === 'done' || e.aiStatus === 'skipped'))
      .sort((a, b) => a.fields.date.localeCompare(b.fields.date) || a.createdAt - b.createdAt);

    for (const e of dirty) {
      const values = {};
      for (const c of mapped) if (c.field !== 'receipt') values[c.header] = fieldValue(e, c.field, { sheet: true });
      const item = { id: e.id, values, receiptUrl: e.sheet?.receiptUrl || '' };
      if (receiptHeader && e.fileId && !item.receiptUrl) {
        if (knownUrls.has(e.fileId)) {
          item.receiptUrl = knownUrls.get(e.fileId);
        } else {
          const blob = await getFile(e.fileId);
          if (blob) item.file = { data: await blobToBase64(blob), type: blob.type, name: receiptName(e, blob.type) };
        }
      }
      const out = await call({ action: 'upsert', tab, dateHeaders, receiptHeader, entries: [item] });
      const receiptUrl = out.results?.[0]?.receiptUrl || item.receiptUrl || '';
      if (e.fileId && receiptUrl) knownUrls.set(e.fileId, receiptUrl);

      // Only clear the dirty flag if nothing changed while we were uploading.
      const latest = await getEntry(e.id);
      if (latest) {
        latest.sheet = { ...latest.sheet, receiptUrl, syncedAt: Date.now(), dirty: latest.updatedAt !== e.updatedAt };
        await putEntry(latest);
      }
    }
    sheetsState.error = '';
    sheetsState.lastSync = Date.now();
  } catch (err) {
    sheetsState.error = err.offline ? '' : err.message;
  } finally {
    syncing = false;
    emit('sheets-changed');
  }
}

// Marks everything as needing to be sent (e.g. after switching tabs) and syncs.
export async function resyncEverything({ forgetRows = false } = {}) {
  const all = await listEntries();
  for (const e of all) {
    e.sheet = { ...e.sheet, dirty: true, ...(forgetRows ? { syncedAt: null } : {}) };
    await putEntry(e);
  }
  if (forgetRows) await kvSet('sheetDeletes', []);
  await syncSheets();
}

export function scriptCode(secret) {
  return `// AI Expense Tracker - Google Sheets connection (version ${SCRIPT_VERSION})
// Paste this into Extensions > Apps Script, then Deploy > New deployment > Web app.

const SECRET = '${secret}';
const VERSION = ${SCRIPT_VERSION};
const ID_HEADER = '${ID_HEADER}';
const FOLDER_NAME = 'AI Expense Tracker Receipts';

function doGet() {
  return ContentService.createTextOutput('AI Expense Tracker connection is running.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.secret !== SECRET) throw new Error('Wrong connection code. Copy the script from the app again.');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      out = handle_(req);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (req.action === 'info') {
    return { ok: true, version: VERSION, name: ss.getName(), tabs: ss.getSheets().map(describe_) };
  }
  if (req.action === 'setup') return setup_(ss, req);
  const sheet = ss.getSheetByName(req.tab);
  if (!sheet) throw new Error('The tab "' + req.tab + '" was not found. If you renamed it, pick it again in the app.');
  if (req.action === 'distinct') return { ok: true, values: distinct_(sheet, req.headers || []) };
  if (req.action === 'upsert') {
    const layout = layout_(sheet);
    return { ok: true, results: req.entries.map(function (en) { return upsert_(sheet, layout, req, en); }) };
  }
  if (req.action === 'delete') {
    const layout = layout_(sheet);
    req.ids.forEach(function (id) {
      const row = findRow_(sheet, layout, id);
      if (row) sheet.deleteRow(row);
    });
    return { ok: true };
  }
  throw new Error('Unknown action: ' + req.action);
}

// The header row is the first of the top 10 rows with at least two filled cells.
function headerRow_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (!lastRow || !lastCol) return 0;
  const rows = sheet.getRange(1, 1, Math.min(10, lastRow), lastCol).getDisplayValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].filter(function (v) { return String(v).trim(); }).length >= 2) return i + 1;
  }
  return 1;
}

function headerMap_(sheet) {
  const hr = headerRow_(sheet);
  const cols = {};
  if (hr) {
    sheet.getRange(hr, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].forEach(function (h, i) {
      h = String(h).trim();
      if (h && !cols[h]) cols[h] = i + 1;
    });
  }
  return { headerRow: hr, cols: cols };
}

function describe_(sheet) {
  const hr = headerRow_(sheet);
  const out = { name: sheet.getName(), headerRow: hr, headers: [], rows: 0, sample: [] };
  if (!hr) return out;
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  out.headers = sheet.getRange(hr, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  out.rows = Math.max(0, lastRow - hr);
  const n = Math.min(5, out.rows);
  if (n > 0) out.sample = sheet.getRange(hr + 1, 1, n, lastCol).getDisplayValues();
  return out;
}

// Makes sure the tab exists, writes headers into an empty tab, adds requested columns,
// and creates the hidden ID column.
function setup_(ss, req) {
  let sheet = ss.getSheetByName(req.tab);
  if (!sheet) sheet = ss.insertSheet(req.tab);
  if (!headerRow_(sheet) && req.headers && req.headers.length) {
    sheet.getRange(1, 1, 1, req.headers.length).setValues([req.headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  const hr = headerRow_(sheet) || 1;
  const add = (req.addHeaders || []).filter(function (h) { return !headerMap_(sheet).cols[h]; });
  if (add.length) sheet.getRange(hr, sheet.getLastColumn() + 1, 1, add.length).setValues([add]);
  layout_(sheet);
  return { ok: true, tab: describe_(sheet) };
}

function layout_(sheet) {
  const map = headerMap_(sheet);
  const hr = map.headerRow || 1;
  let idCol = map.cols[ID_HEADER];
  if (!idCol) {
    idCol = Math.max(sheet.getLastColumn(), 1) + 1;
    sheet.getRange(hr, idCol).setValue(ID_HEADER);
    sheet.hideColumns(idCol);
  }
  return { headerRow: hr, cols: map.cols, idCol: idCol };
}

function distinct_(sheet, wanted) {
  const map = headerMap_(sheet);
  const lastRow = sheet.getLastRow();
  const out = {};
  wanted.forEach(function (h) {
    const c = map.cols[h];
    out[h] = [];
    if (!c || lastRow <= map.headerRow) return;
    const seen = {};
    sheet.getRange(map.headerRow + 1, c, lastRow - map.headerRow, 1).getDisplayValues().forEach(function (r) {
      const v = String(r[0]).trim();
      if (v && !seen[v.toLowerCase()] && out[h].length < 200) {
        seen[v.toLowerCase()] = true;
        out[h].push(v);
      }
    });
  });
  return out;
}

function findRow_(sheet, layout, id) {
  const last = sheet.getLastRow();
  if (last <= layout.headerRow) return 0;
  const ids = sheet.getRange(layout.headerRow + 1, layout.idCol, last - layout.headerRow, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return layout.headerRow + 1 + i;
  return 0;
}

function getFolder_() {
  const found = DriveApp.getFoldersByName(FOLDER_NAME);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
}

// Dates become real dates (so the column's date format applies); text that looks like a
// formula is kept as plain text.
function cell_(header, value, req) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const s = String(value);
  if ((req.dateHeaders || []).indexOf(header) >= 0) {
    const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(s);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return /^[=+\\-@]/.test(s) ? "'" + s : s;
}

function upsert_(sheet, layout, req, en) {
  let receiptUrl = en.receiptUrl || '';
  if (en.file && !receiptUrl) {
    const blob = Utilities.newBlob(Utilities.base64Decode(en.file.data), en.file.type, en.file.name);
    receiptUrl = getFolder_().createFile(blob).getUrl();
  }
  let row = findRow_(sheet, layout, en.id);
  if (!row) {
    row = Math.max(sheet.getLastRow(), layout.headerRow) + 1;
    const width = sheet.getLastColumn();
    // New rows pick up the formatting of the row above (date style, currency, borders...).
    if (row - 1 > layout.headerRow) {
      sheet.getRange(row - 1, 1, 1, width).copyTo(sheet.getRange(row, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    sheet.getRange(row, layout.idCol).setValue(en.id);
  }
  Object.keys(en.values).forEach(function (h) {
    const c = layout.cols[h];
    if (c) sheet.getRange(row, c).setValue(cell_(h, en.values[h], req));
  });
  if (req.receiptHeader && layout.cols[req.receiptHeader]) {
    sheet.getRange(row, layout.cols[req.receiptHeader]).setValue(receiptUrl ? '=HYPERLINK("' + receiptUrl + '","View")' : '');
  }
  return { id: en.id, receiptUrl: receiptUrl };
}
`;
}
