import { MODELS, testApiKey } from '../ai.js';
import { clearEverything } from '../db.js';
import { listEntries, updateEntry } from '../entries.js';
import { backupFile, deliverFiles, restoreBackup } from '../exporter.js';
import { clearBlocked, kick } from '../queue.js';
import { CURRENCIES, DATE_FORMATS, EXPORT_FORMATS, settings, updateSettings } from '../settings.js';
import { resyncEverything, scriptCode, sheetsConnected, sheetsState, syncSheets, testSheets } from '../sheets.js';
import { choiceList, choiceSheet, confirmSheet, field, nameListEditor, promptSheet, toast, toggleRow, topbar } from '../ui.js';
import { formatDateTime, fill, h, icon, on, randomSecret, uid } from '../util.js';
import { apiKeyInput, apiKeySteps } from './setup.js';

export const APP_VERSION = '1.0.0';

function goBack() {
  if (history.length > 1) history.back();
  else location.hash = '#/settings';
}

function navItem({ iconName, label, value, href, onclick }) {
  return h('button', { class: 'list-item', onclick: onclick || (() => { location.hash = href; }) },
    icon(iconName), h('div', { class: 'grow' }, label), value ? h('span', { class: 'value small' }, value) : null, h('span', { class: 'chev' }, icon('chevron')));
}

export function SettingsView({ params }) {
  const sub = params[0] || '';
  const pages = { businesses, categories, payments, ai, sheets, data };
  return (pages[sub] || main)();
}

function withRefresh(el, build, events = ['settings-changed']) {
  const render = () => fill(el, ...build());
  render();
  const offs = events.map((e) => on(e, render));
  return { el, destroy: () => offs.forEach((off) => off()) };
}

function main() {
  const el = h('div', { class: 'page' });
  return withRefresh(el, () => {
    const s = settings();
    return [
      topbar({ title: 'Settings', back: () => { location.hash = '#/'; } }),
      h('div', { class: 'section-title' }, 'You'),
      h('div', { class: 'list' },
        navItem({ iconName: 'pen', label: 'Your name', value: s.ownerName || 'Not set', onclick: async () => {
          const v = await promptSheet({ title: 'Your first name', value: s.ownerName, placeholder: 'e.g. Chris' });
          if (v != null) await updateSettings({ ownerName: v });
        } }),
        navItem({ iconName: 'building', label: 'Businesses', value: String(s.businesses.length), href: '#/settings/businesses' }),
      ),
      h('div', { class: 'section-title' }, 'How expenses are sorted'),
      h('div', { class: 'list' },
        navItem({ iconName: 'tag', label: 'Categories', value: String(s.categories.length), href: '#/settings/categories' }),
        navItem({ iconName: 'card', label: 'Payment methods', value: String(s.paymentMethods.length), href: '#/settings/payments' }),
        navItem({ iconName: 'sparkle', label: 'AI', value: s.ai.apiKey ? MODELS.find((m) => m.id === s.ai.model)?.name || 'Connected' : 'Not connected', href: '#/settings/ai' }),
      ),
      h('div', { class: 'section-title' }, 'Exports & syncing'),
      h('div', { class: 'list' },
        navItem({ iconName: 'share', label: 'Accounting software', value: EXPORT_FORMATS.find((f) => f.id === s.exportFormat)?.name, onclick: async () => {
          const v = await choiceSheet({ title: 'Accounting software', options: EXPORT_FORMATS.map((f) => ({ label: f.name, hint: f.hint, value: f.id, selected: f.id === s.exportFormat })) });
          if (v) await updateSettings({ exportFormat: v });
        } }),
        navItem({ iconName: 'clock', label: 'Date format', value: DATE_FORMATS.find((f) => f.id === s.dateFormat)?.name, onclick: async () => {
          const v = await choiceSheet({ title: 'Date format in exports', options: DATE_FORMATS.map((f) => ({ label: f.name, hint: f.hint, value: f.id, selected: f.id === s.dateFormat })) });
          if (v) await updateSettings({ dateFormat: v });
        } }),
        navItem({ iconName: 'receipt', label: 'Default currency', value: s.currency, onclick: async () => {
          const v = await choiceSheet({ title: 'Default currency', options: CURRENCIES.map((c) => ({ label: c, value: c, selected: c === s.currency })) });
          if (v) await updateSettings({ currency: v });
        } }),
        navItem({ iconName: 'sheet', label: 'Google Sheets', value: sheetsConnected() ? 'Connected' : 'Off', href: '#/settings/sheets' }),
      ),
      h('div', { class: 'section-title' }, 'Scanning'),
      h('div', { class: 'list' },
        toggleRow({
          label: 'Ask for a note after each photo',
          hint: 'Handy for "who was this lunch with?" Off means one tap and done.',
          checked: s.askNoteAfterScan,
          onChange: (v) => updateSettings({ askNoteAfterScan: v }),
        }),
      ),
      h('div', { class: 'section-title' }, 'Your data'),
      h('div', { class: 'list' },
        navItem({ iconName: 'database', label: 'Backup, restore & storage', href: '#/settings/data' }),
        navItem({ iconName: 'wand', label: 'Run setup again', onclick: () => { location.hash = '#/setup'; } }),
      ),
      h('p', { class: 'tiny muted center', style: { marginTop: '24px' } }, `AI Expense Tracker ${APP_VERSION}`),
    ];
  });
}

