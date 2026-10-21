// Column matching UI shared by Google Sheets, Excel and custom export formats,
// automatic setup (pick the tab, match and add columns), and reuse of names found in the user's existing rows.

import { suggestColumnMapping } from './ai.js';
import { FIELDS, ID_HEADER, autoMap } from './fields.js';
import { settings, updateSettings } from './settings.js';
import { fill, h, icon } from './util.js';

// Removes blanks, the hidden ID column and duplicate names; keeps samples aligned.
export function cleanLayout(headers, rows = []) {
  const keep = [];
  const seen = new Set();
  headers.forEach((hd, i) => {
    const name = String(hd ?? '').trim();
    if (!name || name === ID_HEADER || seen.has(name)) return;
    seen.add(name);
    keep.push(i);
  });
  return {
    headers: keep.map((i) => String(headers[i]).trim()),
    rows: rows.map((r) => keep.map((i) => (r || [])[i] ?? '')),
  };
}

// Rule-based guesses straight away, then the AI's suggestions if it's connected.
export async function suggestMapping(headers, samples) {
  const quick = autoMap(headers, samples);
  const ai = await suggestColumnMapping(headers, samples.slice(0, 5));
  if (!ai) return quick;
  // Trust the AI, but keep a rule match where the AI left a column blank and nobody else uses that field.
  return ai.map((key, i) => key || (quick[i] && !ai.includes(quick[i]) ? quick[i] : ''));
}

export function columnMapper({ headers, samples = [], mapping, onChange }) {
  const wrap = h('div', { class: 'list' });
  const render = () => fill(wrap, headers.map((header, i) => {
    const sample = samples.map((r) => r[i]).find((v) => String(v ?? '').trim());
    const select = h('select', { class: 'select', 'aria-label': `What goes in ${header}` },
      h('option', { value: '' }, 'Leave blank'),
      FIELDS.map((f) => h('option', { value: f.key }, f.label)));
    select.value = mapping[i] || '';
    select.addEventListener('change', () => {
      mapping[i] = select.value;
      onChange?.(mapping);
    });
    return h('div', { class: 'map-row' },
      h('div', { class: 'map-head' }, h('b', null, header), sample ? h('div', { class: 'tiny muted' }, `e.g. ${String(sample).slice(0, 40)}`) : null),
      h('span', { class: 'chev' }, icon('back', 'icon flip')),
      select);
  }));
  render();
  wrap.update = (next) => { mapping = next; render(); };
  return wrap;
}

const USEFUL = ['date', 'vendor', 'description', 'category', 'total', 'paymentMethod', 'notes', 'receipt'];
const DEFAULT_HEADERS = { date: 'Date', vendor: 'Vendor', total: 'Amount', category: 'Category', paymentMethod: 'Payment Method', notes: 'Notes', receipt: 'Receipt', description: 'Description' };

// Details already covered by the matched columns (an "amount as negative" column covers the amount;
// a "vendor + what it was for" column covers both).
function covered(mapping) {
  const set = new Set(mapping.filter(Boolean));
  if (set.has('totalNegative')) set.add('total');
  if (set.has('vendorDescription')) { set.add('vendor'); set.add('description'); }
  return set;
}

function missingFields(mapping, allowReceipt) {
  const have = covered(mapping);
  return USEFUL.filter((k) => !have.has(k) && (allowReceipt || k !== 'receipt'));
}

// Toggles for adding columns the user's sheet doesn't have yet. Everything important that's missing
// starts ticked, so the sheet gets what it needs without the user having to pick. Returns { el, selected() }.
export function extraColumnsPicker(mapping, { allowReceipt = true } = {}) {
  const chosen = new Set(missingFields(mapping, allowReceipt));
  const wrap = h('div', { class: 'tags' });
  const render = () => {
    const missing = missingFields(mapping, allowReceipt);
    fill(wrap, missing.map((k) => h('button', {
      class: 'tag' + (chosen.has(k) ? ' on' : ''),
      style: { paddingRight: '12px' },
      onclick: () => { chosen.has(k) ? chosen.delete(k) : chosen.add(k); render(); },
    }, chosen.has(k) ? icon('check') : icon('plus'), FIELDS.find((f) => f.key === k).label)));
    if (!missing.length) fill(wrap, h('span', { class: 'small muted' }, 'Your columns already cover everything important.'));
  };
  render();
  return {
    el: wrap,
    refresh: render,
    selected: () => missingFields(mapping, allowReceipt).filter((k) => chosen.has(k)).map((k) => ({ header: DEFAULT_HEADERS[k], field: k })),
  };
}

