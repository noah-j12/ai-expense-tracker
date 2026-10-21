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
import { googleConfigured, pickerConfigured } from '../google-config.js';
import { createSpreadsheet, pickSpreadsheet, pollDeviceAuth, signOutGoogle, spreadsheetInfo, startDeviceAuth } from '../google.js';

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
  // step: null (overview) | 'script' | 'device' | 'choose' | 'tabs' | 'map'
  const flow = { step: null, info: null, tab: '', headers: [], rows: [], mapping: [], busy: '', device: null, deviceError: '' };
  let pollTimer = null;
  const google = () => settings().sheets.mode === 'google';

  const spinner = (text) => h('div', { class: 'card processing' }, h('span', { class: 'spinner' }), h('div', null, text));

  async function loadInfo() {
    flow.busy = 'Reading your sheet…';
    render();
    try {
      flow.info = google() ? await spreadsheetInfo(settings().sheets.google.spreadsheetId) : await sheetsInfo();
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
        await updateSettings((d) => { d.sheets = { ...d.sheets, mode: 'script', url: value, secret, connectedName: info.name || '', tab: '', columns: [] }; });
        flow.info = info;
        flow.step = 'tabs';
        render();
      } catch (err) {
        fill(status, h('span', { style: { color: 'var(--danger)' } }, err.message));
      }
    };

    return [
      topbar({ title: 'Google Sheets', back: googleConfigured() ? () => { flow.step = null; render(); } : () => goBack() }),
      h('div', { class: 'stack' },
        h('p', { class: 'muted' }, googleConfigured()
          ? 'The script method works with any sheet, including ones shared with you. It\'s set up once, on a computer.'
          : 'Connect a Google Sheet, new or one you already use, and every expense is added automatically, with receipt photos saved to your Google Drive. Your existing columns and rows are kept. It takes about 5 minutes on a computer, once.'),
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

  // ---------- Connect with Google ----------

  function overview() {
    return [
      topbar({ title: 'Google Sheets', back: () => goBack() }),
      h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Every expense is added to a Google Sheet automatically, with receipt photos saved to your Google Drive. Set up takes a minute, right here on your phone.'),
        h('button', { class: 'btn primary', onclick: startConnect }, icon('sheet'), 'Connect with Google'),
        h('p', { class: 'tiny muted' }, 'The app only gets access to the spreadsheet it creates or the one you choose, and its receipts folder. Nothing else in your Google account.'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn ghost small', onclick: () => { flow.step = 'script'; render(); } }, 'Set up with a script instead (for sheets shared with you)'),
      ),
    ];
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function startConnect() {
    flow.deviceError = '';
    flow.busy = 'Getting a sign-in code…';
    render();
    try {
      flow.device = await startDeviceAuth();
      flow.step = 'device';
      schedulePoll(flow.device.interval);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      flow.busy = '';
      render();
    }
  }

  function schedulePoll(seconds) {
    stopPolling();
    pollTimer = setTimeout(poll, seconds * 1000);
  }

  async function poll() {
    const d = flow.device;
    if (!d || flow.step !== 'device') return;
    if (Date.now() > d.expiresAt) {
      flow.deviceError = 'That code expired. Tap "Get a new code".';
      return render();
    }
    try {
      const out = await pollDeviceAuth(d.deviceCode);
      if (out === 'done') {
        stopPolling();
        await updateSettings((s) => { s.sheets.mode = 'google'; s.sheets.google.spreadsheetId = ''; s.sheets.tab = ''; s.sheets.columns = []; });
        flow.step = 'choose';
        toast('Google connected');
        return render();
      }
      schedulePoll(out === 'slow_down' ? d.interval + 5 : d.interval);
    } catch (err) {
      if (err.offline) return schedulePoll(d.interval);
      flow.deviceError = err.message;
      render();
    }
  }

  function deviceStep() {
    const d = flow.device;
    const copyCode = async () => {
      try {
        await navigator.clipboard.writeText(d.userCode);
        toast('Code copied');
      } catch { /* the code is on screen to type */ }
    };
    return [
      topbar({ title: 'Connect with Google', back: () => { stopPolling(); flow.step = null; render(); } }),
      h('div', { class: 'stack' },
        h('ol', { class: 'steps' },
          h('li', null, h('div', null, 'Copy this code:'), null),
          h('li', null, h('div', null, 'Tap ', h('b', null, 'Open Google'), ', sign in if asked, and paste the code.')),
          h('li', null, h('div', null, 'Tap ', h('b', null, 'Allow'), ', then come back here. This screen updates by itself.'))),
        h('div', { class: 'card pad center' },
          h('div', { class: 'num', style: { fontSize: '30px', fontWeight: 750, letterSpacing: '.08em' } }, d.userCode),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn small', onclick: copyCode }, 'Copy code')),
        h('a', { class: 'btn primary', href: d.verificationUrl, target: '_blank', rel: 'noopener', onclick: copyCode }, 'Open Google'),
        flow.deviceError
          ? h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' }, flow.deviceError,
            h('div', null, h('button', { class: 'btn small', onclick: startConnect }, 'Get a new code'))))
          : h('div', { class: 'row small muted', style: { justifyContent: 'center' } }, h('span', { class: 'spinner' }), 'Waiting for you to allow access…'),
      ),
    ];
  }

  async function createNew(nameInput) {
    const name = nameInput.value.trim() || 'Expenses';
    flow.busy = 'Creating your sheet…';
    render();
    try {
      const columns = defaultSheetColumns();
      const out = await createSpreadsheet(name, 'Expenses', columns.map((c) => c.header));
      await updateSettings((d) => { d.sheets.google.spreadsheetId = out.spreadsheetId; d.sheets.connectedName = out.name; });
      flow.busy = '';
      await saveLayout('Expenses', columns);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      flow.busy = '';
      render();
    }
  }

  async function chooseExisting() {
    try {
      const picked = await pickSpreadsheet();
      if (!picked) return;
      await updateSettings((d) => { d.sheets.google.spreadsheetId = picked.id; d.sheets.connectedName = picked.name; });
      await loadInfo();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  function chooseStep() {
    const nameInput = h('input', { class: 'input', value: 'Expenses', autocapitalize: 'words' });
    return [
      topbar({ title: 'Which sheet?', back: () => goBack() }),
      h('div', { class: 'stack' },
        h('div', { class: 'card pad stack' },
          h('b', null, 'Start a new Google Sheet'),
          field('Name', nameInput),
          h('button', { class: 'btn primary', onclick: () => createNew(nameInput) }, icon('plus'), 'Create it')),
        pickerConfigured()
          ? h('div', { class: 'card pad stack' },
            h('b', null, 'Use a sheet you already have'),
            h('p', { class: 'small muted' }, 'Your existing columns and rows are kept; new expenses are added below.'),
            h('button', { class: 'btn', onclick: chooseExisting }, icon('sheet'), 'Choose from my Google Drive'))
          : null,
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
        google() ? h('button', { class: 'btn', onclick: () => { flow.step = 'choose'; render(); } }, icon('file'), 'Use a different spreadsheet') : null,
        h('button', { class: 'btn', onclick: async () => { await syncSheets(); toast(sheetsState.error ? 'Sync had a problem' : 'Synced', { error: Boolean(sheetsState.error) }); } }, icon('refresh'), 'Sync now'),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await confirmSheet({ title: 'Send everything again?', message: 'Every expense on this phone is re-sent. Rows already in the sheet are updated, missing ones are added back.', confirmText: 'Send' }))) return;
          await resyncEverything();
          toast('Done');
        } }, 'Re-send all expenses'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmSheet({ title: 'Disconnect Google Sheets?', message: 'Your sheet keeps everything already in it. New expenses will only be saved on this phone.', confirmText: 'Disconnect', danger: true }))) return;
          if (google()) await signOutGoogle();
          await updateSettings(resetSheets);
        } }, 'Disconnect'),
      ),
    ];
  }

  function render() {
    if (flow.busy) return fill(el, topbar({ title: 'Google Sheets', back: () => goBack() }), spinner(flow.busy));
    if (flow.step === 'device') return fill(el, ...deviceStep());
    if (flow.step === 'choose') return fill(el, ...chooseStep());
    if (flow.step === 'tabs') return fill(el, ...tabsStep());
    if (flow.step === 'map') return fill(el, ...mapStep());
    if (flow.step === 'script') return fill(el, ...instructions());
    if (sheetsConnected()) return fill(el, ...connected());
    // Signed in with Google but no spreadsheet chosen yet.
    if (google() && sheetsLinked() && !settings().sheets.google.spreadsheetId) return fill(el, ...chooseStep());
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
          h('button', { class: 'btn', onclick: () => updateSettings(resetSheets).then(render) }, 'Start over')));
    }
    return fill(el, ...(googleConfigured() ? overview() : instructions()));
  }

  render();
  const offs = [on('sheets-changed', () => { if (!flow.step && !flow.busy && sheetsConnected()) render(); })];
  // Coming back from the Google page: check right away instead of waiting for the next poll.
  const onVisible = () => { if (document.visibilityState === 'visible' && flow.step === 'device' && !flow.deviceError) schedulePoll(0.3); };
  document.addEventListener('visibilitychange', onVisible);
  return {
    el,
    destroy: () => {
      offs.forEach((off) => off());
      stopPolling();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}

// Back to "not connected", keeping the script's connection code so a pasted script still matches.
function resetSheets(d) {
  d.sheets = {
    mode: 'script', url: '', secret: '', connectedName: '', tab: '', columns: [],
    google: { refreshToken: '', spreadsheetId: '', folderId: '' },
    pendingSecret: d.sheets.pendingSecret,
  };
}