function businesses() {
  const el = h('div', { class: 'page' });
  return withRefresh(el, () => {
    const s = settings();
    return [
      topbar({ title: 'Businesses', back: goBack }),
      h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, 'With more than one, the home screen lets you pick which business you\'re logging to, and exports can be filtered by business.'),
      h('div', { class: 'list' }, s.businesses.map((b) => h('div', { class: 'list-item' },
        icon('building'),
        h('button', { class: 'grow', style: { border: 0, background: 'none', textAlign: 'left', padding: 0 }, onclick: async () => {
          const v = await promptSheet({ title: 'Rename business', value: b.name });
          if (v) await updateSettings((d) => { d.businesses.find((x) => x.id === b.id).name = v; });
        } }, b.name),
        s.businesses.length > 1 ? h('button', { class: 'icon-btn', 'aria-label': `Remove ${b.name}`, onclick: () => removeBusiness(b) }, icon('trash')) : null,
      ))),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn block', onclick: async () => {
        const v = await promptSheet({ title: 'Add a business', placeholder: 'Business name' });
        if (v) await updateSettings((d) => { d.businesses.push({ id: uid(), name: v }); });
      } }, icon('plus'), 'Add a business'),
    ];
  });
}

async function removeBusiness(b) {
  const s = settings();
  const others = s.businesses.filter((x) => x.id !== b.id);
  const affected = (await listEntries()).filter((e) => e.businessId === b.id);
  let moveTo = others[0].id;
  if (affected.length) {
    moveTo = await choiceSheet({
      title: `Move ${affected.length} expense${affected.length === 1 ? '' : 's'} from ${b.name} to…`,
      options: others.map((o) => ({ label: o.name, value: o.id, icon: 'building' })),
    });
    if (!moveTo) return;
  } else if (!(await confirmSheet({ title: `Remove ${b.name}?`, confirmText: 'Remove', danger: true }))) {
    return;
  }
  for (const e of affected) await updateEntry(e.id, (x) => { x.businessId = moveTo; });
  await updateSettings((d) => {
    d.businesses = d.businesses.filter((x) => x.id !== b.id);
    if (d.activeBusinessId === b.id) d.activeBusinessId = moveTo;
  });
  toast(`${b.name} removed`);
}

// Renaming a category or payment method also updates the expenses that use it.
async function renameInEntries(key, from, to) {
  for (const e of await listEntries()) {
    if (e.fields[key] === from) await updateEntry(e.id, { [key]: to });
  }
}

function categories() {
  const s = settings();
  const el = h('div', { class: 'page' },
    topbar({ title: 'Categories', back: goBack }),
    h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, 'The AI picks from this list. Tap a name to rename it; existing expenses are updated too.'),
    nameListEditor({
      items: s.categories,
      noun: 'category',
      addLabel: 'Add a category',
      placeholder: 'e.g. Job Materials',
      onChange: async (items, { renamed }) => {
        await updateSettings({ categories: items });
        if (renamed) await renameInEntries('category', ...renamed);
      },
    }),
  );
  return { el };
}

function payments() {
  const s = settings();
  const el = h('div', { class: 'page' },
    topbar({ title: 'Payment methods', back: goBack }),
    h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, 'Include the last 4 digits of each card (like "Amex ending 1004") and the AI can match receipts to the right card.'),
    nameListEditor({
      items: s.paymentMethods,
      noun: 'payment method',
      addLabel: 'Add a payment method',
      placeholder: 'e.g. Chase Visa ending 4821',
      onChange: async (items, { renamed }) => {
        await updateSettings({ paymentMethods: items });
        if (renamed) await renameInEntries('paymentMethod', ...renamed);
      },
    }),
  );
  return { el };
}

