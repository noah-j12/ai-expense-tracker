// Live voice conversation (like ChatGPT's voice mode) with OpenAI's realtime voice model over WebRTC.
// The voice model handles the back-and-forth; when it has the details it calls `log_expense`, and Claude
// turns that into the expense record (vendor, category from the user's list, etc.), as for any other entry.
// On a problem it explains and offers choices; it never switches to another mode by itself.

import { AIError, extractExpenses } from './ai.js';
import { applyAIResult, createEntry, getEntry, updateEntry } from './entries.js';
import { kick } from './queue.js';
import { settings } from './settings.js';
import { MicError, TTS_VOICE, askingRules, audioContext, prepareAudio, releaseAudio } from './speech.js';
import { toast } from './ui.js';
import { fill, formatMoney, h, icon } from './util.js';

export const LIVE_MODEL = 'gpt-realtime-2.1-mini';
// OpenAI's transcription model for live audio (gpt-transcribe is for recorded files).
const LIVE_TRANSCRIBE_MODEL = 'gpt-live-transcribe';

// OpenAI's own explanation from an error response, if there is one.
async function errorDetail(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text).error?.message || text.slice(0, 200); } catch { return text.slice(0, 200); }
}
const OPENAI = 'https://api.openai.com/v1';
const MAX_SESSION_MS = 4 * 60_000;

const allowInterrupt = () => settings().voice?.allowInterrupt === true;

function instructions() {
  return `You are the voice of an expense-tracking app. The user is telling you about something they bought so it can be logged for their bookkeeping.
- Keep every reply short and natural: one sentence, under 20 words.
${askingRules()}
- Once you have everything above (or they've said they don't know the rest), call log_expense. Call it once per separate purchase.
- When log_expense returns, say its "say" text and stop. Don't ask if there's anything else.
- If they say to cancel or that it was a mistake, say "Okay, nothing saved." and don't call log_expense.
- Speak the user's language.`;
}

const TOOL = {
  type: 'function',
  name: 'log_expense',
  description: 'Save one purchase to the user\'s expense records.',
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Everything the user said about this one purchase, with their corrections applied: what was bought, the total, the store, how they paid, when (e.g. "yesterday"), and anything else they mentioned. Plain sentences.',
      },
    },
    required: ['description'],
  },
};

class LiveError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'auth' | 'offline' | 'fatal'
  }
}

