// The parts of an expense that can fill a spreadsheet column. Shared by Google Sheets and custom export formats.

import { businessName } from './settings.js';
import { parseISODate, toISODate } from './util.js';

export const FIELDS = [
  { key: 'date', label: 'Date' },
  { key: 'vendor', label: 'Vendor / payee' },
  { key: 'description', label: 'What it was for' },
  { key: 'vendorDescription', label: 'Vendor + what it was for' },
  { key: 'category', label: 'Category' },
  { key: 'total', label: 'Amount' },
  { key: 'totalNegative', label: 'Amount as a negative number' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'tax', label: 'Tax' },
  { key: 'tip', label: 'Tip' },
  { key: 'currency', label: 'Currency' },
  { key: 'paymentMethod', label: 'Payment method' },
  { key: 'notes', label: 'Notes' },
  { key: 'book', label: 'Books' },
  { key: 'status', label: 'Review status' },
  { key: 'receipt', label: 'Receipt link' },
  { key: 'source', label: 'How it was added' },
  { key: 'loggedAt', label: 'When it was logged' },
];

// Header of the hidden column the app adds to Google Sheets and Excel files to find its rows again.
export const ID_HEADER = 'AI Expense Tracker ID';

export const fieldLabel = (key) => FIELDS.find((f) => f.key === key)?.label || 'Leave blank';

export function formatExportDate(iso, format) {
  const d = parseISODate(iso);
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  if (format === 'DMY') return `${dd}/${mm}/${yyyy}`;
  if (format === 'ISO') return iso;
  return `${mm}/${dd}/${yyyy}`;
}

const SOURCE_LABELS = { photo: 'Photo', upload: 'Upload', voice: 'Voice', manual: 'Manual', sheet: 'Sheet' };

// Fields that a change typed into the sheet can update in the app.
export const SHEET_EDITABLE = new Set(['date', 'vendor', 'description', 'category', 'total', 'totalNegative', 'subtotal', 'tax', 'tip', 'currency', 'paymentMethod', 'notes']);
const MONEY = new Set(['total', 'totalNegative', 'subtotal', 'tax', 'tip']);

// The ISO date if it's a real calendar date (not, say, Feb 31).
const realDate = (iso) => (toISODate(parseISODate(iso) || new Date(NaN)) === iso ? iso : undefined);

// A sheet cell (or the app's own value) in one comparable form: ISO dates, amounts rounded to cents,
// trimmed text. Returns undefined for a cell that can't be understood (e.g. a date typed as "Tuesday"),
// which is then left alone.
export function normalizeField(key, v, dateFormat = 'MDY') {
  if (key === 'date') {
    if (typeof v === 'number' && v > 0) {
      // Google Sheets date serial: days since 1899-12-30.
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000).toISOString().slice(0, 10);
    }
    const s = String(v ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return realDate(s.slice(0, 10));
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
    if (!m) return undefined;
    const [a, b] = dateFormat === 'DMY' ? [m[2], m[1]] : [m[1], m[2]];
    const iso = `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    return realDate(iso);
  }
  if (MONEY.has(key)) {
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    const s = String(v ?? '').trim();
    if (!s) return 0;
    const n = parseFloat(s.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(n)) return undefined;
    const negative = /^\(.*\)$/.test(s) || /^[^0-9]*-/.test(s);
    return Math.round((negative ? -n : n) * 100) / 100;
  }
  const s = String(v ?? '').trim();
  return key === 'category' && s === 'Uncategorized' ? '' : s;
}

// sheet: true gives raw numbers and ISO dates (Google Sheets formats them itself);
// otherwise values are formatted text for a CSV file.
export function fieldValue(e, key, { sheet = false, dateFormat = 'MDY' } = {}) {
  const f = e.fields;
  const money = (n) => (sheet ? Math.round((Number(n) || 0) * 100) / 100 : (Math.round((Number(n) || 0) * 100) / 100).toFixed(2));
  switch (key) {
    case 'date': return sheet ? f.date : formatExportDate(f.date, dateFormat);
    case 'vendor': return f.vendor;
    case 'description': return f.description;
    case 'vendorDescription': return [f.vendor, f.description].filter(Boolean).join(' - ');
    case 'category': return f.category || 'Uncategorized';
    case 'total': return money(f.total);
    case 'totalNegative': return money(-(Number(f.total) || 0));
    case 'subtotal': return money(f.subtotal);
    case 'tax': return money(f.tax);
    case 'tip': return money(f.tip);
    case 'currency': return f.currency;
    case 'paymentMethod': return f.paymentMethod;
    case 'notes': return f.notes;
    case 'book': return businessName(e.businessId);
    case 'status': return !e.reviewed && e.reviewReasons?.length ? 'Needs review' : 'OK';
    case 'receipt': return e.sheet?.receiptUrl || '';
    case 'source': return SOURCE_LABELS[e.source] || e.source;
    case 'loggedAt': {
      const d = new Date(e.createdAt);
      if (!sheet) return d.toLocaleString();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    default: return '';
  }
}

// Name-based guesses, checked in order. Works offline; the AI refines these when it's available.
const RULES = [
  ['loggedAt', /\b(logged|created|entered|timestamp|added on)\b/],
  ['receipt', /\b(receipts?|image|photo|attachment|link|proof|scan)\b/],
  ['status', /\b(status|reviewed?)\b/],
  ['tax', /\b(tax|taxes|vat|gst|hst|pst)\b/],
  ['tip', /\b(tip|tips|gratuity)\b/],
  ['subtotal', /\b(sub ?total|pre ?tax|net amount)\b/],
  ['currency', /\b(currency|curr|ccy)\b/],
  ['total', /(\$|\b(amount|amt|total|cost|price|sum|debit|spent)\b)/],
  ['paymentMethod', /\b(payment|paid with|paid by|card|method|pay type|account used|funding)\b/],
  ['date', /\b(date|day|when|posted)\b/],
  ['category', /\b(category|categories|type|class|classification|account|gl|bucket|code)\b/],
  ['vendor', /\b(vendor|payee|merchant|store|supplier|seller|paid to|company|shop|where|name)\b/],
  ['description', /\b(description|desc|items?|memo|details?|purpose|what|for|particulars|reason)\b/],
  ['notes', /\b(notes?|comments?|remarks?)\b/],
  ['book', /\b(business|entity|books?)\b/],
  ['total', /\b(paid|expense|value)\b/],
];

export function guessField(header) {
  const norm = String(header).toLowerCase().replace(/[_\-/.:()#]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [key, re] of RULES) if (re.test(norm)) return key;
  return '';
}

// One field per column, each field used at most once. Amount columns whose sample values are
// mostly negative are mapped to "Amount as a negative number".
export function autoMap(headers, samples = []) {
  const used = new Set();
  return headers.map((header, i) => {
    let key = guessField(header);
    if (key === 'total') {
      const nums = samples.map((r) => parseFloat(String(r[i] ?? '').replace(/[^0-9.\-()]/g, '').replace(/^\((.*)\)$/, '-$1'))).filter(Number.isFinite);
      if (nums.length && nums.filter((n) => n < 0).length > nums.length / 2) key = 'totalNegative';
    }
    if (!key || used.has(key)) return '';
    used.add(key);
    return key;
  });
}