function ai() {
  const s = settings();
  const { input, row } = apiKeyInput(s.ai.apiKey);
  const status = h('div', { class: 'small' });
  const instructions = h('textarea', {
    class: 'textarea', rows: 4, autocapitalize: 'sentences',
    placeholder: 'e.g. Anything from Lowe\'s or Home Depot is Materials. Meals over $75 need a note saying who it was with.',
  });
  instructions.value = s.ai.instructions || '';

  const saveKey = async () => {
    const key = input.value.trim();
    if (!key) {
      await updateSettings((d) => { d.ai.apiKey = ''; });
      status.replaceChildren(h('span', { class: 'muted' }, 'Key removed.'));
      return;
    }
    status.replaceChildren(h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Checking your key…'));
    const res = await testApiKey(key, settings().ai.model);
    if (!res.ok) {
      status.replaceChildren(h('span', { style: { color: 'var(--danger)' } }, res.message));
      return;
    }
    await updateSettings((d) => { d.ai.apiKey = key; });
    clearBlocked();
    kick();
    status.replaceChildren(h('span', { style: { color: 'var(--accent)' } }, '✓ Connected. Waiting entries are being read now.'));
  };

  const el = h('div', { class: 'page' },
    topbar({ title: 'AI', back: goBack }),
    h('div', { class: 'stack' },
      h('div', { class: 'card pad stack' },
        h('b', null, s.ai.apiKey ? 'Your Anthropic API key' : 'Connect your Anthropic account'),
        s.ai.apiKey ? null : apiKeySteps(),
        row,
        h('button', { class: 'btn primary', onclick: saveKey }, s.ai.apiKey ? 'Save & test key' : 'Connect'),
        status,
        h('p', { class: 'tiny muted' }, 'Stored only on this phone and sent only to Anthropic. You pay Anthropic directly for what you use.'),
      ),
      h('div', { class: 'section-title' }, 'Accuracy vs. cost'),
      choiceList({
        options: MODELS.map((m) => ({ id: m.id, name: m.name, hint: m.detail })),
        value: s.ai.model,
        onChange: (id) => updateSettings((d) => { d.ai.model = id; }),
      }),
      h('div', { class: 'section-title' }, 'Your own rules'),
      field('Extra instructions for the AI', instructions, 'Optional. Written in plain English; applied to every receipt.'),
      h('button', { class: 'btn', onclick: async () => {
        await updateSettings((d) => { d.ai.instructions = instructions.value.trim(); });
        toast('Instructions saved');
      } }, 'Save instructions'),
    ),
  );
  return { el };
}

function sheets() {
  const el = h('div', { class: 'page' });
  return withRefresh(el, () => {
    const s = settings();
    if (sheetsConnected()) {
      return [
        topbar({ title: 'Google Sheets', back: goBack }),
        h('div', { class: 'banner ok' }, icon('check'), h('div', { class: 'body' },
          h('b', null, `Connected${s.sheets.connectedName ? ` to "${s.sheets.connectedName}"` : ''}`),
          h('div', null, 'New and edited expenses are added to the "Expenses" tab automatically, with receipt photos saved in your Google Drive.'))),
        sheetsState.error ? h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' }, sheetsState.error)) : null,
        sheetsState.lastSync ? h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, `Last synced ${formatDateTime(sheetsState.lastSync)}`) : null,
        h('div', { class: 'stack' },
          h('button', { class: 'btn', onclick: async () => { await syncSheets(); toast(sheetsState.error ? 'Sync had a problem' : 'Synced', { error: Boolean(sheetsState.error) }); } }, icon('refresh'), 'Sync now'),
          h('button', { class: 'btn', onclick: async () => {
            if (!(await confirmSheet({ title: 'Send everything again?', message: 'Every expense on this phone is re-sent to the sheet. Useful if rows were deleted in the sheet by accident.', confirmText: 'Send' }))) return;
            await resyncEverything();
            toast('Done');
          } }, 'Re-send all expenses'),
          h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmSheet({ title: 'Disconnect Google Sheets?', message: 'Your sheet keeps everything already in it. New expenses will only be saved on this phone.', confirmText: 'Disconnect', danger: true }))) return;
            await updateSettings((d) => { d.sheets = { url: '', secret: '', connectedName: '' }; });
          } }, 'Disconnect'),
        ),
      ];
    }
    return sheetsSetup(s);
  }, ['settings-changed', 'sheets-changed']);
}

