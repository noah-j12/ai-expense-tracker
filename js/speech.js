// Voice conversations: record with automatic end-of-speech detection, transcribe with OpenAI
// (Claude doesn't take audio), and talk back with the iPhone's built-in voice.

import { settings } from './settings.js';

export const TRANSCRIBE_MODEL = 'gpt-transcribe';
const OPENAI = 'https://api.openai.com/v1';

export const PAUSE_OPTIONS = [
  { id: 'short', name: 'Short', hint: 'Stops listening after about 1.5 seconds of quiet', ms: 1500 },
  { id: 'normal', name: 'Normal', hint: 'About 2.5 seconds', ms: 2500 },
  { id: 'long', name: 'Long', hint: 'About 4 seconds, for people who think out loud', ms: 4000 },
];

export class MicError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'denied' | 'broken' | 'unsupported'
  }
}

export class VoiceError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'auth' | 'offline' | 'retry' | 'fatal'
  }
}

// True when "Talk to It" uses one of the OpenAI voice modes rather than the keyboard mic.
export function voiceEnabled() {
  return voiceMode() !== 'keyboard';
}

// ---------- Recording ----------

// One AudioContext for the whole conversation, created during the user's tap (iOS requires that).
let audioCtx = null;
export function prepareAudio() {
  if (!audioCtx || audioCtx.state === 'closed') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = Ctx ? new Ctx() : null;
  }
  audioCtx?.resume?.();
}

export const audioContext = () => audioCtx;

export function releaseAudio() {
  audioCtx?.close?.().catch(() => {});
  audioCtx = null;
}

const MIME_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

/**
 * Records one turn. Resolves with { blob, heard } when the person stops talking (pause length from
 * settings), taps Done, or after maxMs. The microphone is fully released every time, which avoids an
 * iOS bug where a mic left open stops working in Home Screen apps.
 */
export function recordTurn({ onLevel, maxMs = 180_000, signal } = {}) {
  return new Promise(async (resolve, reject) => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      reject(new MicError('This phone\'s browser can\'t record audio.', 'unsupported'));
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      reject(err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
        ? new MicError('Microphone access is turned off for this app.', 'denied')
        : new MicError('The microphone couldn\'t be started.', 'broken'));
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') {
      stream.getTracks().forEach((t) => t.stop());
      reject(new MicError('The microphone isn\'t responding.', 'broken'));
      return;
    }

    const pauseMs = (PAUSE_OPTIONS.find((p) => p.id === settings().voice?.pause) || PAUSE_OPTIONS[1]).ms;
    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

    let analyser = null;
    let source = null;
    if (audioCtx) {
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
    }

    const started = performance.now();
    let heard = false;
    let lastLoud = started;
    let anySignal = false;
    // Background-noise level = the quiet end of recent loudness readings (gaps between words count),
    // so talking straight away doesn't get mistaken for background noise.
    const recent = [];
    let finished = false;
    let raf = 0;
    const buf = analyser ? new Float32Array(analyser.fftSize) : null;

    const cleanup = () => {
      cancelAnimationFrame(raf);
      try { source?.disconnect(); } catch { /* already gone */ }
      stream.getTracks().forEach((t) => t.stop());
    };

    const finish = (reason) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      if (reason === 'broken') {
        try { recorder.stop(); } catch { /* not started */ }
        cleanup();
        reject(new MicError('The microphone is only picking up silence.', 'broken'));
        return;
      }
      recorder.onstop = () => {
        cleanup();
        const type = recorder.mimeType || mimeType || 'audio/mp4';
        resolve({ blob: new Blob(chunks, { type }), heard: heard || !analyser, reason });
      };
      try { recorder.stop(); } catch { cleanup(); resolve({ blob: new Blob(chunks), heard, reason }); }
    };

    signal?.addEventListener('abort', () => finish('done'));
    track.addEventListener('ended', () => finish(heard ? 'done' : 'broken'));

    const tick = () => {
      if (finished) return;
      const now = performance.now();
      if (analyser) {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          sum += buf[i] * buf[i];
          if (buf[i] !== 0) anySignal = true;
        }
        const rms = Math.sqrt(sum / buf.length);
        recent.push(rms);
        if (recent.length > 300) recent.shift();
        const floor = [...recent].sort((a, b) => a - b)[Math.floor(recent.length * 0.1)];
        const threshold = Math.max(0.01, floor * 3);
        onLevel?.(Math.min(1, rms / 0.15));
        if (rms > threshold) { heard = true; lastLoud = now; }
        // A working mic always picks up some room noise; perfect digital silence means it's broken.
        if (!anySignal && now - started > 3500) return finish('broken');
        if (heard && now - lastLoud > pauseMs) return finish('pause');
        if (!heard && now - started > 15_000) return finish('nothing');
      }
      if (now - started > maxMs) return finish('max');
      raf = requestAnimationFrame(tick);
    };

    recorder.start(250);
    raf = requestAnimationFrame(tick);
  });
}

// ---------- Transcription ----------

function extFor(type) {
  if (/webm/.test(type)) return 'webm';
  if (/mpeg|mp3/.test(type)) return 'mp3';
  if (/wav/.test(type)) return 'wav';
  return 'mp4';
}

