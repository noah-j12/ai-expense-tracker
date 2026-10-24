import { MODELS, testApiKey } from '../ai.js';
import { clearEverything } from '../db.js';
import { deleteForever, listDeleted, listEntries, restoreEntry, updateEntry } from '../entries.js';
import { backupFile, deliverFiles, restoreBackup } from '../exporter.js';
import { clearBlocked, kick } from '../queue.js';
import { CURRENCIES, DATE_FORMATS, EXCEL_WORKBOOK, allExportFormats, exportFormatName, paymentInfo, settings, updateSettings } from '../settings.js';
import { sheetsConnected, sheetsLinked } from '../sheets.js';
import { voiceChooser } from './voice-setup.js';
import { choiceList, choiceSheet, confirmSheet, field, nameListEditor, openSheet, promptSheet, toast, toggleRow, topbar } from '../ui.js';
import { fill, formatDate, formatMoney, h, icon, navBack, on, uid } from '../util.js';
import { ExcelSettings } from './excel-setup.js';
import { FormatsView } from './formats.js';
import { SheetsSettings } from './sheets-setup.js';
import { BACKUP_MODES, BackupSettings } from './backup-setup.js';
import { apiKeyInput, apiKeySteps } from './setup.js';

export const APP_VERSION = '1.14.0';

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
  if (sub === 'backup') return BackupSettings({ query });
  const pages = { books, categories, payments, ai, data, deleted };
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
        EXCEL_WORKBOOK ? navItem({ iconName: 'file', label: 'Excel file', value: s.excel.tab ? 'Set up' : 'Off', href: '#/settings/excel' }) : null,
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
        navItem({ iconName: 'cloud', label: 'Backup', value: BACKUP_MODES.find((m) => m.id === (s.backup?.mode || 'off'))?.name, href: '#/settings/backup' }),
        navItem({ iconName: 'trash', label: 'Recently deleted', href: '#/settings/deleted' }),
        navItem({ iconName: 'database', label: 'Backup, restore & storage', href: '#/settings/data' }),
        navItem({ iconName: 'wand', label: 'Run setup again', onclick: () => { location.hash = '#/setup'; } }),
      ),
      h('p', { class: 'tiny muted center', style: { marginTop: '24px' } }, `AI Expense Tracker ${APP_VERSION}`),
    ];
  });
}

function deleted() {
  const el = h('div', { class: 'page' });
  const list = h('div', { class: 'stack' });
  const when = (ms) => {
    const days = Math.floor((Date.now() - ms) / 86_400_000);
    return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  };
  const load = async () => {
    const items = await listDeleted();
    fill(list, items.length
      ? h('div', { class: 'list' }, items.map(({ entry: e, deletedAt, from }) => h('div', { class: 'list-item' },
        h('div', { class: 'grow' },
          h('div', null, [e.fields.vendor, e.fields.description].filter(Boolean).join(' · ') || 'Expense'),
          h('div', { class: 'tiny muted' }, `${formatMoney(e.fields.total, e.fields.currency)} · ${formatDate(e.fields.date)} · deleted ${from === 'sheet' ? 'in the sheet ' : ''}${when(deletedAt)}`)),
        h('button', { class: 'btn small', onclick: async () => {
          await restoreEntry(e.id);
          kick();
          toast('Restored');
        } }, 'Restore'),
        h('button', { class: 'icon-btn', 'aria-label': 'Delete for good', onclick: async () => {
          const ok = await confirmSheet({ title: 'Delete for good?', message: "It can't be brought back after this.", confirmText: 'Delete', danger: true });
          if (ok) await deleteForever(e.id);
        } }, icon('trash')))))
      : h('div', { class: 'card empty' }, icon('trash'), h('p', null, 'Nothing has been deleted in the last 30 days.')));
  };
  fill(el,
    topbar({ title: 'Recently deleted', back: () => goBack() }),
    h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, "Expenses deleted in the app or in your sheet stay here for 30 days, then they're gone for good."),
    list);
  load();
  const off = on('entries-changed', load);
  return { el, destroy: off };
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
      title: `Move ${affected.length} expense${affected.length === 1 ? '' : 's'} from ${b.name || 'these books'} to…`,
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

