// "Connect with Google": the app talks to Google Sheets and Drive directly, no script.
// It asks only for Google's non-sensitive `drive.file` permission (files the app creates or the user picks),
// which never shows the "unverified app" screen. Sign-in uses Google's device-code flow, which gives a
// long-lasting refresh token, so the connection doesn't expire after an hour like browser sign-ins do.

import { GOOGLE } from './google-config.js';
import { settings, updateSettings } from './settings.js';
import { findHeaderRow } from './xlsx.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_NAME = 'AI Expense Tracker Receipts';

export class GoogleError extends Error {
  constructor(message, { offline = false, signedOut = false } = {}) {
    super(message);
    this.offline = offline;
    this.signedOut = signedOut;
  }
}

async function post(url, params) {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
  } catch {
    throw new GoogleError('Could not reach Google. Check your connection.', { offline: true });
  }
}

// ---------- Sign-in (device-code flow) ----------

// Returns { deviceCode, userCode, verificationUrl, interval, expiresAt }.
export async function startDeviceAuth() {
  const res = await post('https://oauth2.googleapis.com/device/code', { client_id: GOOGLE.clientId, scope: SCOPE });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(`Google sign-in couldn't start (${data.error_description || data.error || res.status}).`);
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url || 'https://www.google.com/device',
    interval: Math.max(5, Number(data.interval) || 5),
    expiresAt: Date.now() + (Number(data.expires_in) || 1800) * 1000,
  };
}

// One poll. Returns 'pending' | 'slow_down' | 'done'. Throws if denied or expired.
export async function pollDeviceAuth(deviceCode) {
  const res = await post('https://oauth2.googleapis.com/token', {
    client_id: GOOGLE.clientId,
    client_secret: GOOGLE.clientSecret,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.refresh_token) {
    token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 };
    await updateSettings((d) => { d.sheets.google = { ...d.sheets.google, refreshToken: data.refresh_token }; });
    return 'done';
  }
  if (data.error === 'authorization_pending') return 'pending';
  if (data.error === 'slow_down') return 'slow_down';
  if (data.error === 'access_denied') throw new GoogleError('Access wasn\'t allowed on the Google page. Tap Connect to try again.');
  if (data.error === 'expired_token') throw new GoogleError('That code expired. Tap Connect to get a new one.');
  throw new GoogleError(`Google sign-in failed (${data.error_description || data.error || res.status}).`);
}

let token = null; // { value, expiresAt } kept in memory only

export async function accessToken() {
  if (token && token.expiresAt > Date.now()) return token.value;
  const refresh = settings().sheets.google?.refreshToken;
  if (!refresh) throw new GoogleError('Connect Google again in Settings → Google Sheets.', { signedOut: true });
  const res = await post('https://oauth2.googleapis.com/token', {
    client_id: GOOGLE.clientId,
    client_secret: GOOGLE.clientSecret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new GoogleError('The Google connection was turned off. Reconnect in Settings → Google Sheets.', { signedOut: true });
    throw new GoogleError('Google didn\'t respond properly. It will try again shortly.');
  }
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 };
  return token.value;
}

export async function signOutGoogle() {
  const refresh = settings().sheets.google?.refreshToken;
  token = null;
  if (refresh) post('https://oauth2.googleapis.com/revoke', { token: refresh }).catch(() => {});
}

// ---------- API helper ----------

async function api(url, { method = 'GET', json, body, headers = {} } = {}, retried = false) {
  const auth = await accessToken();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${auth}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
    });
  } catch {
    throw new GoogleError('Could not reach Google. Check your connection.', { offline: true });
  }
  if (res.status === 401 && !retried) {
    token = null;
    return api(url, { method, json, body, headers }, true);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.error?.message || `error ${res.status}`;
    if (res.status === 403 || res.status === 404) {
      throw new GoogleError('The app can\'t open that spreadsheet anymore. Choose it again in Settings → Google Sheets.');
    }
    throw new GoogleError(`Google Sheets: ${msg}`);
  }
  return res.status === 204 ? null : res.json();
}

const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

