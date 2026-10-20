// Export formats: the built-in ones plus custom layouts copied from the user's own spreadsheet.

import { cleanLayout, columnMapper, learnedFromRows, offerLearnedLists, suggestMapping } from '../mapper.js';
import { EXPORT_FORMATS, settings, updateSettings } from '../settings.js';
import { readTableFile, tableFromText } from '../tabular.js';
import { choiceSheet, confirmSheet, field, toast, topbar } from '../ui.js';
import { fill, h, icon, uid } from '../util.js';
import { goBack, withRefresh } from './settings.js';

export function FormatsView({ id, query }) {
  return id ? editor(id === 'new' ? null : id, query) : list();
}

function list() {
  const el = h('div', { class: 'page' });
  return withRefresh(el, () => {
    const s = settings();
    return [
      topbar({ title: 'Export formats', back: () => goBack() }),
      h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, 'Have a spreadsheet layout you already use? Make a custom format from it, and exports come out with exactly those columns, as an Excel or CSV file.'),
      h('div', { class: 'section-title' }, 'Your formats'),
      s.exportTemplates.length
        ? h('div', { class: 'list' }, s.exportTemplates.map((t) => h('button', { class: 'list-item', onclick: () => { location.hash = `#/settings/formats/${t.id}`; } },
          icon('sheet'), h('div', { class: 'grow' }, h('div', null, t.name), h('div', { class: 'tiny muted' }, t.columns.map((c) => c.header).join(', '))),
          h('span', { class: 'chev' }, icon('chevron')))))
        : h('div', { class: 'card pad small muted' }, 'None yet.'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary block', onclick: () => { location.hash = '#/settings/formats/new'; } }, icon('plus'), 'Create a custom format'),
      h('div', { class: 'section-title' }, 'Built in'),
      h('div', { class: 'list' }, EXPORT_FORMATS.map((f) => h('div', { class: 'list-item' }, icon('file'), h('div', { class: 'grow' }, h('div', null, f.name), h('div', { class: 'tiny muted' }, f.hint))))),
    ];
  });
}

function editor(templateId, query) {
  const el = h('div', { class: 'page' });
  const existing = templateId ? settings().exportTemplates.find((t) => t.id === templateId) : null;
  const state = existing
    ? { step: 'map', name: existing.name, headers: existing.columns.map((c) => c.header), rows: [], mapping: existing.columns.map((c) => c.field), fromFile: false }
    : { step: 'source', name: '', headers: [], rows: [], mapping: [], fromFile: false, busy: '' };
  const from = query?.get('from');
  const finishTo = from === 'export' ? '#/export' : from === 'setup' ? '#/' : '#/settings/formats';

  async function useTable({ headers, rows }, nameHint, fromFile) {
    const clean = cleanLayout(headers, rows);
    if (!clean.headers.length) {
      toast('No column names were found. The first row should have the column names.', { error: true });
      return;
    }
    state.headers = clean.headers;
    state.rows = clean.rows;
    state.fromFile = fromFile;
    if (!state.name) state.name = nameHint || 'My format';
    state.busy = 'Matching your columns…';
    render();
    state.mapping = await suggestMapping(state.headers, state.rows);
    state.busy = '';
    state.step = 'map';
    render();
  }

  async function onFile(file) {
    if (!file) return;
    state.busy = 'Reading your file…';
    render();
    try {
      let table = await readTableFile(file);
      if (table.tabs?.length > 1) {
        state.busy = '';
        render();
        const tab = await choiceSheet({ title: 'Which tab has your columns?', options: table.tabs.map((t) => ({ label: t, value: t, icon: 'sheet' })) });
        if (!tab) return;
        table = await readTableFile(file, { tab });
      }
      await useTable(table, file.name.replace(/\.[^.]+$/, ''), true);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      if (state.busy) { state.busy = ''; render(); }
    }
  }

  function sourceStep() {
    const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true });
    fileInput.addEventListener('change', () => onFile(fileInput.files?.[0]));
    const paste = h('textarea', { class: 'textarea', rows: 4, placeholder: 'e.g. Date, Payee, Expense Type, Amount, Job #' });
    return [
      topbar({ title: 'New export format', back: () => goBack('#/settings/formats') }),
      h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Show the app the spreadsheet you already use. It copies the column layout, and can reuse the categories already in it.'),
        h('button', { class: 'btn primary', onclick: () => fileInput.click() }, icon('file'), 'Choose a file (Excel or CSV)'),
        fileInput,
        h('div', { class: 'section-title', style: { margin: '12px 4px 0' } }, 'Or paste your column names'),
        paste,
        h('p', { class: 'hint' }, 'Copy the header row from Excel or Google Sheets and paste it here, or type the names separated by commas.'),
        h('button', { class: 'btn', onclick: () => useTable(tableFromText(paste.value), '', false) }, 'Use these columns'),
      ),
    ];
  }

  function mapStep() {
    const nameInput = h('input', { class: 'input', value: state.name, placeholder: 'e.g. My expense log', autocapitalize: 'words' });
    nameInput.addEventListener('input', () => { state.name = nameInput.value; });
    const save = async () => {
      const name = state.name.trim() || 'My format';
      const columns = state.headers.map((header, i) => ({ header, field: state.mapping[i] || '' }));
      if (!columns.some((c) => c.field)) {
        toast('Match at least one column first.', { error: true });
        return;
      }
      if (state.fromFile) await offerLearnedLists(learnedFromRows(state.headers, state.rows, state.mapping), 'spreadsheet');
      const id = existing?.id || uid();
      await updateSettings((d) => {
        const t = { id, name, columns };
        const i = d.exportTemplates.findIndex((x) => x.id === id);
        if (i >= 0) d.exportTemplates[i] = t;
        else d.exportTemplates.push(t);
        if (from === 'setup' || from === 'export' || !existing) d.exportFormat = `tpl:${id}`;
      });
      toast(existing ? 'Format saved' : `"${name}" is ready to use`);
      location.hash = finishTo;
    };
    return [
      topbar({ title: existing ? 'Edit format' : 'Match your columns', back: () => (existing ? goBack('#/settings/formats') : (state.step = 'source', render())) }),
      h('div', { class: 'stack' },
        field('Format name', nameInput),
        h('p', { class: 'small muted' }, 'Columns set to "Leave blank" stay in the file, empty, so the layout matches yours exactly.'),
        columnMapper({ headers: state.headers, samples: state.rows, mapping: state.mapping }),
        h('button', { class: 'btn primary block', onclick: save }, 'Save format'),
        existing ? h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmSheet({ title: `Delete "${existing.name}"?`, confirmText: 'Delete', danger: true }))) return;
          await updateSettings((d) => {
            d.exportTemplates = d.exportTemplates.filter((x) => x.id !== existing.id);
            if (d.exportFormat === `tpl:${existing.id}`) d.exportFormat = 'csv';
          });
          location.hash = '#/settings/formats';
        } }, icon('trash'), 'Delete format') : null,
      ),
    ];
  }

  function render() {
    if (state.busy) return fill(el, topbar({ title: 'Export format', back: () => goBack('#/settings/formats') }), h('div', { class: 'card processing' }, h('span', { class: 'spinner' }), h('div', null, state.busy)));
    return fill(el, ...(state.step === 'map' ? mapStep() : sourceStep()));
  }

  render();
  return { el };
}
