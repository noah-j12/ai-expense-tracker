import { MODELS, testApiKey } from '../ai.js';
import { clearEverything } from '../db.js';
import { listEntries, updateEntry } from '../entries.js';
import { backupFile, deliverFiles, restoreBackup } from '../exporter.js';
import { clearBlocked, kick } from '../queue.js';
import { CURRENCIES, DATE_FORMATS, allExportFormats, exportFormatName, settings, updateSettings } from '../settings.js';
import { sheetsConnected, sheetsLinked } from '../sheets.js';
import { voiceChooser } from './voice-setup.js';
import { choiceList, choiceSheet, confirmSheet, field, nameListEditor, promptSheet, toast, toggleRow, topbar } from '../ui.js';
import { fill, h, icon, navBack, on, uid } from '../util.js';
import { ExcelSettings } from './excel-setup.js';
import { FormatsView } from './formats.js';
import { SheetsSettings } from './sheets-setup.js';
import { apiKeyInput, apiKeySteps } from './setup.js';

export const APP_VERSION = '1.9.4';

export function goBack(fallback = '#/settings') {
  navBack(fallback);
}

function navItem({ iconName, label, value, href, onclick }) {
  return h('button', { class: 'list-item', onclick: onclick || (() => { location.hash = href; }) },
    icon(iconName), h('div', { class: 'grow' }, label), value ? h('span', { class: 'value small' }, value) : null, h('span', { class: 'chev' }, icon('chevron')));
}

export function SettingsView({ params, query }) {
  const [sub = '', id] = params;
  if (sub === 'sheets') return SheetsSettings({ query });
  if (sub === 'excel') return ExcelSettings({ query });
  if (sub === 'formats') return FormatsView({ id, query });
  const pages = { books, categories, payments, ai, data };
  return (pages[sub] || main)();
}

export function withRefresh(el, build, events = ['settings-changed']) {
  const render = () => fill(el, ...build());
  render();
  const offs = events.map((e) => on(e, render));
  return { el, destroy: () => offs.forEach((off) => off()) };
}

