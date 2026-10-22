// Shared UI pieces: toasts, bottom sheets, confirm/prompt dialogs, list editors, image viewer.

import { h, icon, navBack } from './util.js';

export function toast(message, { error = false, ms = error ? 7000 : 2600 } = {}) {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: 'toast' + (error ? ' error' : ''), role: 'status' }, icon(error ? 'alert' : 'check'), message);
  root.append(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// Opens a bottom sheet. build(close) returns the sheet's content. Returns close().
export function openSheet(build, { onClose } = {}) {
  const root = document.getElementById('sheet-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    if (!root.children.length) document.body.classList.remove('sheet-open');
    onClose?.();
  };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grabber' }));
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, sheet);

  // Drag down to close, starting anywhere while the sheet is scrolled to the top.
  // A drag that starts upward scrolls the sheet's content instead.
  let startY = null;
  let dy = 0;
  const settle = (to, then) => {
    sheet.style.transition = 'transform .2s ease-out';
    sheet.style.transform = to;
    setTimeout(() => { sheet.style.transition = ''; then?.(); }, 200);
  };
  sheet.addEventListener('touchstart', (e) => {
    startY = sheet.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
    dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dy = e.touches[0].clientY - startY;
    if (dy < 0 && !sheet.style.transform) { startY = null; return; }
    e.preventDefault();
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  sheet.addEventListener('touchend', () => {
    if (startY === null) return;
    startY = null;
    if (dy > 90) settle('translateY(100%)', close);
    else if (sheet.style.transform) settle('', () => { sheet.style.transform = ''; });
  });
  // Touches on the dimmed area never scroll the page behind.
  backdrop.addEventListener('touchmove', (e) => { if (!sheet.contains(e.target)) e.preventDefault(); }, { passive: false });

  sheet.append(build(close));
  root.append(backdrop);
  document.body.classList.add('sheet-open');
  return close;
}

export function confirmSheet({ title, message, confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v, close) => { answered = true; close(); resolve(v); };
    openSheet((close) => h('div', { class: 'stack' },
      h('h3', null, title),
      message ? h('p', { class: 'muted' }, message) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => answer(false, close) }, cancelText),
        h('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), onclick: () => answer(true, close) }, confirmText),
      ),
    ), { onClose: () => { if (!answered) resolve(false); } });
  });
}

export function promptSheet({ title, message, value = '', placeholder = '', confirmText = 'Save', inputType = 'text' }) {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', { class: 'input', type: inputType, value, placeholder, autocapitalize: 'words', enterkeyhint: 'done' });
    const submit = (close) => {
      const v = input.value.trim();
      if (!v) return input.focus();
      answered = true;
      close();
      resolve(v);
    };
    openSheet((close) => {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(close); });
      return h('div', { class: 'stack' },
        h('h3', null, title),
        message ? h('p', { class: 'muted small' }, message) : null,
        input,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => { answered = true; close(); resolve(null); } }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => submit(close) }, confirmText),
        ),
      );
    }, { onClose: () => { if (!answered) resolve(null); } });
    input.focus();
  });
}

export function choiceSheet({ title, options }) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet((close) => h('div', { class: 'stack' },
      h('h3', null, title),
      h('div', { class: 'list' }, options.map((o) => h('button', {
        class: 'list-item',
        style: o.danger ? { color: 'var(--danger)' } : null,
        onclick: () => { answered = true; close(); resolve(o.value); },
      }, o.icon ? icon(o.icon) : null, h('div', { class: 'grow' }, h('div', null, o.label), o.hint ? h('div', { class: 'tiny muted' }, o.hint) : null),
      o.selected ? icon('check') : null))),
      h('button', { class: 'btn block', onclick: () => { answered = true; close(); resolve(null); } }, 'Cancel'),
    ), { onClose: () => { if (!answered) resolve(null); } });
  });
}

