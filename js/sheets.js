// Optional Google Sheets sync. The user pastes a small Apps Script into their own Google Sheet and
// deploys it as a web app; this app then POSTs rows (and receipt photos for Drive) to that URL.
// Nothing runs on our side: the script lives in the user's Google account.

import { getFile, kvGet, kvSet, putEntry } from './db.js';
import { businessName, settings } from './settings.js';
import { getEntry, listEntries } from './entries.js';
import { blobToBase64, emit, safeFileName } from './util.js';

export const sheetsState = { error: '', lastSync: null };

export function sheetsConnected() {
  const s = settings();
  return Boolean(s.sheets.url && s.sheets.secret);
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

export async function testSheets(url, secret) {
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
    throw new Error('That doesn\'t look like an Apps Script web app URL. It should start with https://script.google.com/');
  }
  return call({ action: 'ping' }, url, secret);
}

function receiptName(e, type) {
  const ext = type === 'application/pdf' ? 'pdf' : 'jpg';
  return safeFileName(`${e.fields.date} ${e.fields.vendor || 'Receipt'} ${e.fields.total}`) + '.' + ext;
}

function toRow(e) {
  const f = e.fields;
  return {
    id: e.id,
    date: f.date,
    vendor: f.vendor,
    description: f.description,
    total: f.total,
    tax: f.tax,
    tip: f.tip,
    subtotal: f.subtotal,
    currency: f.currency,
    category: f.category || 'Uncategorized',
    business: businessName(e.businessId),
    paymentMethod: f.paymentMethod,
    notes: f.notes,
    status: !e.reviewed && e.reviewReasons?.length ? 'Needs review' : 'OK',
    source: { photo: 'Photo', upload: 'Upload', voice: 'Voice', manual: 'Manual' }[e.source] || e.source,
    loggedAt: new Date(e.createdAt).toLocaleString(),
    receiptUrl: e.sheet?.receiptUrl || '',
  };
}

let syncing = false;

export async function syncSheets() {
  if (!sheetsConnected() || syncing) return;
  syncing = true;
  try {
    const deletes = (await kvGet('sheetDeletes')) || [];
    if (deletes.length) {
      await call({ action: 'delete', ids: deletes });
      await kvSet('sheetDeletes', []);
    }

    const all = await listEntries();
    // Split entries share one photo; reuse its Drive link instead of uploading it twice.
    const knownUrls = new Map(all.filter((e) => e.fileId && e.sheet?.receiptUrl).map((e) => [e.fileId, e.sheet.receiptUrl]));
    const dirty = all.filter((e) => e.sheet?.dirty && (e.aiStatus === 'done' || e.aiStatus === 'skipped'));

    for (const e of dirty) {
      const row = toRow(e);
      if (e.fileId && !row.receiptUrl) {
        if (knownUrls.has(e.fileId)) {
          row.receiptUrl = knownUrls.get(e.fileId);
        } else {
          const blob = await getFile(e.fileId);
          if (blob) row.file = { data: await blobToBase64(blob), type: blob.type, name: receiptName(e, blob.type) };
        }
      }
      const out = await call({ action: 'upsert', entries: [row] });
      const receiptUrl = out.results?.[0]?.receiptUrl || row.receiptUrl || '';
      if (e.fileId && receiptUrl) knownUrls.set(e.fileId, receiptUrl);

      // Only clear the dirty flag if nothing changed while we were uploading.
      const latest = await getEntry(e.id);
      if (latest) {
        latest.sheet = {
          ...latest.sheet,
          receiptUrl,
          syncedAt: Date.now(),
          dirty: latest.updatedAt !== e.updatedAt,
        };
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

export async function resyncEverything() {
  const all = await listEntries();
  for (const e of all) {
    e.sheet = { ...e.sheet, dirty: true };
    await putEntry(e);
  }
  await syncSheets();
}

export function scriptCode(secret) {
  return `// AI Expense Tracker - Google Sheets connection
// Paste this into Extensions > Apps Script, then Deploy > New deployment > Web app.

const SECRET = '${secret}';
const SHEET_NAME = 'Expenses';
const FOLDER_NAME = 'AI Expense Tracker Receipts';
const HEADERS = ['Date', 'Vendor', 'Description', 'Amount', 'Tax', 'Tip', 'Subtotal', 'Currency',
  'Category', 'Business', 'Payment Method', 'Notes', 'Status', 'Receipt', 'Source', 'Logged At', 'Entry ID'];

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
  const sheet = getSheet_();
  if (req.action === 'ping') {
    return { ok: true, name: SpreadsheetApp.getActiveSpreadsheet().getName() };
  }
  if (req.action === 'upsert') {
    return { ok: true, results: req.entries.map(function (en) { return upsert_(sheet, en); }) };
  }
  if (req.action === 'delete') {
    req.ids.forEach(function (id) {
      const row = findRow_(sheet, id);
      if (row) sheet.deleteRow(row);
    });
    return { ok: true };
  }
  throw new Error('Unknown action: ' + req.action);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function getFolder_() {
  const found = DriveApp.getFoldersByName(FOLDER_NAME);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
}

function findRow_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, HEADERS.length, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}

// Stops text like "=SUM(...)" in a vendor name from being run as a formula.
function text_(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\\-@]/.test(s) ? "'" + s : s;
}

function upsert_(sheet, en) {
  let receiptUrl = en.receiptUrl || '';
  if (en.file && !receiptUrl) {
    const blob = Utilities.newBlob(Utilities.base64Decode(en.file.data), en.file.type, en.file.name);
    receiptUrl = getFolder_().createFile(blob).getUrl();
  }
  const row = [
    en.date, text_(en.vendor), text_(en.description), Number(en.total) || 0, Number(en.tax) || 0,
    Number(en.tip) || 0, Number(en.subtotal) || 0, en.currency, text_(en.category), text_(en.business),
    text_(en.paymentMethod), text_(en.notes), en.status,
    receiptUrl ? '=HYPERLINK("' + receiptUrl + '","View")' : '',
    en.source, en.loggedAt, en.id,
  ];
  const existing = findRow_(sheet, en.id);
  if (existing) sheet.getRange(existing, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  return { id: en.id, receiptUrl: receiptUrl };
}
`;
}
