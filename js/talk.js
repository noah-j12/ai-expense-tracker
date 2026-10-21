// Hands-free voice conversation for logging an expense: listen -> transcribe -> Claude -> (ask out loud) -> repeat.
// On a problem it says what happened and offers choices; it never switches to another mode by itself.

import { talkTurn } from './ai.js';
import { applyAIResult, createEntry } from './entries.js';
import { kick } from './queue.js';
import { MicError, prepareAudio, recordTurn, releaseAudio, speak, stopSpeaking, transcribeWithRetry } from './speech.js';
import { toast } from './ui.js';
import { fill, formatMoney, h, icon } from './util.js';

// A safety stop so a confused conversation can't go on forever; it then logs what it has.
const MAX_USER_TURNS = 5;

export function startTalk({ onUseKeyboard }) {
  // Must happen during the tap that opened this screen (iOS rule), so the AI voice can play later.
  prepareAudio();

  const createdAt = Date.now();
  const turns = []; // { role: 'user' | 'assistant', text }
  let closed = false;
  let recording = null; // AbortController for the current recording
  let quietRetries = 0;

  const orb = h('div', { class: 'talk-orb' }, icon('mic'));
  const status = h('div', { class: 'talk-status' });
  const log = h('div', { class: 'talk-log' });
  const actions = h('div', { class: 'talk-actions' });
  const root = h('div', { class: 'talk', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Voice conversation' },
    h('div', { class: 'talk-top' }, h('span', { class: 'small muted' }, 'Voice'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: cancel }, icon('x'))),
    log,
    h('div', { class: 'talk-center' }, orb, status),
    actions);
  document.body.append(root);

  const userText = () => turns.filter((t) => t.role === 'user' && !t.meta).map((t) => t.text).join('\n');

  function setPhase(phase, text, buttons) {
    root.dataset.phase = phase;
    status.textContent = text;
    const defaults = {
      listening: [
        h('button', { class: 'btn primary block', onclick: () => recording?.abort() }, icon('check'), 'I\'m done talking'),
        h('button', { class: 'btn ghost small', onclick: useKeyboard }, 'Type instead'),
      ],
      thinking: [h('button', { class: 'btn ghost', onclick: cancel }, 'Cancel')],
      speaking: [h('button', { class: 'btn block', onclick: stopSpeaking }, 'Skip')],
      done: [],
    };
    fill(actions, ...(buttons || defaults[phase] || []));
  }

  function bubble(role, text) {
    log.append(h('div', { class: `bubble ${role}` }, text));
    log.scrollTop = log.scrollHeight;
  }

  function errorButtons(primary) {
    return [
      primary,
      h('button', { class: 'btn block', onclick: useKeyboard }, icon('pen'), 'Use the keyboard instead'),
      h('button', { class: 'btn ghost', onclick: cancel }, 'Cancel'),
    ].filter(Boolean);
  }
  const tryAgainButton = () => h('button', { class: 'btn primary block', onclick: () => { quietRetries = 0; listen(); } }, icon('refresh'), 'Try again');

  function showMicProblem(err) {
    const message = err.kind === 'denied'
      ? 'Microphone access is turned off. On your iPhone go to Settings → Apps → Safari → Microphone, choose Allow, then try again.'
      : err.kind === 'unsupported'
        ? 'This browser can\'t record audio.'
        : 'The microphone stopped responding. This is a known iPhone issue with Home Screen apps; restarting your phone usually fixes it.';
    root.dataset.phase = 'error';
    setPhase('error', message, errorButtons(err.kind === 'unsupported' ? null : tryAgainButton()));
  }

  async function listen() {
    if (closed) return;
    setPhase('listening', turns.length ? 'Listening…' : 'Listening… just say what you bought.');
    recording = new AbortController();
    let rec;
    try {
      rec = await recordTurn({ onLevel: (l) => orb.style.setProperty('--level', l.toFixed(3)), signal: recording.signal });
    } catch (err) {
      if (closed) return;
      // One quiet retry with a completely fresh microphone connection, then ask the user.
      if (err instanceof MicError && err.kind === 'broken' && quietRetries < 1) {
        quietRetries++;
        return listen();
      }
      return showMicProblem(err instanceof MicError ? err : new MicError(err?.message, 'broken'));
    } finally {
      orb.style.setProperty('--level', '0');
    }
    if (closed) return;
    if (!rec.heard || rec.blob.size < 1200) {
      if (!turns.length) return setPhase('error', 'I didn\'t hear anything.', errorButtons(tryAgainButton()));
      return finishWithWhatWeHave(); // went quiet after a question
    }
    await understand(rec.blob);
  }

  async function understand(blob) {
    setPhase('thinking', 'One sec…');
    let text;
    try {
      text = await transcribeWithRetry(blob);
    } catch (err) {
      if (closed) return;
      if (err.kind === 'offline' || err.kind === 'retry') return saveForLater({ audio: blob });
      if (err.kind === 'auth') {
        return setPhase('error', err.message, errorButtons(h('button', { class: 'btn primary block', onclick: () => { close(); location.hash = '#/settings/ai'; } }, icon('gear'), 'Open voice settings')));
      }
      return setPhase('error', 'That recording couldn\'t be understood.', errorButtons(tryAgainButton()));
    }
    if (closed) return;
    if (!text) {
      if (!turns.length) return setPhase('error', 'I didn\'t catch that.', errorButtons(tryAgainButton()));
      return finishWithWhatWeHave();
    }
    turns.push({ role: 'user', text });
    bubble('user', text);
    await think();
  }

  async function think() {
    setPhase('thinking', 'One sec…');
    let result;
    try {
      result = await talkTurn(turns, createdAt);
    } catch (err) {
      if (closed) return;
      if (err.kind === 'auth') {
        return setPhase('error', err.message, errorButtons(h('button', { class: 'btn primary block', onclick: () => { close(); location.hash = '#/settings/ai'; } }, icon('gear'), 'Open AI settings')));
      }
      // No connection or a hiccup: keep what was said; it's read when the app can reach the AI again.
      return saveForLater({});
    }
    if (closed) return;
    const userTurns = turns.filter((t) => t.role === 'user').length;
    if (result.done || userTurns >= MAX_USER_TURNS) return complete(result);
    turns.push({ role: 'assistant', text: result.say });
    bubble('assistant', result.say);
    setPhase('speaking', '');
    await speak(result.say);
    listen();
  }

  async function finishWithWhatWeHave() {
    turns.push({ role: 'user', text: '(No answer. Log what you have.)', meta: true });
    await think();
  }

  async function complete(result) {
    if (!result.is_expense || !result.expenses?.length) {
      const say = result.say || 'Okay, nothing saved.';
      bubble('assistant', say);
      setPhase('done', '');
      await speak(say);
      return close();
    }
    const entry = await createEntry({ source: 'voice', inputText: userText(), status: 'processing' });
    await applyAIResult(entry.id, result);
    const first = result.expenses[0];
    const say = result.say || `Saved ${formatMoney(first.total, first.currency)}.`;
    bubble('assistant', say);
    setPhase('done', 'Saved', [
      h('button', { class: 'btn primary block', onclick: close }, icon('check'), 'Done'),
      h('button', { class: 'btn ghost small', onclick: () => { close(); location.hash = `#/entry/${entry.id}`; } }, 'View or edit'),
    ]);
    kick(); // sync to Google Sheets if connected
    await speak(say);
    setTimeout(() => { if (!closed && root.dataset.phase === 'done') close(); }, 2500);
  }

  async function saveForLater({ audio }) {
    const said = userText();
    if (audio) await createEntry({ source: 'voice', file: audio, inputText: said, audioPending: true });
    else if (said) await createEntry({ source: 'voice', inputText: said });
    kick();
    close();
    toast('Saved. It\'ll be logged when you\'re back online.');
  }

  function useKeyboard() {
    const said = userText();
    close();
    onUseKeyboard(said);
  }

  function cancel() {
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    recording?.abort();
    stopSpeaking();
    releaseAudio();
    document.removeEventListener('visibilitychange', onHide);
    root.remove();
  }

  // Switching away mid-recording ends the turn and frees the microphone.
  function onHide() {
    if (document.visibilityState === 'hidden') recording?.abort();
  }
  document.addEventListener('visibilitychange', onHide);

  listen();
  return { close };
}
