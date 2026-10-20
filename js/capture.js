// The ways an expense gets into the app: camera, photo library / Files upload, voice or typing, and by hand.

import { createEntry } from './entries.js';
import { prepareImage } from './image.js';
import { kick } from './queue.js';
import { settings } from './settings.js';
import { voiceEnabled } from './speech.js';
import { startTalk } from './talk.js';
import { openSheet, toast } from './ui.js';
import { h, icon } from './util.js';

const MAX_PDF_BYTES = 20 * 1024 * 1024;

function savedToast(count = 1) {
  const what = count === 1 ? 'Saved' : `${count} saved`;
  toast(navigator.onLine ? `${what}. Reading it now…` : `${what}. It'll be read when you're back online.`);
}

async function prepare(file) {
  if (file.type === 'application/pdf') {
    if (file.size > MAX_PDF_BYTES) throw new Error('That PDF is too large (over 20 MB).');
    return { blob: file, thumb: null };
  }
  return prepareImage(file);
}

function pickFiles(inputId, onFiles) {
  const input = document.getElementById(inputId);
  input.value = '';
  input.onchange = () => {
    const files = [...(input.files || [])];
    if (files.length) onFiles(files);
  };
  input.click();
}

export function startScan() {
  pickFiles('camera-input', async ([file]) => {
    try {
      const { blob, thumb } = await prepare(file);
      if (settings().askNoteAfterScan) {
        noteSheet(async (note) => {
          await createEntry({ source: 'photo', file: blob, thumb, userNote: note });
          savedToast();
          kick();
        });
      } else {
        await createEntry({ source: 'photo', file: blob, thumb });
        savedToast();
        kick();
      }
    } catch (err) {
      toast(err.message || 'That photo could not be saved.', { error: true });
    }
  });
}

export function startUpload() {
  pickFiles('upload-input', async (files) => {
    let saved = 0;
    for (const file of files) {
      try {
        const { blob, thumb } = await prepare(file);
        await createEntry({ source: 'upload', file: blob, thumb });
        saved++;
      } catch (err) {
        toast(`${file.name}: ${err.message}`, { error: true });
      }
    }
    if (saved) {
      savedToast(saved);
      kick();
    }
  });
}

function noteSheet(onDone) {
  const ta = h('textarea', { class: 'textarea', rows: 3, placeholder: 'e.g. Lunch with the Smith job crew', autocapitalize: 'sentences' });
  let done = false;
  const finish = (close, note) => {
    if (done) return;
    done = true;
    close();
    onDone(note);
  };
  openSheet((close) => h('div', { class: 'stack' },
    h('h3', null, 'Add a note?'),
    h('p', { class: 'muted small' }, 'Optional. Anything the receipt doesn\'t say, like who it was with or which job it was for.'),
    ta,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => finish(close, '') }, 'Skip'),
      h('button', { class: 'btn primary', onclick: () => finish(close, ta.value.trim()) }, 'Save'),
    ),
  ), { onClose: () => { if (!done) { done = true; onDone(''); } } });
  ta.focus();
}

// With a voice key: a hands-free conversation. Without one: type or use the keyboard's dictation mic.
export function openSpeakSheet() {
  if (voiceEnabled()) startTalk({ onUseKeyboard: (said) => openDictationSheet(said) });
  else openDictationSheet();
}

export function openDictationSheet(prefill = '') {
  const ta = h('textarea', {
    class: 'textarea',
    rows: 4,
    autocapitalize: 'sentences',
    placeholder: 'e.g. "$42.18 at Home Depot for lumber, paid with the business card"',
  });
  ta.value = prefill;
  const save = async (close) => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    close();
    await createEntry({ source: 'voice', inputText: text });
    savedToast();
    kick();
  };
  openSheet((close) => h('div', { class: 'stack' },
    h('h3', null, 'Say or type an expense'),
    h('p', { class: 'muted small' },
      'Tap the ', h('span', { style: { display: 'inline-flex', verticalAlign: '-3px' } }, icon('mic')),
      ' on your keyboard and just talk. You can list several expenses at once.'),
    ta,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => save(close) }, 'Save'),
    ),
    voiceEnabled() ? null : h('button', {
      class: 'btn ghost small',
      onclick: () => { close(); location.hash = '#/settings/ai'; },
    }, icon('sparkle'), 'Want to just talk to it? Set up voice conversations'),
  ));
  ta.focus();
}

export async function addManually() {
  const entry = await createEntry({ source: 'manual', fields: {} });
  location.hash = `#/entry/${entry.id}?new=1`;
}
