// Background work: sends queued entries to the AI, then syncs to Google Sheets.
// iPhones don't let web apps work while closed, so this runs whenever the app is open:
// on launch, when it comes back to the foreground, when the connection returns, and once a minute.

import { AIError, extractExpenses } from './ai.js';
import { getFile, getAllEntries, putEntry } from './db.js';
import { applyAIResult, getEntry, markAIError, updateEntry } from './entries.js';
import { settings } from './settings.js';
import { syncSheets } from './sheets.js';
import { transcribeWithRetry } from './speech.js';
import { emit } from './util.js';

// blocked: a problem the user must fix (bad key, no credit). offline: last attempt had no connection.
export const queueState = { blocked: '', offline: false, running: false };

let again = false;
let retryTimer = null;

export function kick() {
  if (queueState.running) {
    again = true;
    return;
  }
  run();
}

async function run() {
  queueState.running = true;
  emit('queue-changed');
  try {
    do {
      again = false;
      await processAI();
      await syncSheets();
    } while (again);
  } catch (err) {
    console.error('Queue error', err);
  } finally {
    queueState.running = false;
    emit('queue-changed');
  }
}

function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(kick, ms);
}

async function processAI() {
  const pending = (await getAllEntries())
    .filter((e) => e.aiStatus === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!pending.length) {
    queueState.offline = false;
    return;
  }
  if (!settings().ai.apiKey) {
    queueState.blocked = 'Add your AI key so the app can read your entries.';
    return;
  }

  for (const { id } of pending) {
    const current = await getEntry(id);
    if (!current || current.aiStatus !== 'queued') continue;
    const entry = await updateEntry(id, (e) => { e.aiStatus = 'processing'; }, { syncSheet: false });
    if (!entry) continue;

    try {
      let file = entry.fileId ? await getFile(entry.fileId) : null;
      // A voice recording saved while offline: turn it into text first.
      if (file?.type.startsWith('audio/')) {
        if (entry.audioPending) {
          // A voice-key problem only affects voice recordings, so don't hold up receipts over it.
          const text = await transcribeWithRetry(file).catch((err) => {
            throw err.kind === 'auth' ? new AIError(`${err.message} Then tap Try again.`, 'fatal') : err;
          });
          if (!text && !entry.inputText) throw new AIError('No speech was heard in this recording.', 'fatal');
          // Anything said earlier in the conversation is already text; the recording is the last part.
          const full = [entry.inputText, text].filter(Boolean).join('\n');
          await updateEntry(id, (e) => { e.inputText = full; e.audioPending = false; }, { syncSheet: false });
          entry.inputText = full;
        }
        file = null;
      }
      const result = await extractExpenses(entry, file);
      await applyAIResult(id, result);
      queueState.offline = false;
      queueState.blocked = '';
    } catch (err) {
      const e = err instanceof AIError ? err : new AIError(err?.message || 'Something went wrong.', err?.kind || 'retry');
      if (e.kind === 'fatal') {
        await markAIError(id, e.message);
        continue;
      }
      // Put it back in line and stop; the remaining entries would hit the same problem.
      await updateEntry(id, (x) => { x.aiStatus = 'queued'; }, { syncSheet: false });
      if (e.kind === 'auth') {
        queueState.blocked = e.message;
      } else {
        queueState.offline = e.kind === 'offline';
        scheduleRetry(e.kind === 'offline' ? 20_000 : 45_000);
      }
      break;
    }
  }
}

export async function startQueue() {
  // Anything left "processing" was interrupted (app closed mid-request); put it back in line.
  for (const e of await getAllEntries()) {
    if (e.aiStatus === 'processing') {
      e.aiStatus = 'queued';
      await putEntry(e);
    }
  }
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') kick();
  }, 60_000);
  kick();
}

export function clearBlocked() {
  queueState.blocked = '';
  emit('queue-changed');
}