// Editable list of names (categories, payment methods). onChange receives the new array,
// plus { renamed: [from, to] } or { removed: name } so callers can update existing entries.
export function nameListEditor({ items, onChange, addLabel = 'Add', placeholder = 'New item', noun = 'item' }) {
  const wrap = h('div', { class: 'stack' });
  const render = () => {
    wrap.replaceChildren(
      items.length
        ? h('div', { class: 'list' }, items.map((name, i) => h('div', { class: 'list-item' },
          h('button', {
            class: 'grow', style: { border: 0, background: 'none', textAlign: 'left', padding: 0 },
            onclick: async () => {
              const next = await promptSheet({ title: `Rename ${noun}`, value: name });
              if (!next || next === name || items.includes(next)) return;
              items = items.map((x, j) => (j === i ? next : x));
              await onChange(items, { renamed: [name, next] });
              render();
            },
          }, name),
          h('button', {
            class: 'icon-btn', 'aria-label': `Remove ${name}`,
            onclick: async () => {
              items = items.filter((_, j) => j !== i);
              await onChange(items, { removed: name });
              render();
            },
          }, icon('x')),
        )))
        : h('div', { class: 'card pad muted small center' }, `No ${noun}s yet.`),
      h('button', {
        class: 'btn block',
        onclick: async () => {
          const name = await promptSheet({ title: addLabel, placeholder });
          if (!name || items.includes(name)) return;
          items = [...items, name];
          await onChange(items, {});
          render();
        },
      }, icon('plus'), addLabel),
    );
  };
  render();
  return wrap;
}

// Chip-style editor used in setup, where a quick tap-to-remove feels lighter than a list.
export function tagEditor({ items, onChange, placeholder = 'Add another' }) {
  const wrap = h('div', { class: 'stack' });
  const input = h('input', { class: 'input', placeholder, enterkeyhint: 'done', autocapitalize: 'words' });
  const add = () => {
    const v = input.value.trim();
    if (!v || items.includes(v)) { input.value = ''; return; }
    items = [...items, v];
    input.value = '';
    onChange(items);
    render();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const tags = h('div', { class: 'tags' });
  const render = () => {
    tags.replaceChildren(...items.map((name) => h('span', { class: 'tag' }, name,
      h('button', { 'aria-label': `Remove ${name}`, onclick: () => { items = items.filter((x) => x !== name); onChange(items); render(); } }, icon('x')))));
  };
  render();
  wrap.append(tags, h('div', { class: 'input-group' }, input, h('button', { class: 'btn', onclick: add }, 'Add')));
  wrap.setItems = (next) => { items = [...next]; render(); };
  return wrap;
}

export function toggleRow({ label, hint, checked, onChange }) {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
  return h('label', { class: 'toggle-row' },
    h('div', { class: 'grow' }, h('div', null, label), hint ? h('div', { class: 'tiny muted' }, hint) : null),
    h('span', { class: 'switch' }, input, h('span')),
  );
}

export function choiceList({ options, value, onChange }) {
  const wrap = h('div', { class: 'choices' });
  const render = () => {
    wrap.replaceChildren(...options.map((o) => h('button', {
      class: 'choice' + (o.id === value ? ' selected' : ''),
      onclick: () => { value = o.id; onChange(o.id); render(); },
    }, h('span', { class: 'radio' }), h('div', null, h('strong', null, o.name), o.hint ? h('span', null, o.hint) : null))));
  };
  render();
  return wrap;
}

export function imageViewer(url) {
  const close = () => viewer.remove();
  const viewer = h('div', { class: 'viewer', onclick: (e) => { if (e.target === viewer) close(); } },
    h('img', { src: url, alt: 'Receipt' }),
    h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x')),
  );
  document.body.append(viewer);
}

export function topbar({ title, back, actions = [] }) {
  return h('header', { class: 'topbar' },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => (typeof back === 'function' ? back() : navBack()) }, icon('back')) : null,
    h('h1', { class: back ? 'title-center' : '' }, title),
    ...actions,
    back && !actions.length ? h('span', { style: { width: '44px' } }) : null,
  );
}

export function field(labelText, control, hint) {
  return h('div', { class: 'field' }, h('label', null, labelText), control, hint ? h('div', { class: 'hint' }, hint) : null);
}