export async function testVoiceKey(key) {
  try {
    const res = await fetch(`${OPENAI}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 401) return { ok: false, message: 'That OpenAI key was rejected. Check it and try again.' };
    if (!res.ok) return { ok: false, message: `OpenAI returned an error (${res.status}). Try again in a moment.` };
    return { ok: true };
  } catch {
    return { ok: false, message: 'Couldn\'t reach OpenAI. Check your connection.' };
  }
}

export async function transcribe(blob) {
  const key = settings().voice?.openaiKey;
  if (!key) throw new VoiceError('Add your OpenAI key in Settings → AI to use voice conversations.', 'auth');
  const form = new FormData();
  form.append('file', blob, `speech.${extFor(blob.type)}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('prompt', 'Someone describing a purchase for their expense records: store names, items, dollar amounts, payment cards. They may pause, ramble or correct themselves.');
  let res;
  try {
    res = await fetch(`${OPENAI}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  } catch {
    // OpenAI's error replies can't be read by browsers, so a bad key looks like a network failure.
    // Tell the two apart with a quick key check.
    if (navigator.onLine) {
      const check = await testVoiceKey(key);
      if (!check.ok && /rejected/.test(check.message)) throw new VoiceError('Your OpenAI key was rejected. Check it in Settings → AI.', 'auth');
      if (check.ok) throw new VoiceError('The voice service had a hiccup.', 'retry');
    }
    throw new VoiceError('No connection.', 'offline');
  }
  if (res.status === 401 || res.status === 403) throw new VoiceError('Your OpenAI key was rejected. Check it in Settings → AI.', 'auth');
  if (res.status === 429) {
    const body = await res.text().catch(() => '');
    if (/quota|billing/i.test(body)) throw new VoiceError('Your OpenAI account is out of credit. Add credit, then try again.', 'auth');
    throw new VoiceError('The voice service is busy.', 'retry');
  }
  if (res.status >= 500) throw new VoiceError('The voice service had a hiccup.', 'retry');
  if (!res.ok) throw new VoiceError('That recording couldn\'t be understood.', 'fatal');
  const data = await res.json();
  return String(data.text || '').trim();
}

// Retries temporary failures a couple of times before giving up.
export async function transcribeWithRetry(blob, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await transcribe(blob);
    } catch (err) {
      if (err.kind !== 'retry' || i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
}

// ---------- Talking back (AI voice) ----------

// OpenAI is retiring this model on 2027-01-06; move to its replacement before then.
export const TTS_MODEL = 'gpt-4o-mini-tts';
export const TTS_VOICE = 'marin';

let playing = null; // the AudioBufferSourceNode currently speaking

// Speaks with OpenAI's AI voice through the AudioContext opened during the user's tap
// (so iOS allows playback). If the voice can't be fetched, the text is still on screen.
export async function speak(text) {
  const key = settings().voice?.openaiKey;
  if (!text || !key || settings().voice?.talkBack === false || !audioCtx) return;
  let audio;
  try {
    const res = await fetch(`${OPENAI}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input: text,
        instructions: 'Warm, relaxed and brief, like a helpful assistant confirming something quickly.',
        response_format: 'mp3',
      }),
    });
    if (!res.ok) return;
    audio = await audioCtx.decodeAudioData(await res.arrayBuffer());
  } catch {
    return;
  }
  await new Promise((resolve) => {
    stopSpeaking();
    const src = audioCtx.createBufferSource();
    src.buffer = audio;
    src.connect(audioCtx.destination);
    src.onended = () => { if (playing === src) playing = null; resolve(); };
    playing = src;
    audioCtx.resume?.();
    src.start();
  });
}

export function stopSpeaking() {
  try { playing?.stop(); } catch { /* already stopped */ }
  playing = null;
}

// ---------- Voice options and cost estimates ----------

export const VOICE_MODES = [
  { id: 'keyboard', name: 'Keyboard mic', hint: 'Tap the mic on the keyboard and talk; the app reads what you said. No extra account.' },
  { id: 'spoken', name: 'Voice with spoken replies', hint: 'You talk; it asks any questions out loud in a natural AI voice. Needs an OpenAI key.' },
  { id: 'live', name: 'Live conversation', hint: 'Like ChatGPT\'s voice mode: instant back-and-forth, and you can interrupt it. Needs an OpenAI key.' },
];

// Rough per-entry estimates by AI setting (Claude model), in cents.
const COSTS = {
  'claude-opus-5-5': { keyboard: '~1¢', spoken: '~2–4¢', live: '~3–6¢' },
  'claude-sonnet-5-5': { keyboard: '~0.5¢', spoken: '~1–2.5¢', live: '~2.5–5¢' },
  'claude-haiku-5-5': { keyboard: '~0.05¢', spoken: '~0.4–1¢', live: '~2–5¢' },
};

export function voiceCost(mode, model = settings().ai.model) {
  return (COSTS[model] || COSTS['claude-opus-5-5'])[mode];
}

export function voiceMode() {
  const v = settings().voice || {};
  if (!v.openaiKey) return 'keyboard';
  return v.mode || 'spoken';
}
