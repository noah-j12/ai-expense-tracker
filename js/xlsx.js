// Excel (.xlsx) support without any library: read a workbook's tabs and cells, build a new
// formatted workbook, and add/update rows in someone's existing workbook while keeping its formatting.

import { entryBytes, entryText, readZip, writeZip, XLSX_MIME } from './zip.js';
import { parseISODate } from './util.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SHEET_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const SHEET_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

const parseXml = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This Excel file could not be read.');
  return doc;
};
const serialize = (doc) => {
  const xml = new XMLSerializer().serializeToString(doc);
  return xml.startsWith('<?xml') ? xml : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml;
};
const byTag = (node, tag) => [...node.getElementsByTagNameNS(NS, tag)];

export function colName(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colNumber(ref) {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function dateSerial(iso) {
  const d = parseISODate(iso);
  return d ? Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EXCEL_EPOCH) / 86400000) : null;
}

function escapeXml(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Reading ----------

export async function openWorkbook(file) {
  if (/\.xls$/i.test(file.name || '')) {
    throw new Error('Older .xls files aren\'t supported. In Excel, use File > Save As and pick "Excel Workbook (.xlsx)".');
  }
  const entries = readZip(await file.arrayBuffer());
  if (!entries.has('xl/workbook.xml')) throw new Error('This file is not an Excel workbook (.xlsx).');
  const wbDoc = parseXml(await entryText(entries.get('xl/workbook.xml')));
  const relDoc = parseXml(await entryText(entries.get('xl/_rels/workbook.xml.rels')));
  const targets = {};
  for (const r of relDoc.getElementsByTagName('Relationship')) targets[r.getAttribute('Id')] = r.getAttribute('Target');
  const sheets = byTag(wbDoc, 'sheet').map((s) => {
    const target = targets[s.getAttributeNS(REL_NS, 'id') || s.getAttribute('r:id')] || '';
    return { name: s.getAttribute('name'), path: resolvePath('xl/', target) };
  });
  let shared = [];
  if (entries.has('xl/sharedStrings.xml')) {
    const ss = parseXml(await entryText(entries.get('xl/sharedStrings.xml')));
    shared = byTag(ss, 'si').map((si) => byTag(si, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));
  }
  return { entries, sheets, shared, dateStyles: await readDateStyles(entries), fileName: file.name || 'Expenses.xlsx', changed: new Map() };
}

// Which cell styles are date formats, so date cells can be read as dates rather than serial numbers.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
async function readDateStyles(entries) {
  const out = new Set();
  const entry = entries.get('xl/styles.xml');
  if (!entry) return out;
  const doc = parseXml(await entryText(entry));
  const custom = new Map(byTag(doc, 'numFmt').map((f) => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '']));
  const xfs = byTag(doc, 'cellXfs')[0];
  (xfs ? byTag(xfs, 'xf') : []).forEach((xf, i) => {
    const id = Number(xf.getAttribute('numFmtId') || 0);
    const code = (custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && /[dmy]/i.test(code))) out.add(i);
  });
  return out;
}

