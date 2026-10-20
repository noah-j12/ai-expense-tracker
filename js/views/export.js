import { listEntries, markExported, needsAttention } from '../entries.js';
import { deliverFiles, exportFile, receiptFiles } from '../exporter.js';
import { EXPORT_FORMATS, businessName, hasMultipleBusinesses, settings } from '../settings.js';
import { choiceList, field, toast, toggleRow, topbar } from '../ui.js';
import { formatDate, formatMoney, fill, h, icon, on, toISODate } from '../util.js';

const IMPORT_HELP = {
  quickbooks: 'In QuickBooks Online go to Transactions > Bank transactions > Upload transactions, choose this file, then pick the account you paid from. Amounts are negative because they\'re money going out.',
  xero: 'In Xero open the bank or card account you paid from, choose Import a statement, and upload this file. Amounts are negative because they\'re money going out.',
  wave: 'In Wave go to Transactions > More > Upload a bank statement, pick the account you paid from, and upload this file.',
  csv: 'Opens in Excel, Google Sheets or Numbers, and most accounting software and accountants can import it.',
};

function ranges() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const iso = (d) => toISODate(d);
  return [
    { id: 'this-month', name: 'This month', from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    { id: 'last-month', name: 'Last month', from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    { id: 'this-quarter', name: 'This quarter', from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: iso(new Date(y, Math.floor(m / 3) * 3 + 3, 0)) },
    { id: 'this-year', name: 'This year', from: `${y}-01-01`, to: `${y}-12-31` },
    { id: 'last-year', name: 'Last year', from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
    { id: 'all', name: 'All time', from: '0000-01-01', to: '9999-12-31' },
    { id: 'custom', name: 'Custom dates' },
  ];
}

export function ExportView() {
  const s = settings();
  const el = h('div', { class: 'page' });
  const state = {
    range: 'this-month',
    from: toISODate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
    to: toISODate(),
    business: 'all',
    onlyNew: false,
    format: s.exportFormat,
  };
  let entries = [];
  const summary = h('div');
  const customWrap = h('div', { class: 'grid-2', hidden: true });

  const fromInput = h('input', { class: 'input', type: 'date', value: state.from });
  const toInput = h('input', { class: 'input', type: 'date', value: state.to });
  fromInput.addEventListener('change', () => { state.from = fromInput.value; renderSummary(); });
  toInput.addEventListener('change', () => { state.to = toInput.value; renderSummary(); });
  customWrap.append(field('From', fromInput), field('To', toInput));

  const rangeSelect = h('select', { class: 'select' }, ranges().map((r) => h('option', { value: r.id }, r.name)));
  rangeSelect.addEventListener('change', () => {
    state.range = rangeSelect.value;
    customWrap.hidden = state.range !== 'custom';
    renderSummary();
  });

  const businessSelect = hasMultipleBusinesses()
    ? h('select', { class: 'select' }, h('option', { value: 'all' }, 'All businesses'), s.businesses.map((b) => h('option', { value: b.id }, b.name)))
    : null;
  businessSelect?.addEventListener('change', () => { state.business = businessSelect.value; renderSummary(); });

  const help = h('p', { class: 'small muted' });

  function selected() {
    const r = ranges().find((x) => x.id === state.range);
    const from = state.range === 'custom' ? state.from : r.from;
    const to = state.range === 'custom' ? state.to : r.to;
    return entries.filter((e) => (e.aiStatus === 'done' || e.aiStatus === 'skipped')
      && e.fields.date >= from && e.fields.date <= to
      && (state.business === 'all' || e.businessId === state.business)
      && (!state.onlyNew || !e.exportedAt));
  }

  function rangeLabel() {
    if (state.range === 'custom') return `${state.from} to ${state.to}`;
    if (state.range === 'all') return 'all time';
    const r = ranges().find((x) => x.id === state.range);
    const base = `${r.from} to ${r.to}`;
    return state.business !== 'all' ? `${businessName(state.business)} ${base}` : base;
  }

  function renderSummary() {
    const list = selected();
    const total = list.filter((e) => e.fields.currency === s.currency).reduce((sum, e) => sum + (Number(e.fields.total) || 0), 0);
    const review = list.filter(needsAttention).length;
    const waiting = entries.filter((e) => e.aiStatus === 'queued' || e.aiStatus === 'processing').length;
    const photos = new Set(list.map((e) => e.fileId).filter(Boolean)).size;
    help.textContent = IMPORT_HELP[state.format] || '';

    fill(summary, 
      h('div', { class: 'card pad' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'small muted' }, `${list.length} expense${list.length === 1 ? '' : 's'}`), h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 700 } }, formatMoney(total, s.currency))),
          list.length ? h('div', { class: 'small muted', style: { textAlign: 'right' } }, `${formatDate(list[list.length - 1].fields.date)} –`, h('br'), formatDate(list[0].fields.date)) : null),
      ),
      review ? h('div', { class: 'banner warn', style: { marginTop: '12px' } }, icon('alert'), h('div', { class: 'body' }, `${review} of these still need${review === 1 ? 's' : ''} a quick review. They're included as-is.`)) : null,
      waiting ? h('div', { class: 'banner', style: { marginTop: '12px' } }, icon('clock'), h('div', { class: 'body' }, `${waiting} entr${waiting === 1 ? 'y is' : 'ies are'} still waiting to be read and won't be included yet.`)) : null,
      h('div', { class: 'stack', style: { marginTop: '16px' } },
        h('button', { class: 'btn primary', disabled: !list.length, onclick: async () => {
          const file = exportFile(list, state.format, rangeLabel());
          const ok = await deliverFiles([file], file.name);
          if (ok) {
            await markExported(list.map((e) => e.id));
            toast('Exported');
          }
        } }, icon('download'), `Export ${EXPORT_FORMATS.find((f) => f.id === state.format)?.name || ''} file`),
        h('button', { class: 'btn', disabled: !photos, onclick: async () => {
          const files = await receiptFiles(list);
          await deliverFiles(files, 'Receipts');
        } }, icon('share'), photos ? `Share ${photos} receipt photo${photos === 1 ? '' : 's'}` : 'No receipt photos in this range'),
      ),
    );
  }

  el.append(
    topbar({ title: 'Export', back: () => { location.hash = '#/'; } }),
    h('div', { class: 'stack' },
      field('Dates', rangeSelect),
      customWrap,
      businessSelect ? field('Business', businessSelect) : null,
      h('div', { class: 'list' }, toggleRow({ label: 'Only expenses not exported yet', hint: 'Avoids importing the same expense twice.', checked: false, onChange: (v) => { state.onlyNew = v; renderSummary(); } })),
      h('div', { class: 'section-title', style: { marginTop: '8px' } }, 'Format'),
      choiceList({ options: EXPORT_FORMATS, value: state.format, onChange: (id) => { state.format = id; renderSummary(); } }),
      help,
      summary,
    ),
  );

  const load = async () => { entries = await listEntries(); renderSummary(); };
  load();
  const off = on('entries-changed', load);
  return { el, destroy: off };
}
