// Google Sheets: connect a sheet, pick a tab (or make a new one), and match its columns.

import { listEntries } from '../entries.js';
import { deliverFiles } from '../exporter.js';
import { fieldLabel } from '../fields.js';
import { cleanLayout, columnMapper, extraColumnsPicker, offerLearnedLists, suggestMapping } from '../mapper.js';
import { settings, updateSettings } from '../settings.js';
import {
  defaultSheetColumns, distinctValues, prepareTab, resyncEverything, scriptCode, sheetsConnected, sheetsInfo, sheetsLinked, sheetsState, syncSheets,
} from '../sheets.js';
import { confirmSheet, field, toast, topbar } from '../ui.js';
import { fill, formatDateTime, h, icon, on, randomSecret } from '../util.js';
import { goBack } from './settings.js';

const STEPS = [
  'On a computer, open sheets.new to create a new Google Sheet, or open the sheet you already use.',
  'In the sheet, click Extensions > Apps Script.',
  'Delete the code that\'s there and paste in the script below. Click the Save icon.',
  'Click Deploy > New deployment. Click the gear next to "Select type" and choose Web app.',
  'Set "Execute as" to Me and "Who has access" to Anyone. Click Deploy, then Authorize access and allow it. (Google may warn that the app is unverified; it\'s your own script, so click Advanced > Go to project.)',
  'Copy the Web app URL and paste it into the box on your phone.',
];