function serialToISO(serial) {
  const d = new Date(EXCEL_EPOCH + Math.round(serial) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (base + target).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

function cellText(c, wb) {
  const t = c.getAttribute('t');
  const v = byTag(c, 'v')[0]?.textContent ?? '';
  if (t === 's') return wb.shared[Number(v)] ?? '';
  if (t === 'inlineStr') return byTag(c, 't').map((x) => x.textContent).join('');
  if (t === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  if ((!t || t === 'n') && v !== '' && wb.dateStyles?.has(Number(c.getAttribute('s') || 0)) && Number.isFinite(Number(v))) return serialToISO(Number(v));
  return v;
}

async function sheetDoc(wb, name) {
  const sheet = wb.sheets.find((s) => s.name === name);
  if (!sheet) throw new Error(`The tab "${name}" isn't in this workbook.`);
  if (wb.changed.has(sheet.path)) return { sheet, doc: wb.changed.get(sheet.path) };
  const entry = wb.entries.get(sheet.path);
  if (!entry) throw new Error(`The tab "${name}" could not be read.`);
  return { sheet, doc: parseXml(await entryText(entry)) };
}

// All rows of a tab as arrays of text (dates come back as Excel serial numbers).
export async function readSheetRows(wb, name, maxRows = Infinity) {
  const { doc } = await sheetDoc(wb, name);
  const rows = [];
  let next = 1;
  for (const r of byTag(doc, 'row')) {
    const rn = Number(r.getAttribute('r')) || next;
    next = rn + 1;
    if (rn > maxRows) break;
    const cells = [];
    let col = 1;
    for (const c of byTag(r, 'c')) {
      const ref = c.getAttribute('r');
      col = ref ? colNumber(ref) : col;
      cells[col - 1] = cellText(c, wb);
      col++;
    }
    rows[rn - 1] = Array.from(cells, (v) => v ?? '');
  }
  return Array.from(rows, (r) => r || []);
}

// ---------- Writing a brand-new workbook ----------

const DATE_CODES = { MDY: 'mm/dd/yyyy', DMY: 'dd/mm/yyyy', ISO: 'yyyy-mm-dd' };

// columns: [{ header, type: 'text'|'money'|'date' }]; rows: arrays of values (dates as ISO strings).
// One tab (sheetName, columns, rows) or several (sheets: [{ name, columns, rows }]).
export function buildWorkbook({ sheetName = 'Expenses', columns, rows, sheets, dateFormat = 'MDY' }) {
  const tabs = (sheets || [{ name: sheetName, columns, rows }]).map((t, i) => {
    const name = String(t.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`;
    return { ...t, name, ...sheetXml(t.columns, t.rows) };
  });
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets>${tabs.map((t, i) => `<sheet name="${escapeXml(t.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${tabs.map((t, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escapeXml(t.name.replace(/'/g, "''"))}'!$A$1:$${t.lastCol}$${t.lastRow}</definedName>`).join('')}</definedNames></workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="${DATE_CODES[dateFormat] || DATE_CODES.MDY}"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  return writeZip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${tabs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${SHEET_CT}"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL_NS}">${tabs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${SHEET_TYPE}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${tabs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    ...tabs.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: t.xml })),
    { name: 'xl/styles.xml', data: styles },
  ]);
}

function sheetXml(columns, rows) {
  const lastCol = colName(Math.max(1, columns.length));
  const lastRow = rows.length + 1;

  const cellXml = (value, type, ref) => {
    if (value === '' || value == null) return '';
    if (type === 'date') {
      const serial = dateSerial(value);
      if (serial != null) return `<c r="${ref}" s="2"><v>${serial}</v></c>`;
    }
    if (type === 'money' && Number.isFinite(Number(value))) return `<c r="${ref}" s="3"><v>${Number(value)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  };

  const header = `<row r="1">${columns.map((c, i) => `<c r="${colName(i + 1)}1" s="1" t="inlineStr"><is><t>${escapeXml(c.header)}</t></is></c>`).join('')}</row>`;
  const body = rows.map((row, r) => `<row r="${r + 2}">${row.map((v, i) => cellXml(v, columns[i].type, `${colName(i + 1)}${r + 2}`)).join('')}</row>`).join('');
  const widths = columns.map((c, i) => {
    const longest = Math.max(c.header.length, ...rows.map((row) => String(row[i] ?? '').length));
    const w = c.type === 'date' ? 12 : c.type === 'money' ? 12 : Math.min(48, Math.max(10, longest + 2));
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');
  const range = `A1:${lastCol}${lastRow}`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS}" xmlns:r="${REL_NS}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>${header}${body}</sheetData><autoFilter ref="${range}"/></worksheet>`;
  return { xml, lastCol, lastRow };
}

// ---------- Editing an existing workbook ----------

// Adds an empty tab with a bold header row to an opened workbook.
export async function addSheet(wb, name, headers) {
  const wbEntry = wb.entries.get('xl/workbook.xml');
  const wbDoc = wb.changed.get('xl/workbook.xml') || parseXml(await entryText(wbEntry));
  const relDoc = wb.changed.get('xl/_rels/workbook.xml.rels') || parseXml(await entryText(wb.entries.get('xl/_rels/workbook.xml.rels')));
  const ctDoc = wb.changed.get('[Content_Types].xml') || parseXml(await entryText(wb.entries.get('[Content_Types].xml')));

  let n = 1;
  while (wb.entries.has(`xl/worksheets/sheet${n}.xml`) || wb.changed.has(`xl/worksheets/sheet${n}.xml`)) n++;
  const path = `xl/worksheets/sheet${n}.xml`;
  const ids = [...relDoc.getElementsByTagName('Relationship')].map((r) => Number(String(r.getAttribute('Id')).replace(/\D/g, '')) || 0);
  const relId = `rId${Math.max(0, ...ids) + 1}`;
  const sheetIds = byTag(wbDoc, 'sheet').map((s) => Number(s.getAttribute('sheetId')) || 0);

  const rel = relDoc.createElementNS(PKG_REL_NS, 'Relationship');
  rel.setAttribute('Id', relId);
  rel.setAttribute('Type', SHEET_TYPE);
  rel.setAttribute('Target', `worksheets/sheet${n}.xml`);
  relDoc.documentElement.appendChild(rel);

  const sheetsEl = byTag(wbDoc, 'sheets')[0];
  const sheetEl = wbDoc.createElementNS(NS, 'sheet');
  sheetEl.setAttribute('name', name);
  sheetEl.setAttribute('sheetId', String(Math.max(0, ...sheetIds) + 1));
  sheetEl.setAttributeNS(REL_NS, 'r:id', relId);
  sheetsEl.appendChild(sheetEl);

  const ct = ctDoc.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
  ct.setAttribute('PartName', '/' + path);
  ct.setAttribute('ContentType', SHEET_CT);
  ctDoc.documentElement.appendChild(ct);

  const headerRow = headers.map((h, i) => `<c r="${colName(i + 1)}1" t="inlineStr"><is><t>${escapeXml(h)}</t></is></c>`).join('');
  const sheetDocNew = parseXml(`<worksheet xmlns="${NS}" xmlns:r="${REL_NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData><row r="1">${headerRow}</row></sheetData></worksheet>`);

  wb.changed.set('xl/workbook.xml', wbDoc);
  wb.changed.set('xl/_rels/workbook.xml.rels', relDoc);
  wb.changed.set('[Content_Types].xml', ctDoc);
  wb.changed.set(path, sheetDocNew);
  wb.sheets.push({ name, path });
}

function rowCells(row) {
  const map = new Map();
  for (const c of byTag(row, 'c')) {
    const ref = c.getAttribute('r');
    if (ref) map.set(colNumber(ref), c);
  }
  return map;
}

// Finds the header row: the first of the top 10 rows with at least two filled cells.
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if ((rows[i] || []).filter((v) => String(v ?? '').trim()).length >= 2) return i;
  }
  return rows.findIndex((r) => (r || []).some((v) => String(v ?? '').trim()));
}

// Splits any <col> range covering `col` so that column alone can be hidden.
function hideColumn(doc, col) {
  const ws = doc.documentElement;
  let cols = byTag(ws, 'cols')[0];
  if (!cols) {
    cols = doc.createElementNS(NS, 'cols');
    ws.insertBefore(cols, byTag(ws, 'sheetData')[0]);
  }
  for (const c of byTag(cols, 'col')) {
    const min = Number(c.getAttribute('min'));
    const max = Number(c.getAttribute('max'));
    if (col < min || col > max) continue;
    if (min < col) {
      const before = c.cloneNode();
      before.setAttribute('max', String(col - 1));
      cols.insertBefore(before, c);
    }
    if (max > col) {
      const after = c.cloneNode();
      after.setAttribute('min', String(col + 1));
      cols.insertBefore(after, c.nextSibling);
    }
    c.setAttribute('min', String(col));
    c.setAttribute('max', String(col));
    c.setAttribute('hidden', '1');
    return;
  }
  const el = doc.createElementNS(NS, 'col');
  el.setAttribute('min', String(col));
  el.setAttribute('max', String(col));
  el.setAttribute('width', '12');
  el.setAttribute('hidden', '1');
  el.setAttribute('customWidth', '1');
  const after = byTag(cols, 'col').find((c) => Number(c.getAttribute('min')) > col);
  cols.insertBefore(el, after || null);
}

async function ensureDateStyle(wb) {
  if (wb.dateStyle != null) return wb.dateStyle;
  const path = 'xl/styles.xml';
  const entry = wb.entries.get(path);
  if (!entry) return (wb.dateStyle = 0);
  const doc = wb.changed.get(path) || parseXml(await entryText(entry));
  const xfs = byTag(doc, 'cellXfs')[0];
  const xf = doc.createElementNS(NS, 'xf');
  for (const [k, v] of Object.entries({ numFmtId: '14', fontId: '0', fillId: '0', borderId: '0', xfId: '0', applyNumberFormat: '1' })) xf.setAttribute(k, v);
  xfs.appendChild(xf);
  const count = byTag(xfs, 'xf').length;
  xfs.setAttribute('count', String(count));
  wb.changed.set(path, doc);
  return (wb.dateStyle = count - 1);
}

function setCell(doc, row, col, rowNum, value, type, style) {
  const cells = rowCells(row);
  let c = cells.get(col);
  if (!c) {
    c = doc.createElementNS(NS, 'c');
    c.setAttribute('r', `${colName(col)}${rowNum}`);
    const after = [...cells.keys()].filter((k) => k > col).sort((a, b) => a - b)[0];
    row.insertBefore(c, after ? cells.get(after) : null);
    if (style != null) c.setAttribute('s', String(style));
  }
  while (c.firstChild) c.removeChild(c.firstChild); // drops old value and any formula
  c.removeAttribute('t');
  if (value === '' || value == null) return;
  if (type === 'date' && dateSerial(value) != null) {
    const v = doc.createElementNS(NS, 'v');
    v.textContent = String(dateSerial(value));
    c.appendChild(v);
  } else if (type === 'money' && Number.isFinite(Number(value))) {
    const v = doc.createElementNS(NS, 'v');
    v.textContent = String(Number(value));
    c.appendChild(v);
  } else {
    c.setAttribute('t', 'inlineStr');
    const is = doc.createElementNS(NS, 'is');
    const t = doc.createElementNS(NS, 't');
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    t.textContent = String(value);
    is.appendChild(t);
    c.appendChild(is);
  }
}

// Moves relative row references by `delta`, like Excel's fill-down ("=SUM($D$4:D6)" -> "=SUM($D$4:D7)").
// Absolute rows ($6) and anything inside quoted strings are left alone.
export function shiftFormula(formula, delta) {
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.replace(
    /(^|[^A-Za-z0-9_.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g,
    (m, pre, colAbs, col, rowAbs, row) => (rowAbs ? m : `${pre}${colAbs}${col}${rowAbs}${Number(row) + delta}`),
  ))).join('');
}

// The formula text a cell would have, resolving shared formulas to their master cell.
function formulaOf(doc, c) {
  const f = byTag(c, 'f')[0];
  if (!f) return null;
  const type = f.getAttribute('t');
  if (type === 'array' || type === 'dataTable') return null;
  const rowNum = Number(/\d+/.exec(c.getAttribute('r'))[0]);
  if (f.textContent) return { text: f.textContent, row: rowNum };
  if (type === 'shared') {
    const si = f.getAttribute('si');
    const master = byTag(doc, 'f').find((x) => x.getAttribute('t') === 'shared' && x.getAttribute('si') === si && x.textContent);
    if (master) return { text: master.textContent, row: Number(/\d+/.exec(master.parentNode.getAttribute('r'))[0]) };
  }
  return null;
}

async function requestRecalc(wb) {
  const path = 'xl/workbook.xml';
  const doc = wb.changed.get(path) || parseXml(await entryText(wb.entries.get(path)));
  let calc = byTag(doc, 'calcPr')[0];
  if (!calc) {
    calc = doc.createElementNS(NS, 'calcPr');
    const later = ['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst'];
    const before = [...doc.documentElement.children].find((el) => later.includes(el.localName));
    doc.documentElement.insertBefore(calc, before || null);
  }
  calc.setAttribute('fullCalcOnLoad', '1');
  wb.changed.set(path, doc);
}

// Extends Excel Tables (and the sheet's filter range) that start at the header row to cover new rows.
async function extendTables(wb, sheet, doc, headerRowNum, lastRow) {
  const relPath = sheet.path.replace(/([^/]+)$/, '_rels/$1.rels');
  const relEntry = wb.entries.get(relPath);
  const grow = (ref) => {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref || '');
    if (!m || Number(m[2]) !== headerRowNum || Number(m[4]) >= lastRow) return null;
    return `${m[1]}${m[2]}:${m[3]}${lastRow}`;
  };
  const sheetFilter = byTag(doc, 'autoFilter')[0];
  if (sheetFilter && grow(sheetFilter.getAttribute('ref'))) sheetFilter.setAttribute('ref', grow(sheetFilter.getAttribute('ref')));
  if (!relEntry) return;
  const rels = parseXml(await entryText(relEntry));
  for (const r of rels.getElementsByTagName('Relationship')) {
    if (!/\/table$/.test(r.getAttribute('Type') || '')) continue;
    const path = resolvePath(sheet.path.replace(/[^/]+$/, ''), r.getAttribute('Target'));
    const entry = wb.entries.get(path);
    if (!entry) continue;
    const tdoc = parseXml(await entryText(entry));
    const table = tdoc.documentElement;
    if (Number(table.getAttribute('totalsRowCount') || 0) > 0) continue;
    const next = grow(table.getAttribute('ref'));
    if (!next) continue;
    table.setAttribute('ref', next);
    const af = byTag(tdoc, 'autoFilter')[0];
    if (af && grow(af.getAttribute('ref'))) af.setAttribute('ref', grow(af.getAttribute('ref')));
    wb.changed.set(path, tdoc);
  }
}

/**
 * Adds or updates expense rows in a tab, matching columns by header name.
 * items: [{ id, dirty, values: { [header]: { value, type } } }]
 * Rows are found again through a hidden ID column, which is created automatically.
 * Returns { added, updated, unchanged, idsInFile }.
 */
export async function upsertRows(wb, { tab, idHeader, items, addHeaders = [] }) {
  const { sheet, doc } = await sheetDoc(wb, tab);
  const sheetData = byTag(doc, 'sheetData')[0];
  const rowEls = new Map(byTag(sheetData, 'row').map((r) => [Number(r.getAttribute('r')), r]));
  const text = await readSheetRows(wb, tab);

  let headerIdx = findHeaderRow(text);
  if (headerIdx < 0) headerIdx = 0;
  const headerRowNum = headerIdx + 1;
  const headerCells = new Map();
  (text[headerIdx] || []).forEach((h, i) => {
    const key = String(h ?? '').trim();
    if (key && !headerCells.has(key)) headerCells.set(key, i + 1);
  });
  let headerRowEl = rowEls.get(headerRowNum);
  if (!headerRowEl) {
    headerRowEl = doc.createElementNS(NS, 'row');
    headerRowEl.setAttribute('r', String(headerRowNum));
    sheetData.insertBefore(headerRowEl, sheetData.firstChild);
    rowEls.set(headerRowNum, headerRowEl);
  }

  let maxCol = Math.max(0, ...text.map((r) => r.length));
  // New columns the user asked for go after their last column, styled like their other headers.
  const headerStyle = [...rowCells(headerRowEl).values()].pop()?.getAttribute('s') ?? null;
  for (const header of addHeaders) {
    if (headerCells.has(header)) continue;
    maxCol++;
    setCell(doc, headerRowEl, maxCol, headerRowNum, header, 'text', headerStyle);
    headerCells.set(header, maxCol);
  }
  maxCol = Math.max(1, maxCol);
  let idCol = headerCells.get(idHeader);
  if (!idCol) {
    idCol = maxCol + 1;
    setCell(doc, headerRowEl, idCol, headerRowNum, idHeader, 'text', null);
    hideColumn(doc, idCol);
  }

  // Where each existing expense lives, and where the data ends.
  const idRows = new Map();
  let lastDataRow = headerRowNum;
  text.forEach((row, i) => {
    const rn = i + 1;
    if (rn <= headerRowNum) return;
    if (row.some((v) => String(v ?? '').trim())) lastDataRow = rn;
    const id = String(row[idCol - 1] ?? '').trim();
    if (id) idRows.set(id, rn);
  });
  const templateRow = lastDataRow > headerRowNum ? rowCells(rowEls.get(lastDataRow)) : new Map();

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let lastRow = lastDataRow;
  for (const item of items) {
    let rn = idRows.get(item.id);
    const isNew = !rn;
    if (!isNew && !item.dirty) { unchanged++; continue; }
    if (isNew) {
      rn = ++lastRow;
      if (!rowEls.has(rn)) {
        const r = doc.createElementNS(NS, 'row');
        r.setAttribute('r', String(rn));
        const after = [...rowEls.keys()].filter((k) => k > rn).sort((a, b) => a - b)[0];
        sheetData.insertBefore(r, after ? rowEls.get(after) : null);
        rowEls.set(rn, r);
      }
    }
    const row = rowEls.get(rn);
    row.removeAttribute('spans');
    for (const [header, { value, type }] of Object.entries(item.values)) {
      const col = headerCells.get(header);
      if (!col) continue;
      let style = templateRow.get(col)?.getAttribute('s') ?? null;
      if (style == null && type === 'date') style = await ensureDateStyle(wb);
      setCell(doc, row, col, rn, value, type, style);
    }
    setCell(doc, row, idCol, rn, item.id, 'text', templateRow.get(idCol)?.getAttribute('s') ?? null);
    if (isNew) {
      // Carry formula columns (running totals etc.) down from the last row, like Excel's fill-down.
      const filled = rowCells(row);
      for (const [col, tc] of templateRow) {
        if (col === idCol || byTag(filled.get(col) || doc.createElementNS(NS, 'c'), 'f').length) continue;
        if ([...headerCells.entries()].some(([hd, c]) => c === col && item.values[hd])) continue;
        const src = formulaOf(doc, tc);
        if (!src) continue;
        setCell(doc, row, col, rn, '', 'text', tc.getAttribute('s'));
        const f = doc.createElementNS(NS, 'f');
        f.textContent = shiftFormula(src.text, rn - src.row);
        rowCells(row).get(col).appendChild(f);
        wb.needsRecalc = true;
      }
    }
    if (isNew) added++;
    else updated++;
  }

  const finalCol = Math.max(maxCol, idCol);
  const dim = byTag(doc, 'dimension')[0];
  if (dim) dim.setAttribute('ref', `A1:${colName(finalCol)}${Math.max(lastRow, ...rowEls.keys())}`);
  await extendTables(wb, sheet, doc, headerRowNum, lastRow);
  // Formulas we added have no cached result yet; have Excel calculate when the file opens.
  if (wb.needsRecalc) await requestRecalc(wb);
  wb.changed.set(sheet.path, doc);
  return { added, updated, unchanged, idsInFile: new Set(idRows.keys()) };
}

// Rebuilds the .xlsx with every changed part swapped in.
export async function saveWorkbook(wb) {
  // Drop the calculation-order cache; Excel rebuilds it on open, and a stale one triggers a "repair" prompt.
  const CALC = 'xl/calcChain.xml';
  if (wb.entries.has(CALC)) {
    const ct = wb.changed.get('[Content_Types].xml') || parseXml(await entryText(wb.entries.get('[Content_Types].xml')));
    for (const o of [...ct.getElementsByTagName('Override')]) if (o.getAttribute('PartName') === '/' + CALC) o.parentNode.removeChild(o);
    const rels = wb.changed.get('xl/_rels/workbook.xml.rels') || parseXml(await entryText(wb.entries.get('xl/_rels/workbook.xml.rels')));
    for (const r of [...rels.getElementsByTagName('Relationship')]) if (/calcChain$/.test(r.getAttribute('Type') || '')) r.parentNode.removeChild(r);
    wb.changed.set('[Content_Types].xml', ct);
    wb.changed.set('xl/_rels/workbook.xml.rels', rels);
  }
  const files = [];
  const seen = new Set();
  for (const [name, entry] of wb.entries) {
    if (name === CALC) continue;
    seen.add(name);
    const doc = wb.changed.get(name);
    files.push({ name, data: doc ? serialize(doc) : await entryBytes(entry) });
  }
  for (const [name, doc] of wb.changed) if (!seen.has(name)) files.push({ name, data: serialize(doc) });
  return new File([writeZip(files)], wb.fileName, { type: XLSX_MIME });
}