function main() {
  const el = h('div', { class: 'page' });
  return withRefresh(el, () => {
    const s = settings();
    const custom = s.exportTemplates.length;
    return [
      topbar({ title: 'Settings', back: () => { location.hash = '#/'; } }),
      h('div', { class: 'section-title' }, 'How expenses are sorted'),
      h('div', { class: 'list' },
        navItem({ iconName: 'tag', label: 'Categories', value: String(s.categories.length), href: '#/settings/categories' }),
        navItem({ iconName: 'card', label: 'Payment methods', value: String(s.paymentMethods.length), href: '#/settings/payments' }),
        navItem({ iconName: 'building', label: 'Books', value: s.businesses.length > 1 ? String(s.businesses.length) : 'Just one', href: '#/settings/books' }),
        navItem({ iconName: 'sparkle', label: 'AI', value: s.ai.apiKey ? MODELS.find((m) => m.id === s.ai.model)?.name || 'Connected' : 'Not connected', href: '#/settings/ai' }),
      ),
      h('div', { class: 'section-title' }, 'Where your expenses go'),
      h('div', { class: 'list' },
        navItem({ iconName: 'sheet', label: 'Google Sheets', value: sheetsConnected() ? 'Connected' : sheetsLinked() ? 'Finish setup' : 'Off', href: '#/settings/sheets' }),
        navItem({ iconName: 'file', label: 'Excel file', value: s.excel.tab ? 'Set up' : 'Off', href: '#/settings/excel' }),
        navItem({ iconName: 'share', label: 'Export formats', value: custom ? `${custom} custom` : null, href: '#/settings/formats' }),
      ),
      h('div', { class: 'section-title' }, 'Exports'),
      h('div', { class: 'list' },
        navItem({ iconName: 'download', label: 'Default format', value: exportFormatName(s.exportFormat), onclick: async () => {
          const v = await choiceSheet({ title: 'Default export format', options: allExportFormats().map((f) => ({ label: f.name, hint: f.hint, value: f.id, selected: f.id === s.exportFormat })) });
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

function books() {
  const el = h('div', { class: 'page' });
  const add = async () => {
    const s = settings();
    // The first book has no name until a second one exists; name it now so the two can be told apart.
    if (s.businesses.length === 1 && !s.businesses[0].name) {
      const first = await promptSheet({ title: 'Name your current books', message: 'Everything you\'ve logged so far is in these.', placeholder: 'e.g. Personal, or a business name' });
      if (!first) return;
      await updateSettings((d) => { d.businesses[0].name = first; });
    }
    const v = await promptSheet({ title: 'Add books', placeholder: 'e.g. Personal, or a business name' });
    if (v) await updateSettings((d) => { d.businesses.push({ id: uid(), name: v }); });
  };
  return withRefresh(el, () => {
    const s = settings();
    return [
      topbar({ title: 'Books', back: () => goBack() }),
      h('p', { class: 'small muted', style: { margin: '0 4px 12px' } },
        'Keep separate books for different businesses, or for business and personal spending. With more than one, the home screen lets you pick which you\'re logging to, and exports can be filtered by books.'),
      h('div', { class: 'list' }, s.businesses.map((b) => h('div', { class: 'list-item' },
        icon('building'),
        h('button', { class: 'grow', style: { border: 0, background: 'none', textAlign: 'left', padding: 0 }, onclick: async () => {
          const v = await promptSheet({ title: 'Rename books', value: b.name, placeholder: 'e.g. Personal' });
          if (v) await updateSettings((d) => { d.businesses.find((x) => x.id === b.id).name = v; });
        } }, b.name || h('span', { class: 'muted' }, 'Main books (tap to name)')),
        s.businesses.length > 1 ? h('button', { class: 'icon-btn', 'aria-label': `Remove ${b.name}`, onclick: () => removeBook(b) }, icon('trash')) : null,
      ))),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn block', onclick: add }, icon('plus'), 'Add books'),
    ];
  });
}

async function removeBook(b) {
  const s = settings();
  const others = s.businesses.filter((x) => x.id !== b.id);
  const affected = (await listEntries()).filter((e) => e.businessId === b.id);
  let moveTo = others[0].id;
  if (affected.length) {
    moveTo = await choiceSheet({
      title: `Move ${affected.length} expense${affected.length === 1 ? '' : 's'} from ${b.name || 'these books'} toâ€¦`,
      options: others.map((o) => ({ label: o.name || 'Main books', value: o.id, icon: 'building' })),
    });
    if (!moveTo) return;
  } else if (!(await confirmSheet({ title: `Remove ${b.name || 'these books'}?`, confirmText: 'Remove', danger: true }))) {
    return;
  }
  for (const e of affected) await updateEntry(e.id, (x) => { x.businessId = moveTo; });
  await updateSettings((d) => {
    d.businesses = d.businesses.filter((x) => x.id !== b.id);
    if (d.activeBusinessId === b.id) d.activeBusinessId = moveTo;
  });
  toast(`${b.name || 'Books'} removed`);
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
    topbar({ title: 'Categories', back: () => goBack() }),
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
    topbar({ title: 'Payment methods', back: () => goBack() }),
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
  const voiceWrap = h('div', null, voiceSection());

  const saveKey = async () => {
    const key = input.value.trim();
    if (!key) {
      await updateSettings((d) => { d.ai.apiKey = ''; });
      fill(status, h('span', { class: 'muted' }, 'Key removed.'));
      return;
    }
    fill(status, h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Checking your keyâ€¦'));
    const res = await testApiKey(key, settings().ai.model);
    if (!res.ok) {
      fill(status, h('span', { style: { color: 'var(--danger)' } }, res.message));
      return;
    }
    await updateSettings((d) => { d.ai.apiKey = key; });
    clearBlocked();
    kick();
    fill(status, h('span', { style: { color: 'var(--accent)' } }, 'âœ“ Connected. Waiting entries are being read now.'));
  };

  const el = h('div', { class: 'page' },
    topbar({ title: 'AI', back: () => goBack() }),
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
        // Voice cost estimates depend on the model, so redraw them.
        onChange: (id) => updateSettings((d) => { d.ai.model = id; }).then(() => fill(voiceWrap, voiceSection())),
      }),
      h('div', { class: 'section-title' }, 'Your own rules'),
      field('Extra instructions for the AI', instructions, 'Optional. Written in plain English; applied to every receipt.'),
      h('button', { class: 'btn', onclick: async () => {
        await updateSettings((d) => { d.ai.instructions = instructions.value.trim(); });
        toast('Instructions saved');
      } }, 'Save instructions'),
      voiceWrap,
    ),
  );
  return { el };
}

// How "Talk to It" works: keyboard mic, spoken replies, or a live conversation (the last two use OpenAI).
function voiceSection() {
  return h('div', { class: 'stack' },
    h('div', { class: 'section-title' }, 'How you talk to it'),
    voiceChooser({
      read: () => settings().voice,
      write: (fn) => updateSettings((d) => fn(d.voice)),
      model: () => settings().ai.model,
    }),
  );
}

function data() {
  const el = h('div', { class: 'page' });
  const storage = h('span', { class: 'value small' }, 'â€¦');
  const count = h('span', { class: 'value small' }, 'â€¦');
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
    topbar({ title: 'Your data', back: () => goBack() }),
    h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, 'Everything is stored on this phone. Back up now and then (or connect Google Sheets or Excel) so nothing is lost if the phone is.'),
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
