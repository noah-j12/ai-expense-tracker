import { kvGet, kvSet } from './db.js';
import { emit, uid } from './util.js';

export const CATEGORY_PRESETS = [
  {
    id: 'small-business',
    name: 'Small business',
    hint: 'Common IRS business expense categories',
    categories: [
      'Advertising & Marketing', 'Bank & Payment Fees', 'Car & Truck', 'Contract Labor', 'Education & Training',
      'Equipment', 'Insurance', 'Legal & Professional', 'Meals', 'Office Supplies', 'Phone & Internet',
      'Rent & Lease', 'Repairs & Maintenance', 'Shipping & Postage', 'Software & Subscriptions', 'Supplies',
      'Taxes & Licenses', 'Travel', 'Utilities', 'Other',
    ],
  },
  {
    id: 'trades',
    name: 'Construction & trades',
    hint: 'Materials, tools, fuel, subs and job costs',
    categories: [
      'Materials', 'Tools & Equipment', 'Equipment Rental', 'Fuel', 'Vehicle Maintenance', 'Subcontractors',
      'Permits & Fees', 'Dump & Disposal', 'Safety Gear', 'Meals', 'Office & Admin', 'Insurance', 'Other',
    ],
  },
  {
    id: 'rental',
    name: 'Rental property',
    hint: 'Based on IRS Schedule E categories',
    categories: [
      'Advertising', 'Auto & Travel', 'Cleaning & Maintenance', 'Commissions', 'Insurance', 'Legal & Professional',
      'Management Fees', 'Mortgage Interest', 'Repairs', 'Supplies', 'Property Taxes', 'Utilities', 'HOA Fees', 'Other',
    ],
  },
  {
    id: 'freelance',
    name: 'Freelancer / creator',
    hint: 'Gear, software, home office and travel',
    categories: [
      'Software & Subscriptions', 'Equipment & Gear', 'Home Office', 'Phone & Internet', 'Education', 'Marketing',
      'Travel', 'Meals', 'Coworking', 'Contractors', 'Bank & Payment Fees', 'Other',
    ],
  },
  {
    id: 'personal',
    name: 'Personal budget',
    hint: 'Everyday household spending',
    categories: [
      'Groceries', 'Dining Out', 'Gas', 'Car', 'Housing', 'Utilities', 'Health', 'Shopping', 'Entertainment',
      'Travel', 'Gifts & Donations', 'Other',
    ],
  },
  { id: 'blank', name: 'Start from scratch', hint: 'Add your own categories', categories: [] },
];

export const DEFAULT_PAYMENT_METHODS = ['Business card', 'Personal card', 'Cash', 'Check', 'Bank transfer'];

export const EXPORT_FORMATS = [
  { id: 'quickbooks', name: 'QuickBooks Online', hint: 'Banking → Upload transactions' },
  { id: 'xero', name: 'Xero', hint: 'Bank account → Import a statement' },
  { id: 'wave', name: 'Wave', hint: 'Transactions → Upload a bank statement' },
  { id: 'csv', name: 'Spreadsheet / my accountant', hint: 'Excel, Google Sheets, Numbers or any other software' },
];

export const DATE_FORMATS = [
  { id: 'MDY', name: 'MM/DD/YYYY', hint: 'United States' },
  { id: 'DMY', name: 'DD/MM/YYYY', hint: 'UK, Canada, Australia, most of the world' },
  { id: 'ISO', name: 'YYYY-MM-DD', hint: 'International standard' },
];

export const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'MXN', 'JPY', 'CHF', 'INR'];

function guessCurrency() {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    const map = { US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', MX: 'MXN', JP: 'JPY', CH: 'CHF', IN: 'INR' };
    if (map[region]) return map[region];
    if (['DE', 'FR', 'ES', 'IT', 'NL', 'IE', 'PT', 'BE', 'AT', 'FI', 'GR'].includes(region)) return 'EUR';
  } catch { /* fall through */ }
  return 'USD';
}

