// Excel: keep expenses in the user's own workbook. iPhones don't let web apps write to a file in
// place, so each update is: pick the workbook, the app adds/updates rows, then save it back over the original.

import { listEntries, markExcelSynced } from '../entries.js';
import { deliverFiles, inspectWorkbook, typeOfField, updateExcelWorkbook } from '../exporter.js';
import { ID_HEADER, fieldLabel } from '../fields.js';
import { cleanLayout, columnMapper, extraColumnsPicker, learnedFromRows, mergeLearnedLists, pickTab, planLayout, suggestMapping } from '../mapper.js';
import { settings, updateSettings } from '../settings.js';
import { defaultSheetColumns, sheetsConnected } from '../sheets.js';
import { confirmSheet, toast, topbar } from '../ui.js';
import { fill, formatDateTime, h, icon } from '../util.js';
import { buildWorkbook } from '../xlsx.js';
import { goBack } from './settings.js';

function pickWorkbook() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true });
    input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

function defaultExcelColumns() {
  // Receipt links only exist when Google Sheets/Drive is connected.
  return defaultSheetColumns().filter((c) => c.field !== 'receipt' || sheetsConnected());
}

// Shared by the Excel settings page and the Export screen.
export function excelSaveSteps() {
  return h('ol', { class: 'steps' },
    h('li', null, h('div', null, 'Tap ', h('b', null, 'Save file'), ' below.')),
    h('li', null, h('div', null, 'Choose ', h('b', null, 'Save to Files'), ', open the folder the workbook came from, and tap ', h('b', null, 'Save'), '.')),
    h('li', null, h('div', null, 'When asked, tap ', h('b', null, 'Replace'), '.')));
}

