// Column matching UI shared by Google Sheets, Excel and custom export formats,
// plus the offer to reuse category / payment method names found in the user's existing rows.

import { suggestColumnMapping } from './ai.js';
import { FIELDS, ID_HEADER, autoMap } from './fields.js';
import { settings, updateSettings } from './settings.js';
import { choiceSheet } from './ui.js';
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

const USEFUL = ['date', 'vendor', 'total', 'category', 'paymentMethod', 'notes', 'receipt', 'description'];
const DEFAULT_HEADERS = { date: 'Date', vendor: 'Vendor', total: 'Amount', category: 'Category', paymentMethod: 'Payment Method', notes: 'Notes', receipt: 'Receipt', description: 'Description' };

// Toggles for adding columns the user's sheet doesn't have yet. Returns { el, selected() }.
export function extraColumnsPicker(mapping, { allowReceipt = true } = {}) {
  const chosen = new Set();
  const wrap = h('div', { class: 'tags' });
  const render = () => {
    const missing = USEFUL.filter((k) => !mapping.includes(k) && (allowReceipt || k !== 'receipt'));
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
    selected: () => [...chosen].filter((k) => !mapping.includes(k)).map((k) => ({ header: DEFAULT_HEADERS[k], field: k })),
  };
}

// found: { categories: [...], paymentMethods: [...] } taken from the user's existing rows.
export async function offerLearnedLists(found, sourceNoun = 'sheet') {
  const kinds = [
    ['categories', 'categories', 'category'],
    ['paymentMethods', 'payment methods', 'payment method'],
  ];
  for (const [key, plural, singular] of kinds) {
    const values = [...new Set((found[key] || []).map((v) => String(v).trim()).filter((v) => v && v.length <= 60 && !/^-?[\d.,$]+$/.test(v)))].slice(0, 100);
    const have = new Set(settings()[key].map((x) => x.toLowerCase()));
    const fresh = values.filter((v) => !have.has(v.toLowerCase()));
    if (!fresh.length) continue;
    const preview = values.slice(0, 6).join(', ') + (values.length > 6 ? `, +${values.length - 6} more` : '');
    const pick = await choiceSheet({
      title: `Your ${sourceNoun} already uses ${values.length} ${values.length === 1 ? singular : plural}`,
      options: [
        { label: `Use these ${plural}`, hint: preview, value: 'replace', icon: 'check' },
        { label: `Add the ${fresh.length} new one${fresh.length === 1 ? '' : 's'} to my list`, value: 'add', icon: 'plus' },
        { label: 'Keep my list as it is', value: 'keep', icon: 'x' },
      ],
    });
    if (pick === 'replace') await updateSettings((d) => { d[key] = values; });
    else if (pick === 'add') await updateSettings((d) => { d[key] = [...d[key], ...fresh]; });
  }
}

// Distinct values of the columns mapped to category / payment method, from rows already in hand.
export function learnedFromRows(headers, rows, mapping) {
  const col = (field) => mapping.indexOf(field);
  const pick = (i) => (i < 0 ? [] : rows.map((r) => (r || [])[i]).filter((v) => String(v ?? '').trim()));
  return { categories: pick(col('category')), paymentMethods: pick(col('paymentMethod')) };
}