// ---------- Fully automatic setup ----------

// Picks the tab that looks most like an expense log.
// Returns { tab, empty } or { ambiguous: true } when two tabs look equally likely.
export function pickTab(tabs) {
  const scored = tabs.map((t) => {
    const { headers, rows } = cleanLayout(t.headers || [], t.sample || t.rows || []);
    return { t, empty: !headers.length, score: autoMap(headers, rows).filter(Boolean).length };
  });
  const filled = scored.filter((x) => !x.empty).sort((a, b) => b.score - a.score);
  const firstEmpty = scored.find((x) => x.empty);
  if (!filled.length) return { tab: (firstEmpty || scored[0]).t, empty: true };
  const [best, next] = filled;
  // A tab that doesn't look like expenses at all: use an empty tab if there is one.
  if (best.score < 2 && firstEmpty) return { tab: firstEmpty.t, empty: true };
  if (next && next.score === best.score && best.score >= 2) return { ambiguous: true };
  return { tab: best.t, empty: false };
}

// Works out the whole layout for a tab: which existing column gets what (AI, or rules without a key),
// and which important columns to add. Returns { headers, rows, columns, matched, added }.
export async function planLayout(tab, { allowReceipt = true } = {}) {
  const { headers, rows } = cleanLayout(tab.headers || [], tab.sample || tab.rows || []);
  if (!headers.length) {
    const added = USEFUL.filter((k) => allowReceipt || k !== 'receipt').map((k) => ({ header: DEFAULT_HEADERS[k], field: k }));
    return { headers, rows, columns: added, matched: [], added, mapping: [] };
  }
  const mapping = await suggestMapping(headers, rows);
  const added = missingFields(mapping, allowReceipt)
    .map((k) => ({ header: DEFAULT_HEADERS[k], field: k }))
    .filter((c) => !headers.includes(c.header)); // a same-named column is already there, unmatched on purpose
  const columns = [...headers.map((header, i) => ({ header, field: mapping[i] || '' })), ...added];
  return { headers, rows, mapping, columns, matched: columns.filter((c) => c.field && !added.includes(c)), added };
}

function cleanValues(list) {
  return [...new Set((list || []).map((v) => String(v).trim()).filter((v) => v && v.length <= 60 && !/^-?[\d.,$]+$/.test(v)))].slice(0, 100);
}

// Uses the category / payment-method names already in the user's data, with no questions:
// a sheet with its own real category list (3+) replaces the starter list; otherwise new names are added.
// Returns a short description of what changed, or ''.
export async function mergeLearnedLists(found) {
  const notes = [];
  const cats = cleanValues(found.categories);
  const pays = cleanValues(found.paymentMethods);
  await updateSettings((d) => {
    if (cats.length >= 3) {
      const before = d.categories.join('|');
      d.categories = cats;
      if (before !== cats.join('|')) notes.push(`using your sheet's ${cats.length} categories`);
    } else if (cats.length) {
      const have = new Set(d.categories.map((x) => x.toLowerCase()));
      const fresh = cats.filter((v) => !have.has(v.toLowerCase()));
      if (fresh.length) { d.categories = [...d.categories, ...fresh]; notes.push(`added ${fresh.length} categor${fresh.length === 1 ? 'y' : 'ies'} from your sheet`); }
    }
    const have = new Set(d.paymentMethods.map((x) => x.toLowerCase()));
    const fresh = pays.filter((v) => !have.has(v.toLowerCase()));
    if (fresh.length) { d.paymentMethods = [...d.paymentMethods, ...fresh]; notes.push(`added ${fresh.length} payment method${fresh.length === 1 ? '' : 's'} from your sheet`); }
  });
  return notes.join('; ');
}

// Distinct values of the columns mapped to category / payment method, from rows already in hand.
export function learnedFromRows(headers, rows, mapping) {
  const col = (field) => mapping.indexOf(field);
  const pick = (i) => (i < 0 ? [] : rows.map((r) => (r || [])[i]).filter((v) => String(v ?? '').trim()));
  return { categories: pick(col('category')), paymentMethods: pick(col('paymentMethod')) };
}
