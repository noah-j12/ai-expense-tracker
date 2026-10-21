import { addManually, openSpeakSheet, startScan, startUpload } from '../capture.js';
import { kvGet, kvSet } from '../db.js';
import { displayTitle, entryState, listEntries, needsAttention } from '../entries.js';
import { queueState } from '../queue.js';
import { businessName, hasMultipleBusinesses, settings, updateSettings } from '../settings.js';
import { sheetsConnected, sheetsLinked, sheetsState } from '../sheets.js';
import { voiceEnabled, voiceMode } from '../speech.js';
import { choiceSheet } from '../ui.js';
import { formatDate, formatMoney, fill, h, icon, isIOS, isStandalone, on, shareGlyph, toISODate } from '../util.js';

const PAGE = 40;

export function entryRow(e) {
  const st = entryState(e);
  const f = e.fields;
  const thumb = e.thumb
    ? h('div', { class: 'thumb', style: { backgroundImage: `url("${e.thumb}")` } })
    : h('div', { class: 'thumb' }, icon(e.source === 'voice' ? 'mic' : e.source === 'manual' ? 'pen' : 'file'));
  const pending = e.aiStatus === 'queued' || e.aiStatus === 'processing';
  const sub = pending
    ? (e.aiStatus === 'processing' ? 'AI is reading this…' : 'Waiting to be read')
    : [f.category || 'Uncategorized', formatDate(f.date), hasMultipleBusinesses() ? businessName(e.businessId) : null].filter(Boolean).join(' · ');
  return h('button', { class: 'entry-row', onclick: () => { location.hash = `#/entry/${e.id}`; } },
    thumb,
    h('div', { class: 'grow' }, h('div', { class: 'title' }, displayTitle(e)), h('div', { class: 'sub' }, sub)),
    h('div', { class: 'amount num' },
      pending ? h('span', { class: 'muted' }, '—') : formatMoney(f.total, f.currency),
      st ? h('div', null, h('span', { class: 'chip ' + st.cls }, icon(st.icon), st.label)) : null,
    ),
  );
}

function monthTotals(entries) {
  const s = settings();
  const ym = toISODate().slice(0, 7);
  const mine = entries.filter((e) => (e.aiStatus === 'done' || e.aiStatus === 'skipped')
    && (e.fields.date || '').startsWith(ym)
    && (!hasMultipleBusinesses() || e.businessId === s.activeBusinessId));
  // Sum in the default currency only; mixed currencies are rare and summing them would mislead.
  const total = mine.filter((e) => e.fields.currency === s.currency).reduce((sum, e) => sum + (Number(e.fields.total) || 0), 0);
  return { total, count: mine.length };
}