function colName(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------- Spreadsheets ----------

export async function createSpreadsheet(title, tab, headers) {
  const created = await api(SHEETS, {
    method: 'POST',
    json: {
      properties: { title },
      sheets: [{ properties: { title: tab, gridProperties: { frozenRowCount: 1 } } }],
    },
  });
  const sheetId = created.sheets[0].properties.sheetId;
  await api(`${SHEETS}/${created.spreadsheetId}/values/${encodeURIComponent(`${q(tab)}!A1`)}?valueInputOption=RAW`, {
    method: 'PUT',
    json: { values: [headers] },
  });
  await api(`${SHEETS}/${created.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    json: { requests: [{ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } }] },
  });
  return { spreadsheetId: created.spreadsheetId, name: title };
}

async function tabsMeta(spreadsheetId) {
  return api(`${SHEETS}/${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`);
}

async function tabValues(spreadsheetId, tab) {
  const data = await api(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(q(tab))}?valueRenderOption=FORMATTED_VALUE`);
  return data.values || [];
}

// Same shape as the script's "info": { name, tabs: [{ name, headers, rows, sample }] }.
export async function spreadsheetInfo(spreadsheetId) {
  const meta = await tabsMeta(spreadsheetId);
  const tabs = [];
  for (const s of meta.sheets) {
    const rows = await tabValues(spreadsheetId, s.properties.title);
    const hi = findHeaderRow(rows);
    const headers = hi < 0 ? [] : (rows[hi] || []).map((x) => String(x ?? '').trim());
    const data = hi < 0 ? [] : rows.slice(hi + 1).filter((r) => (r || []).some((v) => String(v ?? '').trim()));
    tabs.push({ name: s.properties.title, headers, rows: data.length, sample: data.slice(0, 5), allRows: data });
  }
  return { name: meta.properties.title, tabs };
}

async function addTab(spreadsheetId, tab, headers) {
  const out = await api(`${SHEETS}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    json: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] },
  });
  const sheetId = out.replies[0].addSheet.properties.sheetId;
  await api(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(`${q(tab)}!A1`)}?valueInputOption=RAW`, { method: 'PUT', json: { values: [headers] } });
  await api(`${SHEETS}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    json: { requests: [{ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } }] },
  });
}

// Makes sure the tab exists (creating it with `headers` if not) and has any added columns.
export async function prepareGoogleTab({ spreadsheetId, tab, headers = [], addHeaders = [] }) {
  const meta = await tabsMeta(spreadsheetId);
  if (!meta.sheets.some((s) => s.properties.title === tab)) await addTab(spreadsheetId, tab, headers);
  if (addHeaders.length) await layout(spreadsheetId, tab, { addHeaders, idHeader: null });
}

// Reads the tab and makes sure the requested headers (and the hidden ID column) exist.
async function layout(spreadsheetId, tab, { addHeaders = [], idHeader }) {
  const meta = await tabsMeta(spreadsheetId);
  const sheet = meta.sheets.find((s) => s.properties.title === tab);
  if (!sheet) throw new GoogleError(`The tab "${tab}" wasn't found. If you renamed it, pick it again in Settings → Google Sheets.`);
  const sheetId = sheet.properties.sheetId;
  const rows = await tabValues(spreadsheetId, tab);
  let hi = findHeaderRow(rows);
  if (hi < 0) hi = 0;
  const headerRow = hi + 1;
  const cols = new Map();
  (rows[hi] || []).forEach((h, i) => {
    const k = String(h ?? '').trim();
    if (k && !cols.has(k)) cols.set(k, i + 1);
  });
  let maxCol = Math.max(0, ...rows.map((r) => r.length));
  const writes = [];
  const requests = [];
  for (const h of addHeaders) {
    if (cols.has(h)) continue;
    maxCol++;
    cols.set(h, maxCol);
    writes.push({ range: `${q(tab)}!${colName(maxCol)}${headerRow}`, values: [[h]] });
  }
  if (idHeader && !cols.has(idHeader)) {
    maxCol++;
    cols.set(idHeader, maxCol);
    writes.push({ range: `${q(tab)}!${colName(maxCol)}${headerRow}`, values: [[idHeader]] });
    requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: maxCol - 1, endIndex: maxCol }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
  }
  const needCols = maxCol - (sheet.properties.gridProperties?.columnCount || 26);
  if (needCols > 0) requests.unshift({ appendDimension: { sheetId, dimension: 'COLUMNS', length: needCols } });
  if (requests.length) await api(`${SHEETS}/${spreadsheetId}:batchUpdate`, { method: 'POST', json: { requests } });
  if (writes.length) {
    await api(`${SHEETS}/${spreadsheetId}/values:batchUpdate`, { method: 'POST', json: { valueInputOption: 'RAW', data: writes } });
  }
  return { sheetId, rows, headerRow, cols, rowCount: sheet.properties.gridProperties?.rowCount || 1000 };
}

// Text that looks like a formula is kept as text; ISO dates and numbers are left for Sheets to type.
function cellValue(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/**
 * Adds or updates rows, matching columns by header name and finding rows again by a hidden ID column.
 * items: [{ id, values: { [header]: value }, receiptUrl }]; receiptHeader gets a HYPERLINK.
 * Returns [{ id, receiptUrl }].
 */
export async function googleUpsert({ spreadsheetId, tab, items, receiptHeader, idHeader, addHeaders = [] }) {
  const lay = await layout(spreadsheetId, tab, { addHeaders, idHeader });
  const idCol = lay.cols.get(idHeader);
  const idRows = new Map();
  let lastDataRow = lay.headerRow;
  lay.rows.forEach((row, i) => {
    const rn = i + 1;
    if (rn <= lay.headerRow) return;
    if (row.some((v) => String(v ?? '').trim())) lastDataRow = rn;
    const id = String(row[idCol - 1] ?? '').trim();
    if (id) idRows.set(id, rn);
  });
  const templateRow = lastDataRow > lay.headerRow ? lastDataRow : null;

  const data = [];
  const requests = [];
  let lastRow = lastDataRow;
  const results = [];
  for (const item of items) {
    let rn = idRows.get(item.id);
    if (!rn) {
      rn = ++lastRow;
      data.push({ range: `${q(tab)}!${colName(idCol)}${rn}`, values: [[item.id]] });
      // New rows pick up the formatting of the row above.
      if (templateRow) {
        requests.push({ copyPaste: {
          source: { sheetId: lay.sheetId, startRowIndex: templateRow - 1, endRowIndex: templateRow },
          destination: { sheetId: lay.sheetId, startRowIndex: rn - 1, endRowIndex: rn },
          pasteType: 'PASTE_FORMAT',
        } });
      }
    }
    for (const [header, value] of Object.entries(item.values)) {
      const c = lay.cols.get(header);
      if (c) data.push({ range: `${q(tab)}!${colName(c)}${rn}`, values: [[cellValue(value)]] });
    }
    if (receiptHeader && lay.cols.get(receiptHeader)) {
      const url = item.receiptUrl;
      data.push({ range: `${q(tab)}!${colName(lay.cols.get(receiptHeader))}${rn}`, values: [[url ? `=HYPERLINK("${url}","View")` : '']] });
    }
    results.push({ id: item.id, receiptUrl: item.receiptUrl || '' });
  }
  if (lastRow > lay.rowCount) requests.unshift({ appendDimension: { sheetId: lay.sheetId, dimension: 'ROWS', length: lastRow - lay.rowCount + 50 } });
  if (requests.length) await api(`${SHEETS}/${spreadsheetId}:batchUpdate`, { method: 'POST', json: { requests } });
  if (data.length) await api(`${SHEETS}/${spreadsheetId}/values:batchUpdate`, { method: 'POST', json: { valueInputOption: 'USER_ENTERED', data } });
  return results;
}

export async function googleDelete({ spreadsheetId, tab, ids, idHeader }) {
  const lay = await layout(spreadsheetId, tab, { idHeader });
  const idCol = lay.cols.get(idHeader);
  const doomed = [];
  lay.rows.forEach((row, i) => {
    if (i + 1 > lay.headerRow && ids.includes(String(row[idCol - 1] ?? '').trim())) doomed.push(i);
  });
  if (!doomed.length) return;
  // Bottom-up so earlier deletions don't shift the later ones.
  const requests = doomed.sort((a, b) => b - a).map((i) => ({ deleteDimension: { range: { sheetId: lay.sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }));
  await api(`${SHEETS}/${spreadsheetId}:batchUpdate`, { method: 'POST', json: { requests } });
}

// ---------- Receipt photos in Drive ----------

async function receiptsFolder() {
  const saved = settings().sheets.google?.folderId;
  if (saved) return saved;
  const folder = await api(`${DRIVE}?fields=id`, { method: 'POST', json: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' } });
  await updateSettings((d) => { d.sheets.google = { ...d.sheets.google, folderId: folder.id }; });
  return folder.id;
}

export async function uploadReceipt(blob, name) {
  const parent = await receiptsFolder();
  const boundary = 'aiet' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [parent] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  try {
    const file = await api(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,webViewLink`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
    return file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
  } catch (err) {
    // The folder may have been deleted; make a new one next time.
    if (!err.offline) await updateSettings((d) => { d.sheets.google = { ...d.sheets.google, folderId: '' }; });
    throw err;
  }
}

// ---------- Choosing an existing sheet (Google Picker) ----------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new GoogleError('Couldn\'t load Google\'s file picker. Check your connection.', { offline: true }));
    document.head.append(s);
  });
}

// Resolves { id, name } or null if cancelled. Picking a file is what gives the app access to it.
export async function pickSpreadsheet() {
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise((resolve) => window.gapi.load('picker', resolve));
  const auth = await accessToken();
  const g = window.google.picker;
  return new Promise((resolve) => {
    let done = false;
    // Google's picker has no way out when it shows an error, so always put our own Close button on top.
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn picker-close';
    closeBtn.textContent = 'Close';
    const finish = (value) => {
      if (done) return;
      done = true;
      closeBtn.remove();
      try { picker.dispose(); } catch { /* already gone */ }
      resolve(value);
    };
    closeBtn.onclick = () => finish(null);
    const picker = new g.PickerBuilder()
      .addView(new g.DocsView(g.ViewId.SPREADSHEETS).setMode(g.DocsViewMode.LIST))
      .setOAuthToken(auth)
      .setDeveloperKey(GOOGLE.apiKey)
      .setAppId(GOOGLE.projectNumber)
      .setTitle('Choose your expense sheet')
      .setCallback((data) => {
        if (data.action === g.Action.PICKED) finish({ id: data.docs[0].id, name: data.docs[0].name });
        else if (data.action === g.Action.CANCEL) finish(null);
      })
      .build();
    picker.setVisible(true);
    document.body.append(closeBtn);
  });
}
