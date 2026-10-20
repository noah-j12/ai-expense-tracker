import { MODELS } from '../ai.js';
import { getFile } from '../db.js';
import { getEntry, hasReceipt, removeEntry, requeue, updateEntry } from '../entries.js';
import { deliverFiles, receiptFiles } from '../exporter.js';
import { kick, queueState } from '../queue.js';
import { CURRENCIES, businessName, hasMultipleBusinesses, settings, updateSettings } from '../settings.js';
import { sheetsConnected } from '../sheets.js';
import { choiceSheet, confirmSheet, field, imageViewer, promptSheet, toast, topbar } from '../ui.js';
import { debounce, formatDateTime, formatMoney, fill, h, icon, on, round2 } from '../util.js';

const NEW_OPTION = '__new__';

function parseAmount(text) {
  const n = parseFloat(String(text).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? round2(n) : 0;
}

function amountText(n) {
  return n ? (Math.round(n * 100) / 100).toFixed(2) : '';
}

function goBack() {
  if (history.length > 1) history.back();
  else location.hash = '#/';
}

export function EntryView({ params, query }) {
  const id = params[0];
  const isNew = query.get('new') === '1';
  const el = h('div', { class: 'page' });
  let entry = null;
  let shownStatus = null;
  let objectUrl = null;
  let edited = false;

  const save = debounce(async (patch) => {
    await updateEntry(id, patch);
  }, 400);
  const pending = {};
  const queueSave = (key, value) => {
    pending[key] = value;
    edited = true;
    save({ ...pending });
  };

  async function load() {
    entry = await getEntry(id);
    if (!entry) {
      fill(el, topbar({ title: 'Expense', back: goBack }), h('div', { class: 'card empty' }, 'This expense was deleted.'));
      return;
    }
    shownStatus = entry.aiStatus;
    await render();
  }

  function selectWithNew({ value, options, newLabel, onPick, emptyLabel }) {
    const list = [...options];
    if (value && !list.includes(value)) list.unshift(value);
    const select = h('select', { class: 'select' },
      h('option', { value: '' }, emptyLabel),
      list.map((o) => h('option', { value: o, selected: o === value }, o)),
      h('option', { value: NEW_OPTION }, newLabel),
    );
    select.value = value || '';
    let last = select.value;
    select.addEventListener('change', async () => {
      if (select.value !== NEW_OPTION) {
        last = select.value;
        onPick(select.value);
        return;
      }
      const name = await promptSheet({ title: newLabel.replace('…', ''), placeholder: 'Name' });
      if (!name) { select.value = last; return; }
      await onPick(name, { isNew: true });
      select.insertBefore(h('option', { value: name }, name), select.lastChild);
      select.value = name;
      last = name;
    });
    return select;
  }

  function moneyInput(key, { big = false } = {}) {
    const input = h('input', {
      class: 'input num', inputmode: 'decimal', value: amountText(entry.fields[key]), placeholder: '0.00',
      style: big ? { fontSize: '24px', fontWeight: '700' } : null,
    });
    input.addEventListener('input', () => queueSave(key, parseAmount(input.value)));
    input.addEventListener('blur', () => { input.value = amountText(parseAmount(input.value)); });
    return input;
  }

  function textInput(key, attrs = {}) {
    const input = h('input', { class: 'input', value: entry.fields[key] || '', ...attrs });
    input.addEventListener('input', () => queueSave(key, input.value));
    return input;
  }

  function statusBlock() {
    const e = entry;
    if (e.aiStatus === 'processing') {
      return h('div', { class: 'card processing' }, h('span', { class: 'spinner' }), h('div', null, h('b', null, 'Reading…'), h('div', { class: 'small muted' }, 'This usually takes a few seconds.')));
    }
    if (e.aiStatus === 'queued') {
      const why = queueState.blocked || (!navigator.onLine || queueState.offline ? "You're offline. It'll be read automatically when you're back online." : 'It will be read in a moment.');
      return h('div', { class: 'banner' }, icon('clock'), h('div', { class: 'body' }, h('b', null, 'Waiting to be read. '), why,
        h('div', null, h('button', { class: 'btn small', onclick: fillByHand }, icon('pen'), 'Fill in by hand instead'))));
    }
    if (e.aiStatus === 'error') {
      return h('div', { class: 'banner danger' }, icon('alert'), h('div', { class: 'body' }, h('b', null, "Couldn't read this. "), e.aiError,
        h('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } },
          h('button', { class: 'btn small', onclick: retry }, icon('refresh'), 'Try again'))));
    }
    if (!e.reviewed && e.reviewReasons?.length) {
      return h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' },
        h('b', null, 'Please double-check:'),
        h('ul', { class: 'reasons' }, e.reviewReasons.map((r) => h('li', null, r))),
        h('button', { class: 'btn small', onclick: markReviewed }, icon('check'), 'Looks good')));
    }
    return null;
  }

  async function preview() {
    const e = entry;
    if (e.fileId) {
      const blob = await getFile(e.fileId);
      if (!blob) return h('div', { class: 'card pad muted small' }, 'Receipt file is missing.');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      if (blob.type.startsWith('audio/')) {
        return h('div', { class: 'stack' },
          h('div', { class: 'card pad stack' }, h('b', null, 'Voice recording'), h('audio', { controls: true, src: objectUrl, preload: 'metadata', style: { width: '100%' } })),
          e.inputText ? h('div', { class: 'quote' }, e.inputText) : null);
      }
      if (blob.type === 'application/pdf') {
        return h('div', { class: 'card pad row' }, h('div', { class: 'thumb' }, icon('file')), h('div', { class: 'grow' }, h('b', null, 'Receipt PDF')),
          h('a', { class: 'btn small', href: objectUrl, target: '_blank', rel: 'noopener' }, 'Open'));
      }
      const url = objectUrl;
      return h('div', { class: 'preview' },
        h('img', { src: url, alt: 'Receipt photo', onclick: () => imageViewer(url) }),
        h('button', { class: 'icon-btn expand', 'aria-label': 'View full size', onclick: () => imageViewer(url) }, icon('expand')));
    }
    if (e.inputText) return h('div', { class: 'quote' }, e.inputText);
    return null;
  }

  function form() {
    const s = settings();
    const f = entry.fields;
    const vendor = textInput('vendor', { placeholder: 'Who you paid', autocapitalize: 'words' });
    const date = h('input', { class: 'input', type: 'date', value: f.date });
    date.addEventListener('change', () => queueSave('date', date.value));

    const category = selectWithNew({
      value: f.category,
      options: s.categories,
      emptyLabel: 'Uncategorized',
      newLabel: '＋ New category…',
      onPick: async (name, { isNew } = {}) => {
        if (isNew) await updateSettings((d) => { d.categories.push(name); });
        queueSave('category', name);
      },
    });
    const payment = selectWithNew({
      value: f.paymentMethod,
      options: s.paymentMethods,
      emptyLabel: 'Not specified',
      newLabel: '＋ New payment method…',
      onPick: async (name, { isNew } = {}) => {
        if (isNew) await updateSettings((d) => { d.paymentMethods.push(name); });
        queueSave('paymentMethod', name);
      },
    });

    const notes = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Anything your accountant should know', autocapitalize: 'sentences' }, f.notes || '');
    notes.value = f.notes || '';
    notes.addEventListener('input', () => queueSave('notes', notes.value));

    const currency = h('select', { class: 'select' },
      [...new Set([f.currency, s.currency, ...CURRENCIES])].filter(Boolean).map((c) => h('option', { value: c, selected: c === f.currency }, c)));
    currency.addEventListener('change', () => queueSave('currency', currency.value));

    let business = null;
    if (hasMultipleBusinesses()) {
      business = h('select', { class: 'select' }, s.businesses.map((b) => h('option', { value: b.id, selected: b.id === entry.businessId }, businessName(b.id))));
      business.addEventListener('change', async () => {
        edited = true;
        await updateEntry(id, (e) => { e.businessId = business.value; });
      });
    }

    const amount = moneyInput('total', { big: true });
    if (isNew) setTimeout(() => amount.focus(), 50);

    return h('div', { class: 'stack' },
      field('Amount', amount, f.total < 0 ? 'Negative means a refund.' : null),
      field('Vendor', vendor),
      h('div', { class: 'grid-2' }, field('Date', date), field('Category', category)),
      field('What was it for?', textInput('description', { placeholder: 'e.g. Lumber for deck job', autocapitalize: 'sentences' })),
      field('Paid with', payment),
      business ? field('Books', business) : null,
      field('Notes', notes),
      h('details', { class: 'card pad' },
        h('summary', { class: 'small', style: { fontWeight: 600, color: 'var(--muted)' } }, 'Tax, tip & currency'),
        h('div', { class: 'stack', style: { marginTop: '14px' } },
          h('div', { class: 'grid-2' }, field('Tax', moneyInput('tax')), field('Tip', moneyInput('tip'))),
          h('div', { class: 'grid-2' }, field('Subtotal', moneyInput('subtotal')), field('Currency', currency)),
        )),
    );
  }

  function meta() {
    const e = entry;
    const model = MODELS.find((m) => m.id === e.aiModel || e.aiModel?.startsWith(m.id));
    const parts = [
      `Logged ${formatDateTime(e.createdAt)}`,
      { photo: 'Photo', upload: 'Upload', voice: 'Voice/typed', manual: 'Entered by hand' }[e.source],
      e.aiModel ? `Read by ${model ? model.detail.split(' · ')[0] : e.aiModel}` : null,
      sheetsConnected() ? (e.sheet?.syncedAt && !e.sheet.dirty ? 'Saved to Google Sheets' : 'Not yet in Google Sheets') : null,
      e.exportedAt ? `Exported ${formatDateTime(e.exportedAt)}` : null,
    ].filter(Boolean);
    return h('p', { class: 'tiny muted center', style: { marginTop: '16px' } }, parts.join(' · '));
  }

  async function render() {
    const e = entry;
    const ready = e.aiStatus === 'done' || e.aiStatus === 'skipped' || e.aiStatus === 'error';
    const more = h('button', { class: 'icon-btn', 'aria-label': 'More', onclick: moreMenu }, h('span', { style: { fontSize: '22px', lineHeight: 1 } }, '•••'));
    fill(el, 
      topbar({ title: e.fields.vendor && ready ? e.fields.vendor : 'Expense', back: goBack, actions: [more] }),
      h('div', { class: 'stack' },
        await preview(),
        statusBlock(),
        ready ? form() : null,
        ready ? h('button', { class: 'btn primary block', onclick: done }, icon('check'), 'Done') : null,
        meta(),
      ),
    );
  }

  async function flush() {
    if (Object.keys(pending).length) await save.flush({ ...pending });
  }

  async function done() {
    await flush();
    await updateEntry(id, (e) => { e.reviewed = true; });
    goBack();
  }

  async function markReviewed() {
    await flush();
    entry = await updateEntry(id, (e) => { e.reviewed = true; });
    toast('Marked as reviewed');
    await render();
  }

  async function retry() {
    await requeue(id);
    kick();
  }

  async function fillByHand() {
    entry = await updateEntry(id, (e) => { e.aiStatus = 'skipped'; e.reviewed = true; });
    shownStatus = entry.aiStatus;
    await render();
  }

  async function moreMenu() {
    const options = [];
    if (entry.fileId || entry.inputText) options.push({ label: 'Read again with AI', value: 'reread', icon: 'sparkle', hint: 'Replaces the details with a fresh reading' });
    if (hasReceipt(entry)) options.push({ label: 'Share receipt', value: 'share', icon: 'share' });
    options.push({ label: 'Delete expense', value: 'delete', icon: 'trash', danger: true });
    const pick = await choiceSheet({ title: 'Expense options', options });
    if (pick === 'reread') {
      await flush();
      await retry();
    } else if (pick === 'share') {
      await deliverFiles(await receiptFiles([entry]), 'Receipt');
    } else if (pick === 'delete') {
      const ok = await confirmSheet({
        title: 'Delete this expense?',
        message: `${entry.fields.vendor || 'This expense'}${entry.fields.total ? ` (${formatMoney(entry.fields.total, entry.fields.currency)})` : ''} and its receipt will be removed from this phone${sheetsConnected() ? ' and your Google Sheet' : ''}.`,
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await removeEntry(id);
      toast('Deleted');
      goBack();
    }
  }

  load();
  const off = on('entries-changed', async (d) => {
    if (d?.id !== id) return;
    if (d.deleted) return;
    const latest = await getEntry(id);
    if (!latest) return;
    entry = latest;
    // Only rebuild when the AI status changes, so typing is never interrupted.
    if (latest.aiStatus !== shownStatus) {
      shownStatus = latest.aiStatus;
      await render();
    }
  });
  const offQueue = on('queue-changed', async () => {
    if (entry && entry.aiStatus === 'queued') await render();
  });

  return {
    el,
    async destroy() {
      off();
      offQueue();
      await flush();
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      // A "by hand" entry abandoned before anything was typed shouldn't linger as a blank $0 row.
      if (isNew && !edited) {
        const e = await getEntry(id);
        if (e && !e.fields.vendor && !e.fields.total && !e.fields.description) await removeEntry(id);
      }
    },
  };
}
