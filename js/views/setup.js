// First-run setup. Each step asks one thing, has a sensible default, and can be changed later in Settings.

import { MODELS, testApiKey } from '../ai.js';
import { restoreBackup } from '../exporter.js';
import { kick } from '../queue.js';
import { CATEGORY_PRESETS, DEFAULT_PAYMENT_METHODS, EXPORT_FORMATS, replaceSettings, settings } from '../settings.js';
import { choiceList, field, tagEditor, toast } from '../ui.js';
import { h, icon, isIOS, isStandalone, shareGlyph } from '../util.js';
import { VOICE_MODES } from '../speech.js';
import { voiceChooser } from './voice-setup.js';

export const CONSOLE_URL = 'https://console.anthropic.com/';

export function apiKeySteps() {
  return h('ol', { class: 'steps' },
    h('li', null, h('div', null, 'Go to ', h('a', { href: CONSOLE_URL, target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), ' and create a free account.')),
    h('li', null, h('div', null, 'Under ', h('b', null, 'Billing'), ', add a card and buy a small amount of credit ($5 lasts a long time). Setting a monthly spend limit there is a good idea.')),
    h('li', null, h('div', null, 'Under ', h('b', null, 'API Keys'), ', create a key and copy it.')),
    h('li', null, h('div', null, 'Paste it below.')),
  );
}

export function apiKeyInput(value) {
  const input = h('input', { class: 'input', type: 'password', value, placeholder: 'sk-ant-…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const toggle = h('button', { class: 'btn', type: 'button', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; toggle.textContent = input.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
  return { input, row: h('div', { class: 'input-group' }, input, toggle) };
}

export function SetupView() {
  const draft = structuredClone(settings());
  const el = h('div', { class: 'page' });
  let step = 0;
  // Where expenses end up: 'excel' | 'sheets' | an export format id | 'later'.
  let destination = 'later';

  const steps = [welcome, categories, payments, books, ai, voice, finish];

  function frame({ title, lead, content, next = 'Continue', onNext, skip, hideBack }) {
    const nextBtn = h('button', { class: 'btn primary', onclick: async () => {
      nextBtn.disabled = true;
      try {
        if (onNext && (await onNext()) === false) return;
        go(step + 1);
      } finally {
        nextBtn.disabled = false;
      }
    } }, next);
    return h('div', { class: 'setup' },
      step > 0 ? h('div', { class: 'progress' }, steps.slice(1).map((_, i) => h('i', { class: i < step ? 'on' : '' }))) : null,
      h('h2', null, title),
      lead ? h('p', { class: 'lead' }, lead) : null,
      h('div', { class: 'content' }, content),
      h('div', { class: 'footer' },
        step > 0 && !hideBack ? h('button', { class: 'btn', onclick: () => go(step - 1) }, 'Back') : null,
        skip ? h('button', { class: 'btn ghost', onclick: () => go(step + 1) }, skip) : null,
        nextBtn,
      ),
    );
  }

  function go(n) {
    step = Math.max(0, Math.min(steps.length - 1, n));
    el.replaceChildren(steps[step]());
    window.scrollTo(0, 0);
  }

  function welcome() {
    const restoreInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    restoreInput.addEventListener('change', async () => {
      const file = restoreInput.files?.[0];
      if (!file) return;
      try {
        const count = await restoreBackup(file);
        toast(`Restored ${count} expenses`);
        location.hash = '#/';
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
    return h('div', { class: 'setup' },
      h('img', { class: 'hero-icon', src: 'icons/icon-192.png', alt: '' }),
      h('h2', null, 'Expenses, handled.'),
      h('p', { class: 'lead' }, 'Snap a receipt or just say what you spent. AI fills in the vendor, amount, date and category, and keeps it all ready for your books.'),
      h('div', { class: 'content' },
        h('div', { class: 'list' },
          h('div', { class: 'list-item' }, icon('camera'), h('div', null, h('b', null, 'Scan or speak'), h('div', { class: 'small muted' }, 'One tap, then get on with your day.'))),
          h('div', { class: 'list-item' }, icon('cloudOff'), h('div', null, h('b', null, 'Works offline'), h('div', { class: 'small muted' }, 'Entries wait safely until you have signal.'))),
          h('div', { class: 'list-item' }, icon('sheet'), h('div', null, h('b', null, 'Ready for your accountant'), h('div', { class: 'small muted' }, 'Goes into Excel or Google Sheets, or a spreadsheet for whoever does your books.'))),
        ),
        h('p', { class: 'small muted' }, 'Setup takes about two minutes. You can change anything later.'),
      ),
      h('div', { class: 'footer', style: { flexDirection: 'column' } },
        h('button', { class: 'btn primary block', onclick: () => go(1) }, 'Get started'),
        h('button', { class: 'btn ghost block', onclick: () => restoreInput.click() }, 'Restore from a backup'),
        restoreInput,
      ),
    );
  }

  function categories() {
    const editor = tagEditor({ items: draft.categories, placeholder: 'Add a category', onChange: (items) => { draft.categories = items; } });
    const presets = choiceList({
      options: CATEGORY_PRESETS,
      value: draft.categoryPreset,
      onChange: (id) => {
        draft.categoryPreset = id;
        draft.categories = [...CATEGORY_PRESETS.find((p) => p.id === id).categories];
        editor.setItems(draft.categories);
      },
    });
    return frame({
      title: 'Expense categories',
      lead: 'Pick a starting list. The AI sorts each expense into one of these. If your accountant uses specific categories, use theirs.',
      content: [presets, h('div', { class: 'section-title', style: { margin: '8px 4px 0' } }, 'Your categories, tap × to remove'), editor],
    });
  }

  function payments() {
    const editor = tagEditor({ items: draft.paymentMethods, placeholder: 'e.g. Amex ending 1004', onChange: (items) => { draft.paymentMethods = items; } });
    return frame({
      title: 'How do you pay?',
      lead: 'The AI matches the receipt to one of these. Adding the last 4 digits of each card makes the match more accurate.',
      content: [editor, h('button', { class: 'btn ghost', onclick: () => { draft.paymentMethods = [...DEFAULT_PAYMENT_METHODS]; editor.setItems(draft.paymentMethods); } }, 'Reset to defaults')],
    });
  }

  function books() {
    const options = [
      { id: 'excel', name: 'Excel', hint: 'Add to a workbook you already have, or start one' },
      { id: 'sheets', name: 'Google Sheets', hint: 'Expenses appear in your sheet automatically' },
      ...EXPORT_FORMATS.filter((f) => f.id !== 'csv').map((f) => ({ id: f.id, name: f.name, hint: 'Export a file to import' })),
      { id: 'csv', name: 'My accountant / something else', hint: 'Export a spreadsheet whenever you need one' },
      { id: 'later', name: 'Not sure yet', hint: 'Keep expenses on this phone and decide later' },
    ];
    return frame({
      title: 'Where do you keep your books?',
      lead: 'Expenses are always saved on this phone. This is where they go from there. You can add or change it later.',
      content: choiceList({
        options,
        value: destination,
        onChange: (id) => {
          destination = id;
          draft.exportFormat = ['excel', 'sheets', 'later'].includes(id) ? 'csv' : id;
        },
      }),
    });
  }

  function ai() {
    const { input, row } = apiKeyInput(draft.ai.apiKey);
    const status = h('div', { class: 'small' });
    const models = choiceList({
      options: MODELS.map((m) => ({ id: m.id, name: m.name, hint: m.detail })),
      value: draft.ai.model,
      onChange: (id) => { draft.ai.model = id; },
    });
    return frame({
      title: 'Connect the AI',
      lead: 'The app uses Claude, an AI from Anthropic, to read receipts. You pay Anthropic directly for what you use, usually a few cents a receipt. There\'s no subscription and no markup.',
      content: [
        apiKeySteps(),
        field('Your API key', row),
        status,
        h('details', null, h('summary', { class: 'small', style: { fontWeight: 600, color: 'var(--muted)', marginBottom: '10px' } }, 'Accuracy vs. cost'), models),
        h('p', { class: 'tiny muted' }, 'Your key is stored only on this phone and is sent only to Anthropic.'),
      ],
      next: 'Continue',
      skip: 'Skip for now',
      onNext: async () => {
        const key = input.value.trim();
        // Only keep a key once it has been checked, so a mistyped key + "Skip" doesn't stick.
        if (!key) {
          status.replaceChildren(h('span', { class: 'muted' }, 'Paste a key, or tap "Skip for now". Entries will wait until a key is added.'));
          return false;
        }
        status.replaceChildren(h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Checking your key…'));
        const res = await testApiKey(key, draft.ai.model);
        if (!res.ok) {
          status.replaceChildren(h('span', { style: { color: 'var(--danger)' } }, res.message));
          return false;
        }
        draft.ai.apiKey = key;
        toast('Key works. AI connected.');
        return true;
      },
    });
  }

  function voice() {
    return frame({
      title: 'How do you want to talk to it?',
      lead: 'For logging an expense by voice instead of a photo. You can change this anytime in Settings.',
      content: voiceChooser({ read: () => draft.voice, write: (fn) => fn(draft.voice), model: () => draft.ai.model }),
    });
  }

  function finish() {
    const installHelp = isIOS() && !isStandalone()
      ? h('div', { class: 'card pad stack' },
        h('b', null, 'One last thing: put it on your Home Screen'),
        h('ol', { class: 'steps' },
          h('li', null, h('div', null, 'Tap ', shareGlyph(), ' at the bottom of Safari.')),
          h('li', null, h('div', null, 'Scroll down and tap ', h('b', null, 'Add to Home Screen'), '.')),
          h('li', null, h('div', null, 'Open it from the new icon. It works offline from there.'))))
      : null;
    const where = {
      excel: 'Next: connect your Excel workbook',
      sheets: 'Next: connect your Google Sheet',
      later: 'Saved on this phone; export or connect a spreadsheet anytime',
    }[destination] || `Exports for ${EXPORT_FORMATS.find((f) => f.id === destination)?.name}`;
    const nextRoute = { excel: '#/settings/excel', sheets: '#/settings/sheets' }[destination] || '#/';
    return frame({
      title: 'You\'re all set',
      lead: draft.ai.apiKey
        ? 'Tap Scan Receipt any time you buy something. That\'s it.'
        : 'You can start scanning now. Add your AI key in Settings and everything you\'ve saved will be read.',
      content: [
        installHelp,
        h('div', { class: 'list' },
          h('div', { class: 'list-item' }, icon('tag'), h('div', { class: 'grow' }, `${draft.categories.length} categories`)),
          h('div', { class: 'list-item' }, icon('share'), h('div', { class: 'grow' }, where)),
          h('div', { class: 'list-item' }, icon('key'), h('div', { class: 'grow' }, draft.ai.apiKey ? 'AI connected' : 'AI not connected yet')),
          h('div', { class: 'list-item' }, icon('mic'), h('div', { class: 'grow' }, `Voice: ${VOICE_MODES.find((m) => m.id === (draft.voice.openaiKey ? draft.voice.mode : 'keyboard'))?.name}`)),
        ),
        h('p', { class: 'small muted' }, 'Running more than one business, or tracking personal spending separately? Add separate books in Settings → Books.'),
      ],
      next: nextRoute === '#/' ? 'Start using the app' : 'Continue',
      onNext: async () => {
        draft.setupDone = true;
        await replaceSettings(draft);
        kick();
        location.hash = nextRoute;
        return false;
      },
    });
  }

  go(0);
  return { el };
}