function guessDateFormat() {
  const lang = navigator.language || 'en-US';
  return /^en-US|^en$|-PH$/.test(lang) ? 'MDY' : 'DMY';
}

function defaults() {
  const businessId = uid();
  return {
    schema: 1,
    setupDone: false,
    // "Books": separate sets of expenses (different businesses, or business vs. personal).
    // One unnamed book by default; names and the switcher only appear once there are two.
    businesses: [{ id: businessId, name: '' }],
    activeBusinessId: businessId,
    categoryPreset: 'small-business',
    categories: [...CATEGORY_PRESETS[0].categories],
    paymentMethods: [...DEFAULT_PAYMENT_METHODS],
    currency: guessCurrency(),
    dateFormat: guessDateFormat(),
    exportFormat: 'csv',
    exportFileType: 'xlsx', // for the spreadsheet and custom formats: 'xlsx' or 'csv'
    exportTemplates: [], // custom layouts: { id, name, columns: [{ header, field }] }
    ai: { apiKey: '', model: 'claude-opus-5-5', instructions: '' },
    // Optional voice conversations: OpenAI does the speech-to-text (Claude doesn't take audio).
    // mode: 'keyboard' | 'spoken' (AI voice replies) | 'live' (realtime conversation).
    // askFor: details the voice modes ask about when they weren't mentioned (amount and item are always asked).
    voice: { mode: 'keyboard', openaiKey: '', talkBack: true, pause: 'normal', askFor: ['vendor', 'paymentMethod'], allowInterrupt: false, aiVoice: 'marin' },
    // Google Sheets: the tab and its columns ({ header, field }) once set up.
    // mode 'google': connected with Google sign-in (no script); 'script': the Apps Script method.
    sheets: { mode: 'script', url: '', secret: '', connectedName: '', tab: '', columns: [], google: { refreshToken: '', spreadsheetId: '', folderId: '' } },
    // Excel: the workbook tab and columns used by "Update my Excel file".
    excel: { fileName: '', tab: '', columns: [], lastUpdated: null },
    askNoteAfterScan: false,
  };
}

let current = null;

export async function loadSettings() {
  const saved = await kvGet('settings');
  const base = defaults();
  current = saved
    ? { ...base, ...saved, ai: { ...base.ai, ...saved.ai }, sheets: { ...base.sheets, ...saved.sheets, google: { ...base.sheets.google, ...saved.sheets?.google } }, excel: { ...base.excel, ...saved.excel }, voice: { ...base.voice, ...saved.voice } }
    : base;
  if (!current.businesses.length) current.businesses = base.businesses;
  // Before voice modes existed, having an OpenAI key meant spoken conversations.
  if (saved?.voice?.openaiKey && !saved.voice.mode) current.voice.mode = 'spoken';
  if (!current.businesses.some((b) => b.id === current.activeBusinessId)) current.activeBusinessId = current.businesses[0].id;
  return current;
}

export function settings() {
  return current;
}

// Accepts either a partial object or a function that mutates a draft copy.
export async function updateSettings(change) {
  const draft = structuredClone(current);
  if (typeof change === 'function') change(draft);
  else Object.assign(draft, change);
  current = draft;
  await kvSet('settings', current);
  emit('settings-changed', current);
  return current;
}

export async function replaceSettings(next) {
  current = next;
  await kvSet('settings', current);
  emit('settings-changed', current);
}

export function businessName(id) {
  const book = current.businesses.find((b) => b.id === id);
  return book ? book.name || 'Main books' : 'Unknown books';
}

// Built-in formats plus the user's own layouts (ids prefixed "tpl:").
export function allExportFormats() {
  return [
    ...EXPORT_FORMATS,
    ...current.exportTemplates.map((t) => ({ id: `tpl:${t.id}`, name: t.name, hint: `Your layout · ${t.columns.length} columns`, template: t })),
  ];
}

export function exportFormatName(id) {
  return allExportFormats().find((f) => f.id === id)?.name || 'Spreadsheet';
}

export function hasMultipleBusinesses() {
  return current.businesses.length > 1;
}