// Name, card endings and other names for one payment method. Resolves { name, last4, aliases },
// 'remove', or null if cancelled.
function editPaymentSheet(name = '') {
  const info = paymentInfo(name);
  const nameInput = h('input', { class: 'input', value: name, placeholder: 'e.g. Bank card 1', autocapitalize: 'words' });
  const cardInput = h('input', { class: 'input', value: info.last4.join(', '), placeholder: 'e.g. 4821', inputmode: 'numeric' });
  const aliasInput = h('input', { class: 'input', value: info.aliases.join(', '), placeholder: 'e.g. farm card, my Visa', autocapitalize: 'none' });
  const error = h('div', { class: 'small', style: { color: 'var(--danger)' } });
  return new Promise((resolve) => {
    let answered = false;
    const done = (v, close) => { answered = true; close(); resolve(v); };
    openSheet((close) => h('div', { class: 'stack' },
      h('h3', null, name ? 'Edit payment method' : 'Add a payment method'),
      field('Name', nameInput, 'What you call it when you talk to the app.'),
      field('Card ending in (optional)', cardInput, 'The last 4 digits. Receipts showing them are matched to this card. Separate several with commas.'),
      field('Other names you might say (optional)', aliasInput, 'Separate them with commas.'),
      error,
      h('button', { class: 'btn primary block', onclick: () => {
        const n = nameInput.value.trim();
        if (!n) { fill(error, 'Give it a name.'); return; }
        if (n !== name && settings().paymentMethods.includes(n)) { fill(error, 'You already have one with that name.'); return; }
        const last4 = [...new Set(cardInput.value.match(/\d{4}/g) || [])];
        const aliases = [...new Set(aliasInput.value.split(',').map((a) => a.trim()).filter(Boolean))];
        done({ name: n, last4, aliases }, close);
      } }, 'Save'),
      name ? h('button', { class: 'btn danger block', onclick: () => done('remove', close) }, 'Remove') : null,
      h('button', { class: 'btn ghost block', onclick: () => done(null, close) }, 'Cancel'),
    ), { onClose: () => { if (!answered) resolve(null); } });
  });
}

function payments() {
  const el = h('div', { class: 'page' });
  const save = async (oldName, result) => {
    if (!result) return;
    if (result === 'remove') {
      await updateSettings((d) => { d.paymentMethods = d.paymentMethods.filter((m) => m !== oldName); delete d.paymentDetails[oldName]; });
      return;
    }
    const { name, last4, aliases } = result;
    await updateSettings((d) => {
      // A card ending belongs to one payment method only.
      for (const m of Object.keys(d.paymentDetails)) {
        if (m !== oldName) d.paymentDetails[m] = { ...d.paymentDetails[m], last4: (d.paymentDetails[m].last4 || []).filter((x) => !last4.includes(x)) };
      }
      if (oldName) {
        d.paymentMethods = d.paymentMethods.map((m) => (m === oldName ? name : m));
        delete d.paymentDetails[oldName];
      } else {
        d.paymentMethods.push(name);
      }
      d.paymentDetails[name] = { last4, aliases };
    });
    if (oldName && oldName !== name) await renameInEntries('paymentMethod', oldName, name);
  };
  return withRefresh(el, () => {
    const s = settings();
    return [
      topbar({ title: 'Payment methods', back: () => goBack() }),
      h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, 'Give each one a name you\'d say out loud, like "Bank card 1". Add the card\'s last 4 digits and receipts are matched to it automatically.'),
      s.paymentMethods.length
        ? h('div', { class: 'list' }, s.paymentMethods.map((m) => {
          const { last4, aliases } = paymentInfo(m);
          const sub = [last4.length ? `Card ending ${last4.join(', ')}` : '', aliases.length ? `Also "${aliases.join('", "')}"` : ''].filter(Boolean).join(' · ');
          return h('button', { class: 'list-item', onclick: async () => save(m, await editPaymentSheet(m)) },
            icon('card'), h('div', { class: 'grow' }, h('div', null, m), sub ? h('div', { class: 'tiny muted' }, sub) : null), h('span', { class: 'chev' }, icon('chevron')));
        }))
        : h('div', { class: 'card pad muted small center' }, 'No payment methods yet.'),
      h('button', { class: 'btn block', style: { marginTop: '12px' }, onclick: async () => save('', await editPaymentSheet()) }, icon('plus'), 'Add a payment method'),
    ];
  });
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
    fill(status, h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Checking your key…'));
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
    topbar({ title: 'Your data', back: () => goBack() }),
    h('p', { class: 'small muted', style: { margin: '0 4px 12px' } }, 'Everything is stored on this phone. Turn on Backup in Settings, or save a backup here now and then, so nothing is lost if the phone is.'),
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