function sheetsSetup(s) {
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
    const text = `AI Expense Tracker - Google Sheets setup\n\n${steps.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n---- SCRIPT (copy everything below) ----\n\n${code}`;
    const file = new File([text], 'AI Expense Tracker - Google Sheets setup.txt', { type: 'text/plain' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Google Sheets setup' }); } catch { /* cancelled */ }
    } else {
      await deliverFiles([file], 'Google Sheets setup');
    }
  };
  const connect = async () => {
    const value = url.value.trim();
    status.replaceChildren(h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Connecting…'));
    try {
      const res = await testSheets(value, secret);
      await updateSettings((d) => { d.sheets = { url: value, secret, connectedName: res.name || '' }; });
      toast('Google Sheets connected');
      resyncEverything();
    } catch (err) {
      status.replaceChildren(h('span', { style: { color: 'var(--danger)' } }, err.message));
    }
  };

  const steps = [
    'On a computer, open sheets.new to create a new Google Sheet. Name it something like "Expenses".',
    'In the sheet, click Extensions > Apps Script.',
    'Delete the code that\'s there and paste in the script below. Click the Save icon.',
    'Click Deploy > New deployment. Click the gear next to "Select type" and choose Web app.',
    'Set "Execute as" to Me and "Who has access" to Anyone. Click Deploy, then Authorize access and allow it. (Google may warn that the app is unverified; it\'s your own script, so click Advanced > Go to project.)',
    'Copy the Web app URL and paste it into the box on your phone.',
  ];

  return [
    topbar({ title: 'Google Sheets', back: goBack }),
    h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Optional. Connect a Google Sheet and every expense is added automatically, with receipt photos saved to your Google Drive. It takes about 5 minutes on a computer, and you only do it once.'),
      h('div', { class: 'card pad stack' },
        h('ol', { class: 'steps' }, steps.map((t) => h('li', null, h('div', null, t)))),
      ),
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

function data() {
  const el = h('div', { class: 'page' });
  const storage = h('span', { class: 'value small' }, '…');
  const count = h('span', { class: 'value small' }, '…');
  let includeKey = false;

  (async () => {
    const all = await listEntries();
    count.textContent = String(all.length);
    try {
      const est = await navigator.storage?.estimate?.();
      storage.textContent = est?.usage != null ? `${(est.usage / 1024 / 1024).toFixed(1)} MB` : 'Unknown';
    } catch {
      storage.textContent = 'Unknown';
    }
  })();

  const restoreInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  restoreInput.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    if (!file) return;
    const ok = await confirmSheet({ title: 'Restore this backup?', message: 'Everything currently on this phone is replaced by the backup.', confirmText: 'Restore', danger: true });
    if (!ok) return;
    try {
      const n = await restoreBackup(file);
      toast(`Restored ${n} expenses`);
      location.hash = '#/';
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  el.append(
    topbar({ title: 'Your data', back: goBack }),
    h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, 'Everything is stored on this phone. Back up now and then (or connect Google Sheets) so nothing is lost if the phone is.'),
    h('div', { class: 'list' },
      h('div', { class: 'list-item' }, icon('receipt'), h('div', { class: 'grow' }, 'Expenses'), count),
      h('div', { class: 'list-item' }, icon('database'), h('div', { class: 'grow' }, 'Storage used'), storage),
    ),
    h('div', { class: 'section-title' }, 'Backup'),
    h('div', { class: 'list' },
      toggleRow({ label: 'Include AI key in backup', hint: 'Only if you\'ll keep the file somewhere private.', checked: false, onChange: (v) => { includeKey = v; } }),
    ),
    h('div', { class: 'spacer' }),
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary', onclick: async () => {
        const file = await backupFile({ includeKey });
        await deliverFiles([file], 'AI Expense Tracker backup');
      } }, icon('download'), 'Back up everything'),
      h('button', { class: 'btn', onclick: () => restoreInput.click() }, icon('upload'), 'Restore from a backup'),
      restoreInput,
    ),
    h('div', { class: 'section-title' }, 'Danger zone'),
    h('button', { class: 'btn danger block', onclick: async () => {
      if (!(await confirmSheet({ title: 'Delete everything?', message: 'All expenses, receipt photos and settings on this phone are erased. This can\'t be undone.', confirmText: 'Continue', danger: true }))) return;
      const typed = await promptSheet({ title: 'Type DELETE to confirm', placeholder: 'DELETE', confirmText: 'Erase everything' });
      if (typed !== 'DELETE') return;
      await clearEverything();
      location.hash = '#/';
      location.reload();
    } }, icon('trash'), 'Delete all data on this phone'),
  );
  return { el };
}