export function HomeView() {
  const s = settings();
  const el = h('div', { class: 'page' });
  const dynamic = h('div');
  const listWrap = h('div');
  let entries = [];
  let query = '';
  let shown = PAGE;
  let installDismissed = true;

  const searchInput = h('input', { type: 'search', placeholder: 'Search expenses', enterkeyhint: 'search', autocomplete: 'off' });
  searchInput.addEventListener('input', () => { query = searchInput.value.trim().toLowerCase(); shown = PAGE; renderList(); });

  el.append(
    h('header', { class: 'topbar' },
      h('h1', null, 'AI Expense Tracker'),
      h('button', { class: 'icon-btn', 'aria-label': 'Export', onclick: () => { location.hash = '#/export'; } }, icon('share')),
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => { location.hash = '#/settings'; } }, icon('gear')),
    ),
    dynamic,
    h('div', { class: 'actions' },
      h('button', { class: 'big-action', onclick: startScan },
        h('span', { class: 'bubble' }, icon('camera')),
        h('div', null, h('strong', null, 'Scan Receipt'), h('span', null, 'Snap a photo and you\'re done'))),
      h('button', { class: 'big-action secondary', onclick: openSpeakSheet },
        h('span', { class: 'bubble' }, icon('mic')),
        voiceEnabled()
          ? h('div', null, h('strong', null, 'Talk to It'), h('span', null, voiceMode() === 'live' ? 'Have a quick conversation' : 'Just tell it what you bought'))
          : h('div', null, h('strong', null, 'Say or Type It'), h('span', null, '"$40 gas at Shell, business card"'))),
    ),
    h('div', { class: 'mini-actions' },
      h('button', { class: 'btn ghost small', onclick: startUpload }, icon('upload'), 'Upload photo or PDF'),
      h('button', { class: 'btn ghost small', onclick: addManually }, icon('pen'), 'Add by hand'),
    ),
    listWrap,
  );

  function banners() {
    const out = [];
    if (!installDismissed && isIOS() && !isStandalone()) {
      out.push(h('div', { class: 'banner ok' }, icon('phone'),
        h('div', { class: 'body' }, h('b', null, 'Add to your Home Screen'), h('div', null, 'Tap ', shareGlyph(), ' below, then "Add to Home Screen". It opens like a normal app and works offline.')),
        h('button', { class: 'icon-btn', style: { width: '32px', height: '32px' }, 'aria-label': 'Dismiss', onclick: async () => { installDismissed = true; await kvSet('installDismissed', true); render(); } }, icon('x'))));
    }
    if (queueState.blocked) {
      out.push(h('div', { class: 'banner danger' }, icon('key'), h('div', { class: 'body' }, queueState.blocked,
        h('div', null, h('button', { class: 'btn small', onclick: () => { location.hash = '#/settings/ai'; } }, 'Open AI settings')))));
    }
    const waiting = entries.filter((e) => e.aiStatus === 'queued').length;
    if (waiting && (queueState.offline || !navigator.onLine) && !queueState.blocked) {
      out.push(h('div', { class: 'banner' }, icon('cloudOff'), h('div', { class: 'body' },
        h('b', null, `${waiting} waiting`), ` to be read. ${waiting === 1 ? 'It' : 'They'}'ll go through when you're back online. Nothing is lost.`)));
    }
    if (sheetsLinked() && !sheetsConnected()) {
      out.push(h('div', { class: 'banner warn' }, icon('sheet'), h('div', { class: 'body' },
        h('b', null, 'Google Sheets isn\'t finished. '), 'Expenses won\'t go into your sheet until you pick the tab and columns.',
        h('div', null, h('button', { class: 'btn small', onclick: () => { location.hash = '#/settings/sheets'; } }, 'Finish setup')))));
    }
    if (sheetsConnected() && sheetsState.error) {
      out.push(h('div', { class: 'banner warn' }, icon('sheet'), h('div', { class: 'body' }, h('b', null, 'Google Sheets: '), sheetsState.error,
        h('div', null, h('button', { class: 'btn small', onclick: () => { location.hash = '#/settings/sheets'; } }, 'Check connection')))));
    }
    return out;
  }

  function render() {
    const cur = settings();
    const { total, count } = monthTotals(entries);
    const review = entries.filter(needsAttention);
    const monthName = new Date().toLocaleDateString(undefined, { month: 'long' });

    fill(dynamic, 
      hasMultipleBusinesses()
        ? h('button', {
          class: 'business-pill',
          onclick: async () => {
            const id = await choiceSheet({
              title: 'Log expenses to…',
              options: cur.businesses.map((b) => ({ label: businessName(b.id), value: b.id, selected: b.id === cur.activeBusinessId, icon: 'building' })),
            });
            if (id) await updateSettings({ activeBusinessId: id });
          },
        }, icon('building'), h('span', { class: 'muted' }, 'Logging to'), h('b', null, businessName(cur.activeBusinessId)), icon('down'))
        : null,
      ...banners(),
    );

    const summary = h('div', { class: 'summary' },
      h('div', { class: 'card' }, h('div', { class: 'label' }, monthName), h('div', { class: 'big num' }, formatMoney(total, cur.currency)),
        h('div', { class: 'tiny muted' }, `${count} expense${count === 1 ? '' : 's'}`)),
      h('div', { class: 'card' }, h('div', { class: 'label' }, 'To review'), h('div', { class: 'big num' }, String(review.length)),
        h('div', { class: 'tiny muted' }, review.length ? 'Tap one below' : 'All clear')),
    );

    fill(listWrap, 
      summary,
      review.length ? h('div', null, h('div', { class: 'section-title' }, 'Needs your review'), h('div', { class: 'list' }, review.slice(0, 10).map(entryRow))) : null,
      h('div', { class: 'section-title' }, 'Recent'),
      entries.length > 5 ? h('label', { class: 'search' }, icon('search'), searchInput) : null,
      h('div', { id: 'recent-list' }),
    );
    renderList();
  }

  function renderList() {
    const target = listWrap.querySelector('#recent-list');
    if (!target) return;
    const matches = query
      ? entries.filter((e) => [e.fields.vendor, e.fields.description, e.fields.category, e.fields.notes, e.inputText, e.fields.paymentMethod, String(e.fields.total)]
        .some((v) => (v || '').toLowerCase().includes(query)))
      : entries;
    if (!entries.length) {
      fill(target, h('div', { class: 'card empty' }, icon('receipt'),
        h('div', null, h('b', null, 'No expenses yet')),
        h('div', { class: 'small' }, 'Scan your first receipt above. The AI fills in the vendor, amount, date and category for you.')));
      return;
    }
    if (!matches.length) {
      fill(target, h('div', { class: 'card empty small' }, `Nothing matches "${query}".`));
      return;
    }
    fill(target, 
      h('div', { class: 'list' }, matches.slice(0, shown).map(entryRow)),
      matches.length > shown
        ? h('button', { class: 'btn block', style: { marginTop: '10px' }, onclick: () => { shown += PAGE; renderList(); } }, `Show more (${matches.length - shown})`)
        : null,
    );
  }

  async function load() {
    entries = await listEntries();
    render();
  }

  kvGet('installDismissed').then((v) => { installDismissed = Boolean(v); render(); });
  load();
  const offs = [
    on('entries-changed', load),
    on('queue-changed', render),
    on('settings-changed', render),
    on('sheets-changed', render),
  ];
  const onNet = () => render();
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  return {
    el,
    destroy() {
      offs.forEach((off) => off());
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
    },
  };
}