export function ExcelSettings() {
  const el = h('div', { class: 'page' });
  // step: null (overview) | 'tabs' | 'map' | 'save'
  const flow = { step: null, file: null, tabs: [], tab: '', headers: [], rows: [], mapping: [], result: null, busy: '' };
  const title = 'Excel file';

  const spinner = (text) => h('div', { class: 'card processing' }, h('span', { class: 'spinner' }), h('div', null, text));
  const back = (step) => () => { flow.step = step; render(); };

  // auto: read the workbook and set everything up (tab, columns, lists) with no questions,
  // unless two tabs look equally likely. Otherwise show the tab list.
  async function startWithFile(file, { auto = true } = {}) {
    if (!file) return;
    flow.busy = 'Opening your workbook…';
    render();
    try {
      flow.file = file;
      flow.tabs = await inspectWorkbook(file);
      flow.note = '';
      flow.step = 'tabs';
      if (auto) {
        const choice = pickTab(flow.tabs);
        if (choice.ambiguous) {
          flow.note = 'More than one tab looks like an expense log. Which one should expenses go into?';
        } else {
          flow.busy = 'Matching your columns…';
          render();
          const plan = await planLayout(choice.tab, { allowReceipt: sheetsConnected() });
          flow.tab = choice.tab.name;
          flow.headers = plan.headers;
          flow.rows = plan.rows;
          flow.mapping = plan.mapping;
          flow.summary = { tab: choice.tab.name, matched: plan.matched, added: plan.added, empty: choice.empty };
          flow.busy = '';
          await saveLayout(plan.columns.map((c) => (plan.added.includes(c) ? { ...c, add: true } : c)));
          return;
        }
      }
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      flow.busy = '';
      render();
    }
  }

  async function startNewWorkbook() {
    const columns = defaultExcelColumns();
    const blob = buildWorkbook({ sheetName: 'Expenses', columns: columns.map((c) => ({ header: c.header, type: typeOfField(c.field) })), rows: [], dateFormat: settings().dateFormat });
    await updateSettings((d) => { d.excel = { fileName: 'Expenses.xlsx', tab: 'Expenses', columns, lastUpdated: null }; });
    await runUpdate(new File([blob], 'Expenses.xlsx', { type: blob.type }));
  }

  async function chooseTab(tab) {
    flow.tab = tab.name;
    if (!tab.headers.some((x) => x && x !== ID_HEADER)) {
      // Empty tab: use the app's standard columns.
      await saveLayout(defaultExcelColumns().map((c) => ({ ...c, add: true })));
      return;
    }
    const { headers, rows } = cleanLayout(tab.headers, tab.rows);
    flow.headers = headers;
    flow.rows = rows;
    flow.busy = 'Matching your columns…';
    render();
    const saved = settings().excel;
    flow.mapping = saved.tab === tab.name && saved.columns.length
      ? headers.map((hd) => saved.columns.find((c) => c.header === hd)?.field || '')
      : await suggestMapping(headers, rows);
    flow.busy = '';
    flow.step = 'map';
    render();
  }

  async function saveLayout(columns) {
    flow.learned = await mergeLearnedLists(learnedFromRows(flow.headers, flow.rows, flow.mapping));
    await updateSettings((d) => { d.excel = { fileName: flow.file?.name || d.excel.fileName, tab: flow.tab, columns, lastUpdated: d.excel.lastUpdated }; });
    if (flow.file) await runUpdate(flow.file);
  }

  async function runUpdate(file) {
    flow.busy = 'Adding your expenses…';
    render();
    try {
      const result = await updateExcelWorkbook(file, await listEntries());
      flow.result = result;
      flow.step = 'save';
    } catch (err) {
      toast(err.message, { error: true });
      flow.step = null;
    } finally {
      flow.busy = '';
      render();
    }
  }

  async function saveFile() {
    const r = flow.result;
    const ok = await deliverFiles([r.file], r.file.name);
    if (!ok) return;
    await markExcelSynced(r.ids);
    await updateSettings((d) => { d.excel.lastUpdated = Date.now(); d.excel.fileName = r.file.name; });
    flow.step = null;
    flow.result = null;
    toast('Excel file updated');
    render();
  }

  function overview() {
    const s = settings();
    if (!s.excel.tab) {
      return [
        topbar({ title, back: () => goBack() }),
        h('div', { class: 'stack' },
          h('p', { class: 'muted' }, 'Keep your expenses in your own Excel workbook, on OneDrive, iCloud Drive or this phone. The app adds new expenses below your existing rows in your columns and formatting, and updates ones you edit.'),
          h('div', { class: 'card pad stack' },
            h('b', null, 'How updating works'),
            h('p', { class: 'small muted' }, 'Whenever you like, tap "Update my Excel file", pick the workbook, then save it back over the original. iPhones don\'t let apps change your files without you choosing them, so this takes a couple of taps.')),
          h('button', { class: 'btn primary', onclick: async () => startWithFile(await pickWorkbook()) }, icon('file'), 'Choose my Excel file'),
          h('button', { class: 'btn', onclick: startNewWorkbook }, icon('plus'), 'I don\'t have one. Start a new workbook'),
          h('p', { class: 'tiny muted' }, 'Using OneDrive? Install the OneDrive app and it shows up in the file picker under Browse.'),
        ),
      ];
    }
    const mapped = s.excel.columns.filter((c) => c.field);
    return [
      topbar({ title, back: () => goBack() }),
      h('div', { class: 'banner ok' }, icon('check'), h('div', { class: 'body' },
        h('b', null, s.excel.fileName || 'Your workbook'),
        h('div', null, `Expenses go into the "${s.excel.tab}" tab.${s.excel.lastUpdated ? ` Last updated ${formatDateTime(s.excel.lastUpdated)}.` : ''}`))),
      h('button', { class: 'btn primary block', onclick: async () => { const f = await pickWorkbook(); if (f) runUpdate(f); } }, icon('refresh'), 'Update my Excel file'),
      h('div', { class: 'section-title' }, 'Columns'),
      h('div', { class: 'list' }, mapped.map((c) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('b', null, c.header)), h('span', { class: 'value small' }, fieldLabel(c.field))))),
      h('div', { class: 'stack', style: { marginTop: '16px' } },
        h('button', { class: 'btn', onclick: async () => {
          const f = await pickWorkbook();
          if (!f) return;
          await startWithFile(f, { auto: false });
          const tab = flow.tabs.find((t) => t.name === settings().excel.tab);
          if (tab) await chooseTab(tab);
        } }, icon('pen'), 'Change columns'),
        h('button', { class: 'btn', onclick: async () => startWithFile(await pickWorkbook(), { auto: false }) }, icon('file'), 'Use a different file or tab'),
        h('p', { class: 'tiny muted' }, 'Expenses you delete in the app aren\'t removed from the workbook; delete those rows in Excel.'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmSheet({ title: 'Stop using an Excel file?', message: 'Your workbook keeps everything already in it.', confirmText: 'Turn off', danger: true }))) return;
          await updateSettings((d) => { d.excel = { fileName: '', tab: '', columns: [], lastUpdated: null }; });
          render();
        } }, 'Turn off'),
      ),
    ];
  }

  function tabsStep() {
    const names = new Set(flow.tabs.map((t) => t.name));
    let newName = 'Expenses';
    for (let i = 2; names.has(newName); i++) newName = `Expenses ${i}`;
    return [
      topbar({ title: 'Pick a tab', back: back(null) }),
      h('p', { class: 'muted', style: { margin: '0 4px 12px' } }, flow.note || `Which tab in "${flow.file?.name}" should expenses go into?`),
      h('div', { class: 'list' },
        flow.tabs.map((t) => {
          const cols = t.headers.filter((x) => x && x !== ID_HEADER).length;
          return h('button', { class: 'list-item', onclick: () => chooseTab(t) }, icon('sheet'),
            h('div', { class: 'grow' }, h('div', null, t.name), h('div', { class: 'tiny muted' }, cols ? `${cols} columns · ${t.rows.length} row${t.rows.length === 1 ? '' : 's'}` : 'Empty tab')),
            h('span', { class: 'chev' }, icon('chevron')));
        }),
        h('button', { class: 'list-item', onclick: () => chooseTab({ name: newName, headers: [], rows: [] }) }, icon('plus'),
          h('div', { class: 'grow' }, h('div', null, `New tab called "${newName}"`), h('div', { class: 'tiny muted' }, 'With the app\'s standard columns')),
          h('span', { class: 'chev' }, icon('chevron'))),
      ),
    ];
  }

  function mapStep() {
    const extras = extraColumnsPicker(flow.mapping, { allowReceipt: sheetsConnected() });
    return [
      topbar({ title: 'Match your columns', back: back('tabs') }),
      h('p', { class: 'muted', style: { margin: '0 4px 12px' } }, `Your columns in "${flow.tab}" are matched below, and any it's missing are added for you. Check it over and tap Save. Columns set to "Leave blank" are never touched.`),
      columnMapper({ headers: flow.headers, samples: flow.rows, mapping: flow.mapping, onChange: () => extras.refresh() }),
      h('div', { class: 'section-title' }, 'Columns that will be added (tap to skip any)'),
      extras.el,
      h('button', { class: 'btn primary block', style: { marginTop: '20px' }, onclick: () => saveLayout([
        ...flow.headers.map((header, i) => ({ header, field: flow.mapping[i] || '' })),
        ...extras.selected().map((c) => ({ ...c, add: true })),
      ]) }, 'Save & update the file'),
    ];
  }

  function saveStep() {
    const r = flow.result;
    const parts = [];
    if (r.added) parts.push(`${r.added} new expense${r.added === 1 ? '' : 's'} added`);
    if (r.updated) parts.push(`${r.updated} updated`);
    return [
      topbar({ title: 'Save your workbook', back: back(null) }),
      h('div', { class: 'banner ok' }, icon('check'), h('div', { class: 'body' }, h('b', null, parts.length ? parts.join(', ') + '.' : 'Your workbook is already up to date.'),
        h('div', null, `In the "${settings().excel.tab}" tab of ${r.file.name}.`))),
      flow.summary ? h('div', { class: 'card pad stack', style: { marginTop: '12px' } },
        h('b', null, 'Set up automatically'),
        flow.summary.matched.length ? h('p', { class: 'small' }, h('b', null, 'Your columns: '), flow.summary.matched.map((c) => c.header).join(', ')) : null,
        flow.summary.added.length ? h('p', { class: 'small' }, h('b', null, flow.summary.empty ? 'Columns created: ' : 'Columns added: '), flow.summary.added.map((c) => c.header).join(', ')) : null,
        flow.learned ? h('p', { class: 'small' }, h('b', null, 'Lists: '), flow.learned.charAt(0).toUpperCase() + flow.learned.slice(1), '.') : null,
        h('p', { class: 'tiny muted' }, 'Want it different? Use Change columns on the Excel settings page.')) : null,
      r.missingHeaders.length ? h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' }, `These columns weren't found, so they were skipped: ${r.missingHeaders.join(', ')}. If you renamed them, use "Change columns".`)) : null,
      h('div', { class: 'card pad stack' }, excelSaveSteps()),
      h('button', { class: 'btn primary block', style: { marginTop: '16px' }, onclick: saveFile }, icon('download'), 'Save file'),
    ];
  }

  function render() {
    if (flow.busy) return fill(el, topbar({ title, back: () => goBack() }), spinner(flow.busy));
    if (flow.step === 'tabs') return fill(el, ...tabsStep());
    if (flow.step === 'map') return fill(el, ...mapStep());
    if (flow.step === 'save') return fill(el, ...saveStep());
    return fill(el, ...overview());
  }

  render();
  return { el };
}