async function mintSecret(withTranscription) {
  const key = settings().voice?.openaiKey;
  if (!key) throw new LiveError('Add your OpenAI key in Settings → AI to use live conversations.', 'auth');
  const session = {
    type: 'realtime',
    model: LIVE_MODEL,
    instructions: instructions(),
    audio: {
      input: {
        // Without interrupting, the model's speech is never cut off by what the mic hears (it can hear
        // itself on the phone's speaker). With headphones, interrupting can be turned on in Settings.
        turn_detection: { type: 'semantic_vad', interrupt_response: allowInterrupt() },
        // Only for showing the user's words on screen; the conversation works without it.
        ...(withTranscription ? { transcription: { model: LIVE_TRANSCRIBE_MODEL } } : {}),
      },
      output: { voice: TTS_VOICE },
    },
    tools: [TOOL],
    tool_choice: 'auto',
  };
  let res;
  try {
    res = await fetch(`${OPENAI}/realtime/client_secrets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session }),
    });
  } catch {
    throw new LiveError('No connection. Live conversations need internet.', 'offline');
  }
  if (res.status === 401 || res.status === 403) throw new LiveError('Your OpenAI key was rejected. Check it in Settings → AI.', 'auth');
  if (res.status === 400 && withTranscription) return mintSecret(false); // transcript display is optional
  if (!res.ok) {
    const detail = await errorDetail(res);
    if (res.status === 429 && /quota|billing/i.test(detail)) throw new LiveError('Your OpenAI account is out of credit. Add credit, then try again.', 'auth');
    throw new LiveError(`The live voice service couldn't start. OpenAI said: ${detail || res.status}`, 'fatal');
  }
  const data = await res.json().catch(() => ({}));
  if (!data.value) throw new LiveError('The live voice service couldn\'t start (no session key returned).', 'fatal');
  return data.value;
}

export function startLive({ onUseKeyboard }) {
  // Done during the tap so iOS lets audio play and the level meter run.
  prepareAudio();
  const player = new Audio();
  player.autoplay = true;
  player.playsInline = true;
  player.play().catch(() => {});

  let closed = false;
  let pc = null;
  let dc = null;
  let stream = null;
  let meterRaf = 0;
  let unmuteTimer = null;

  // While the AI talks, the mic is muted so it can't hear itself through the speaker (which made it stop
  // mid-sentence and answer its own echo). It comes back on just after the AI finishes, and anything
  // captured in between is thrown away.
  function muteMic(on) {
    if (allowInterrupt()) return;
    clearTimeout(unmuteTimer);
    const apply = (enabled) => stream?.getAudioTracks().forEach((t) => { t.enabled = enabled; });
    if (on) {
      apply(false);
      unmuteTimer = setTimeout(() => muteMic(false), 30_000); // never stay muted if an event goes missing
    } else {
      unmuteTimer = setTimeout(() => {
        send({ type: 'input_audio_buffer.clear' });
        apply(true);
      }, 400);
    }
  }
  let savedCount = 0;
  let finishTimer = null;
  const sessionTimer = setTimeout(() => close(), MAX_SESSION_MS);

  const orb = h('div', { class: 'talk-orb' }, icon('mic'));
  const status = h('div', { class: 'talk-status' });
  const log = h('div', { class: 'talk-log' });
  const actions = h('div', { class: 'talk-actions' });
  const root = h('div', { class: 'talk', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Live conversation' },
    h('div', { class: 'talk-top' }, h('span', { class: 'small muted' }, 'Live conversation'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x'))),
    log,
    h('div', { class: 'talk-center' }, orb, status),
    actions);
  document.body.append(root);

  const endButton = () => h('button', { class: 'btn block', onclick: close }, 'End');
  function setPhase(phase, text, buttons) {
    root.dataset.phase = phase;
    status.textContent = text;
    fill(actions, ...(buttons || (phase === 'done' ? [] : [endButton(), h('button', { class: 'btn ghost small', onclick: useKeyboard }, 'Type instead')])));
  }

  let lastBubble = null;
  function bubble(role, text) {
    if (!text) return;
    lastBubble = h('div', { class: `bubble ${role}` }, text);
    log.append(lastBubble);
    log.scrollTop = log.scrollHeight;
  }

  const errorButtons = (retry) => [
    retry ? h('button', { class: 'btn primary block', onclick: () => { teardown(); connect(); } }, icon('refresh'), 'Try again') : null,
    h('button', { class: 'btn block', onclick: useKeyboard }, icon('pen'), 'Use the keyboard instead'),
    h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
  ].filter(Boolean);

  function showProblem(err) {
    if (closed) return;
    teardown();
    let message = err.message;
    if (err instanceof MicError) {
      message = err.kind === 'denied'
        ? 'Microphone access is turned off. On your iPhone go to Settings → Apps → Safari → Microphone, choose Allow, then try again.'
        : 'The microphone stopped responding. This is a known iPhone issue with Home Screen apps; restarting your phone usually fixes it.';
    }
    const buttons = errorButtons(err.kind !== 'auth');
    if (err.kind === 'auth') buttons.unshift(h('button', { class: 'btn primary block', onclick: () => { close(); location.hash = '#/settings/ai'; } }, icon('gear'), 'Open voice settings'));
    setPhase('error', message, buttons);
  }

  function meter() {
    // Animates the orb with the microphone level.
    const ctxAudio = audioContext();
    if (!stream || !ctxAudio) return;
    try {
      const src = ctxAudio.createMediaStreamSource(stream);
      const analyser = ctxAudio.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (closed || !stream) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        orb.style.setProperty('--level', Math.min(1, Math.sqrt(sum / buf.length) / 0.15).toFixed(3));
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* meter is decoration only */ }
  }

  async function connect(withTranscription = true) {
    if (closed) return;
    setPhase('thinking', 'Connecting…');
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (err) {
        throw new MicError('mic', err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'broken');
      }
      if (!stream.getAudioTracks()[0] || stream.getAudioTracks()[0].readyState !== 'live') throw new MicError('mic', 'broken');
      const secret = await mintSecret(withTranscription);
      if (closed) return;

      pc = new RTCPeerConnection();
      pc.ontrack = (e) => {
        player.srcObject = e.streams[0];
        player.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected'].includes(pc?.connectionState) && !closed && root.dataset.phase !== 'done') {
          showProblem(new LiveError('The connection dropped.', 'offline'));
        }
      };
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      dc = pc.createDataChannel('oai-events');
      dc.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.warn('live event', err); } };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      let res;
      try {
        res = await fetch(`${OPENAI}/realtime/calls`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        });
      } catch {
        throw new LiveError('No connection. Live conversations need internet.', 'offline');
      }
      if (!res.ok) {
        const detail = await errorDetail(res);
        console.warn('Realtime connect failed', res.status, detail);
        // The on-screen transcript setting is the likeliest thing to be rejected; it's optional, so retry without it.
        if (withTranscription && res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
          teardown();
          return connect(false);
        }
        throw new LiveError(`The live voice service couldn't connect. OpenAI said: ${detail || `error ${res.status}`}`, 'fatal');
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      if (closed) return;
      meter();
      setPhase('listening', 'Listening… just say what you bought.');
    } catch (err) {
      showProblem(err);
    }
  }

  function send(event) {
    if (dc?.readyState === 'open') dc.send(JSON.stringify(event));
  }

  function onEvent(ev) {
    if (closed) return;
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        if (root.dataset.phase !== 'done') setPhase('listening', 'Listening…');
        break;
      case 'input_audio_buffer.speech_stopped':
        if (root.dataset.phase !== 'done') setPhase('thinking', 'One sec…');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        bubble('user', ev.transcript?.trim());
        break;
      case 'output_audio_buffer.started':
        muteMic(true);
        if (root.dataset.phase !== 'done') setPhase('speaking', '');
        break;
      case 'output_audio_buffer.stopped':
        muteMic(false);
        if (savedCount) finishSoon(600);
        else if (root.dataset.phase !== 'done') setPhase('listening', 'Listening…');
        break;
      case 'response.output_audio_transcript.done':
        bubble('assistant', ev.transcript?.trim());
        break;
      case 'response.done':
        handleResponse(ev.response);
        break;
      case 'error':
        console.warn('Realtime error', ev.error);
        if (ev.error?.code === 'session_expired') showProblem(new LiveError('The live session timed out.', 'fatal'));
        break;
      default:
        break;
    }
  }

  async function handleResponse(response) {
    const calls = (response?.output || []).filter((o) => o.type === 'function_call' && o.name === 'log_expense');
    if (!calls.length) {
      // The model said "Okay, nothing saved" (or similar) after a cancel.
      const said = (response?.output || []).flatMap((o) => o.content || []).map((c) => c.transcript || '').join(' ');
      if (/nothing saved/i.test(said)) finishSoon(1500);
      return;
    }
    setPhase('thinking', 'Saving…');
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* use empty */ }
      const out = await saveExpense(String(args.description || '').trim());
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(out) } });
    }
    send({ type: 'response.create' });
    // If the confirmation never plays (no audio events), close anyway.
    finishSoon(9000);
  }

  // Claude reads the description like any typed entry, using the user's categories and rules.
  async function saveExpense(description) {
    if (!description) return { saved: false, say: 'Sorry, I didn\'t catch that.' };
    const entry = await createEntry({ source: 'voice', inputText: description, status: 'processing' });
    savedCount++;
    try {
      const result = await extractExpenses(await getEntry(entry.id), null);
      await applyAIResult(entry.id, result);
      const x = result.expenses?.[0];
      if (!result.is_expense || !x) return { saved: true, say: 'Saved. Please check it in the app.' };
      const what = [x.description, x.vendor ? `from ${x.vendor}` : ''].filter(Boolean).join(' ');
      return { saved: true, say: `Saved ${what} for ${formatMoney(x.total, x.currency)}.` };
    } catch (err) {
      // Keep it: the queue finishes it when the AI is reachable again.
      await updateEntry(entry.id, (e) => { e.aiStatus = 'queued'; }, { syncSheet: false });
      kick();
      return err instanceof AIError && err.kind === 'auth'
        ? { saved: true, say: 'Saved, but the details couldn\'t be filled in yet. Check your AI key in Settings.' }
        : { saved: true, say: 'Saved. The details will be filled in shortly.' };
    }
  }

  function finishSoon(ms) {
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      if (closed) return;
      if (savedCount) {
        setPhase('done', 'Saved', [h('button', { class: 'btn primary block', onclick: close }, icon('check'), 'Done')]);
        kick();
        setTimeout(() => { if (!closed && root.dataset.phase === 'done') close(); }, 2000);
      } else {
        close();
      }
    }, ms);
  }

  function useKeyboard() {
    const said = [...log.querySelectorAll('.bubble.user')].map((b) => b.textContent).join('\n');
    close();
    onUseKeyboard(said);
  }

  function teardown() {
    clearTimeout(unmuteTimer);
    cancelAnimationFrame(meterRaf);
    try { dc?.close(); } catch { /* closed */ }
    try { pc?.close(); } catch { /* closed */ }
    stream?.getTracks().forEach((t) => t.stop());
    dc = null;
    pc = null;
    stream = null;
    player.srcObject = null;
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(sessionTimer);
    clearTimeout(finishTimer);
    teardown();
    releaseAudio();
    document.removeEventListener('visibilitychange', onHide);
    root.remove();
    if (savedCount) toast(savedCount === 1 ? 'Expense saved' : `${savedCount} expenses saved`);
  }

  // Leaving the app ends the call and frees the microphone.
  function onHide() {
    if (document.visibilityState === 'hidden') close();
  }
  document.addEventListener('visibilitychange', onHide);

  connect();
  return { close };
}