export function SheetsSettings() {
  const el = h('div', { class: 'page' });
  // step: null (overview) | 'tabs' | 'map'
  const flow = { step: null, info: null, tab: '', headers: [], rows: [], mapping: [], busy: '' };

  const spinner = (text) => h('div', { class: 'card processing' }, h('span', { class: 'spinner' }), h('div', null, text));

  async function loadInfo() {
    flow.busy = 'Reading your sheet…';
    render();
    try {
      flow.info = await sheetsInfo();
      flow.step = 'tabs';
    } catch (err) {
      toast(err.message, { error: true });
      flow.step = null;
    } finally {
      flow.busy = '';
      render();
    }
  }

  async function chooseTab(tab) {
    if (!tab.headers?.length || !tab.headers.some(Boolean)) return useNewTab(tab.name);
    const { headers, rows } = cleanLayout(tab.headers, tab.sample);
    flow.tab = tab.name;
    flow.headers = headers;
    flow.rows = rows;
    flow.busy = 'Matching your columns…';
    render();
    const saved = settings().sheets;
    if (saved.tab === tab.name && saved.columns.length) {
      flow.mapping = headers.map((hd) => saved.columns.find((c) => c.header === hd)?.field || '');
    } else {
      flow.mapping = await suggestMapping(headers, rows);
    }
    flow.busy = '';
    flow.step = 'map';
    render();
  }

  async function useNewTab(name) {
    flow.busy = 'Setting up the tab…';
    render();
    try {
      const columns = defaultSheetColumns();
      await prepareTab({ tab: name, headers: columns.map((c) => c.header) });
      await saveLayout(name, columns);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      flow.busy = '';
      render();
    }
  }

  async function saveMapping(extras) {
    flow.busy = 'Saving…';
    render();
    try {
      const added = extras.selected();
      await prepareTab({ tab: flow.tab, addHeaders: added.map((c) => c.header) });
      const columns = [...flow.headers.map((header, i) => ({ header, field: flow.mapping[i] || '' })), ...added];
      // Reuse the category / payment names already in the sheet, if the user wants.
      const lookup = ['category', 'paymentMethod'].map((f) => columns.find((c) => c.field === f)?.header).filter(Boolean);
      const found = await distinctValues(flow.tab, lookup).catch(() => ({}));
      const catHeader = columns.find((c) => c.field === 'category')?.header;
      const payHeader = columns.find((c) => c.field === 'paymentMethod')?.header;
      await offerLearnedLists({ categories: found[catHeader] || [], paymentMethods: found[payHeader] || [] }, 'sheet');
      await saveLayout(flow.tab, columns);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      flow.busy = '';
      render();
    }
  }

  async function saveLayout(tab, columns) {
    const switched = settings().sheets.tab !== tab;
    await updateSettings((d) => { d.sheets.tab = tab; d.sheets.columns = columns; });
    flow.step = null;
    const count = (await listEntries()).length;
    if (count) {
      const send = await confirmSheet({
        title: `Send your ${count} expense${count === 1 ? '' : 's'} to the sheet?`,
        message: `They'll be added to "${tab}" below any rows already there. Ones already in the sheet are updated, not duplicated.`,
        confirmText: 'Send', cancelText: 'Not now',
      });
      if (send) {
        await resyncEverything({ forgetRows: switched });
        toast(sheetsState.error ? 'Sync had a problem' : 'Sent to Google Sheets', { error: Boolean(sheetsState.error) });
      }
    } else {
      toast('Google Sheets connected');
    }
  }

  function instructions() {
    const s = settings();
    // The connection code is created once and kept, so the script stays the same if they come back later.
    let secret = s.sheets.pendingSecret;
    if (!secret) {
      secret = randomSecret();
      updateSettings((d) => { d.sheets.pendingSecret = secret; });
    }
    const code = scriptCode(secret);
    const url = h('input', { class: 'input', type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec', autocapitalize: 'off', spellcheck: 'false' });
    const status = h('div', { class: 'small' });

    const copy = async () => {
      try {
        await navigator.clipboard.writeText(code);
        toast('Script copied');
      } catch {
        toast('Copy failed. Use "Send to my computer" instead.', { error: true });
      }
    };
    const sendToComputer = async () => {
      const text = `AI Expense Tracker - Google Sheets setup\n\n${STEPS.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n---- SCRIPT (copy everything below) ----\n\n${code}`;
      await deliverFiles([new File([text], 'AI Expense Tracker - Google Sheets setup.txt', { type: 'text/plain' })], 'Google Sheets setup');
    };
    const connect = async () => {
      const value = url.value.trim();
      fill(status, h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Connecting…'));
      try {
        const info = await sheetsInfo(value, secret);
        await updateSettings((d) => { d.sheets = { ...d.sheets, url: value, secret, connectedName: info.name || '', tab: '', columns: [] }; });
        flow.info = info;
        flow.step = 'tabs';
        render();
      } catch (err) {
        fill(status, h('span', { style: { color: 'var(--danger)' } }, err.message));
      }
    };

    return [
      topbar({ title: 'Google Sheets', back: () => goBack() }),
      h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Connect a Google Sheet, new or one you already use, and every expense is added automatically, with receipt photos saved to your Google Drive. Your existing columns and rows are kept. It takes about 5 minutes on a computer, once.'),
        h('div', { class: 'card pad stack' }, h('ol', { class: 'steps' }, STEPS.map((t) => h('li', null, h('div', null, t))))),
        h('div', { class: 'field' }, h('div', { class: 'label' }, 'The script'), h('pre', { class: 'code' }, code)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: copy }, 'Copy script'),
          h('button', { class: 'btn', onclick: sendToComputer }, icon('share'), 'Send to my computer'),
        ),
        field('Web app URL', url, 'Tip: email or text the URL to yourself from the computer, then paste it here.'),
        h('button', { class: 'btn primary', onclick: connect }, 'Connect'),
        status,
        h('p', { class: 'tiny muted' }, 'The script contains a private connection code only this phone knows, so nobody else can add rows to your sheet.'),
      ),
    ];
  }

  function tabsStep() {
    const tabs = flow.info?.tabs || [];
    const names = new Set(tabs.map((t) => t.name));
    let newName = 'Expenses';
    for (let i = 2; names.has(newName); i++) newName = `Expenses ${i}`;
    return [
      topbar({ title: 'Pick a tab', back: () => { flow.step = null; render(); } }),
      h('p', { class: 'muted', style: { margin: '0 4px 12px' } }, `Which tab in "${flow.info?.name || 'your sheet'}" should expenses go into?`),
      h('div', { class: 'list' },
        tabs.map((t) => {
          const cols = t.headers.filter((x) => x && x !== 'AI Expense Tracker ID').length;
          return h('button', { class: 'list-item', onclick: () => chooseTab(t) }, icon('sheet'),
            h('div', { class: 'grow' }, h('div', null, t.name), h('div', { class: 'tiny muted' }, cols ? `${cols} columns · ${t.rows} row${t.rows === 1 ? '' : 's'}` : 'Empty tab')),
            h('span', { class: 'chev' }, icon('chevron')));
        }),
        h('button', { class: 'list-item', onclick: () => useNewTab(newName) }, icon('plus'),
          h('div', { class: 'grow' }, h('div', null, `New tab called "${newName}"`), h('div', { class: 'tiny muted' }, 'With the app\'s standard columns')),
          h('span', { class: 'chev' }, icon('chevron'))),
      ),
    ];
  }

  function mapStep() {
    const extras = extraColumnsPicker(flow.mapping);
    const mapper = columnMapper({ headers: flow.headers, samples: flow.rows, mapping: flow.mapping, onChange: () => extras.refresh() });
    return [
      topbar({ title: 'Match your columns', back: () => { flow.step = 'tabs'; render(); } }),
      h('p', { class: 'muted', style: { margin: '0 4px 12px' } }, `Here's what the app will put in each column of "${flow.tab}". Columns set to "Leave blank" are never touched.`),
      mapper,
      h('div', { class: 'section-title' }, 'Add columns your sheet doesn\'t have (optional)'),
      extras.el,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary block', style: { marginTop: '16px' }, onclick: () => saveMapping(extras) }, 'Save'),
    ];
  }

  function connected() {
    const s = settings();
    const mapped = s.sheets.columns.filter((c) => c.field);
    return [
      topbar({ title: 'Google Sheets', back: () => goBack() }),
      h('div', { class: 'banner ok' }, icon('check'), h('div', { class: 'body' },
        h('b', null, `Connected to "${s.sheets.connectedName || 'your sheet'}"`),
        h('div', null, `Expenses go into the "${s.sheets.tab}" tab automatically.`))),
      sheetsState.error ? h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' }, sheetsState.error)) : null,
      sheetsState.lastSync ? h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, `Last synced ${formatDateTime(sheetsState.lastSync)}`) : null,
      h('div', { class: 'section-title' }, 'Columns'),
      h('div', { class: 'list' }, mapped.map((c) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('b', null, c.header)), h('span', { class: 'value small' }, fieldLabel(c.field))))),
      h('div', { class: 'stack', style: { marginTop: '16px' } },
        h('button', { class: 'btn', onclick: async () => {
          await loadInfo();
          const tab = flow.info?.tabs.find((t) => t.name === settings().sheets.tab);
          if (tab) await chooseTab(tab);
        } }, icon('pen'), 'Change columns'),
        h('button', { class: 'btn', onclick: loadInfo }, icon('sheet'), 'Use a different tab'),
        h('button', { class: 'btn', onclick: async () => { await syncSheets(); toast(sheetsState.error ? 'Sync had a problem' : 'Synced', { error: Boolean(sheetsState.error) }); } }, icon('refresh'), 'Sync now'),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await confirmSheet({ title: 'Send everything again?', message: 'Every expense on this phone is re-sent. Rows already in the sheet are updated, missing ones are added back.', confirmText: 'Send' }))) return;
          await resyncEverything();
          toast('Done');
        } }, 'Re-send all expenses'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmSheet({ title: 'Disconnect Google Sheets?', message: 'Your sheet keeps everything already in it. New expenses will only be saved on this phone.', confirmText: 'Disconnect', danger: true }))) return;
          await updateSettings((d) => { d.sheets = { url: '', secret: '', connectedName: '', tab: '', columns: [] }; });
        } }, 'Disconnect'),
      ),
    ];
  }

  function render() {
    if (flow.busy) return fill(el, topbar({ title: 'Google Sheets', back: () => goBack() }), spinner(flow.busy));
    if (flow.step === 'tabs') return fill(el, ...tabsStep());
    if (flow.step === 'map') return fill(el, ...mapStep());
    if (sheetsConnected()) return fill(el, ...connected());
    if (sheetsLinked()) {
      // Script connected but no tab picked yet (e.g. they left mid-setup). Try once automatically.
      if (!flow.autoTried) {
        flow.autoTried = true;
        loadInfo();
        return null;
      }
      return fill(el, topbar({ title: 'Google Sheets', back: () => goBack() }),
        h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' }, 'Your sheet is connected, but its tabs couldn\'t be read just now.')),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary', onclick: loadInfo }, icon('refresh'), 'Try again'),
          h('button', { class: 'btn', onclick: () => updateSettings((d) => { d.sheets = { ...d.sheets, url: '', secret: '', tab: '', columns: [] }; }).then(render) }, 'Start over')));
    }
    return fill(el, ...instructions());
  }

  render();
  const offs = [on('sheets-changed', () => { if (!flow.step && !flow.busy && sheetsConnected()) render(); })];
  return { el, destroy: () => offs.forEach((off) => off()) };
}
