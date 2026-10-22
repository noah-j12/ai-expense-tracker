// Expense records: creating, editing, deleting and applying AI results.

import { deleteEntryRecord, deleteFile, getAllEntries, getEntry, kvGet, kvSet, putEntry, putFile } from './db.js';
import { settings } from './settings.js';
import { emit, parseISODate, round2, toISODate, uid } from './util.js';

export function blankFields(createdAt = Date.now()) {
  return {
    date: toISODate(new Date(createdAt)),
    vendor: '',
    description: '',
    total: 0,
    subtotal: 0,
    tax: 0,
    tip: 0,
    currency: settings().currency,
    category: '',
    paymentMethod: '',
    notes: '',
  };
}

let persistAsked = false;
function requestPersistence() {
  // Asks the browser not to clear this app's storage when the phone is low on space.
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

// A receipt photo/PDF (voice recordings are stored as files too, but aren't receipts).
export const hasReceipt = (e) => Boolean(e.fileId) && !String(e.fileType || '').startsWith('audio/');

// status 'processing' is for entries the caller is about to fill in itself (e.g. a finished voice conversation).
// audioPending: `file` is a voice recording still to be transcribed and added to inputText.
// id: only when bringing back an expense whose row is in the sheet, so it keeps the row's ID.
export async function createEntry({ id = null, source, file = null, thumb = null, inputText = '', userNote = '', fields = null, status = 'queued', audioPending = false }) {
  const s = settings();
  const now = Date.now();
  let fileId = null;
  if (file) {
    fileId = uid();
    await putFile(fileId, file);
  }
  const entry = {
    id: id || uid(),
    createdAt: now,
    updatedAt: now,
    source, // 'photo' | 'upload' | 'voice' | 'manual'
    fileId,
    fileType: file?.type || null,
    thumb,
    inputText,
    userNote,
    audioPending,
    businessId: s.activeBusinessId,
    aiStatus: fields ? 'skipped' : status, // queued | processing | done | error | skipped
    aiError: '',
    aiModel: '',
    fields: { ...blankFields(now), ...(fields || {}) },
    confidence: '',
    reviewReasons: [],
    reviewed: Boolean(fields),
    exportedAt: null,
    sheet: { dirty: true, receiptUrl: '', syncedAt: null },
  };
  await putEntry(entry);
  requestPersistence();
  emit('entries-changed', { id: entry.id });
  return entry;
}

export async function listEntries() {
  const all = await getAllEntries();
  return all.sort((a, b) => (b.fields.date || '').localeCompare(a.fields.date || '') || b.createdAt - a.createdAt);
}

export { getEntry };

// Read-modify-write steps run one at a time so a quick edit and a status change can't overwrite each other.
let writeChain = Promise.resolve();
function serial(fn) {
  const result = writeChain.then(fn, fn);
  writeChain = result.catch(() => {});
  return result;
}

// change: function that mutates the entry, or a partial `fields` object.
export function updateEntry(id, change, opts) {
  return serial(() => doUpdate(id, change, opts));
}

async function doUpdate(id, change, { syncSheet = true } = {}) {
  const entry = await getEntry(id);
  if (!entry) return null;
  if (typeof change === 'function') change(entry);
  else entry.fields = { ...entry.fields, ...change };
  entry.updatedAt = Date.now();
  if (syncSheet) entry.sheet = { ...entry.sheet, dirty: true };
  await putEntry(entry);
  emit('entries-changed', { id });
  return entry;
}

// ---------- Deleting and Recently deleted ----------
// A deleted expense (in the app, or by deleting its row in the sheet) is kept for 30 days, photo and all,
// so it can be restored by hand or by undoing the deletion in the sheet. After that it's gone for good.

const KEEP_DELETED_DAYS = 30;

const trashList = async () => (await kvGet('trash')) || [];

// Deleted expenses, newest first: [{ entry, deletedAt, from: 'app' | 'sheet' }].
export async function listDeleted() {
  return (await trashList()).sort((a, b) => b.deletedAt - a.deletedAt);
}

async function deleteFileIfUnused(fileId) {
  if (!fileId) return;
  const used = (await getAllEntries()).some((e) => e.fileId === fileId) || (await trashList()).some((t) => t.entry.fileId === fileId);
  if (!used) await deleteFile(fileId);
}

// fromSheet: the row was already deleted in the sheet, so there's nothing to remove there.
// permanently: skip Recently deleted (for a blank draft that was never filled in).
export async function removeEntry(id, { fromSheet = false, permanently = false } = {}) {
  const entry = await getEntry(id);
  if (!entry) return;
  await deleteEntryRecord(id);
  if (permanently) {
    await deleteFileIfUnused(entry.fileId);
  } else {
    const trash = (await trashList()).filter((t) => t.entry.id !== id);
    await kvSet('trash', [...trash, { entry, deletedAt: Date.now(), from: fromSheet ? 'sheet' : 'app' }]);
  }
  if (entry.sheet?.syncedAt && !fromSheet) {
    const pending = (await kvGet('sheetDeletes')) || [];
    await kvSet('sheetDeletes', [...pending, id]);
  }
  emit('entries-changed', { id, deleted: true });
}

export const isDeleted = async (id) => (await trashList()).some((t) => t.entry.id === id);

// Puts a deleted expense back. fromSheet: its row is back in the sheet (e.g. the deletion was undone there);
// otherwise the row is added to the sheet again on the next sync.
export async function restoreEntry(id, { fromSheet = false } = {}) {
  const trash = await trashList();
  const item = trash.find((t) => t.entry.id === id);
  if (!item) return null;
  const entry = item.entry;
  // Restored by hand: it isn't in the sheet until its row is added back, so a missing row isn't a deletion.
  entry.sheet = { ...entry.sheet, dirty: !fromSheet, ...(fromSheet ? {} : { syncedTo: null }) };
  entry.updatedAt = Date.now();
  await putEntry(entry);
  await kvSet('trash', trash.filter((t) => t !== item));
  const pending = (await kvGet('sheetDeletes')) || [];
  if (pending.includes(id)) await kvSet('sheetDeletes', pending.filter((x) => x !== id));
  emit('entries-changed', { id });
  return entry;
}

export async function deleteForever(id) {
  const trash = await trashList();
  const item = trash.find((t) => t.entry.id === id);
  if (!item) return;
  await kvSet('trash', trash.filter((t) => t !== item));
  await deleteFileIfUnused(item.entry.fileId);
  emit('entries-changed', { id, deleted: true });
}

// Erases anything deleted more than 30 days ago.
export async function purgeDeleted() {
  const cutoff = Date.now() - KEEP_DELETED_DAYS * 86_400_000;
  const trash = await trashList();
  const old = trash.filter((t) => t.deletedAt < cutoff);
  if (!old.length) return;
  await kvSet('trash', trash.filter((t) => t.deletedAt >= cutoff));
  for (const t of old) await deleteFileIfUnused(t.entry.fileId);
}

export async function requeue(id) {
  return updateEntry(id, (e) => {
    // Re-reading a finished entry must not spawn duplicate split entries.
    e.reread = e.aiStatus === 'done' || e.aiStatus === 'skipped' || Boolean(e.reread);
    e.aiStatus = 'queued';
    e.aiError = '';
  }, { syncSheet: false });
}

function cleanDate(value, fallbackMs) {
  return parseISODate(value) ? value : toISODate(new Date(fallbackMs));
}

function applyFields(entry, x, model) {
  const s = settings();
  const category = s.categories.includes(x.category) ? x.category : (s.categories.length ? '' : (x.category || ''));
  const currency = /^[A-Z]{3}$/.test((x.currency || '').toUpperCase()) ? x.currency.toUpperCase() : s.currency;
  entry.fields = {
    ...entry.fields,
    date: cleanDate(x.date, entry.createdAt),
    vendor: (x.vendor || '').trim(),
    description: (x.description || '').trim(),
    total: round2(x.total),
    subtotal: round2(x.subtotal),
    tax: round2(x.tax),
    tip: round2(x.tip),
    currency,
    category,
    paymentMethod: (x.payment_method || '').trim(),
    notes: (x.notes || '').trim(),
  };
  entry.confidence = x.confidence || '';
  entry.reviewReasons = Array.isArray(x.review_reasons) ? x.review_reasons.filter(Boolean) : [];
  if (!category && s.categories.length) entry.reviewReasons.push('No category fit, so please pick one.');
  entry.reviewed = false;
  entry.aiStatus = 'done';
  entry.aiError = '';
  entry.aiModel = model || '';
  entry.updatedAt = Date.now();
  entry.sheet = { ...entry.sheet, dirty: true };
}

export function applyAIResult(id, result) {
  return serial(() => doApplyAIResult(id, result));
}

async function doApplyAIResult(id, result) {
  const entry = await getEntry(id);
  if (!entry) return;
  const rereading = Boolean(entry.reread);
  delete entry.reread;

  if (!result.is_expense || !result.expenses?.length) {
    entry.aiStatus = 'done';
    entry.aiModel = result.model || '';
    entry.confidence = 'low';
    entry.reviewed = false;
    const why = (result.not_expense_reason || '').trim();
    entry.reviewReasons = [why ? `This doesn't look like an expense: ${why}` : "This doesn't look like an expense."];
    entry.updatedAt = Date.now();
    await putEntry(entry);
    emit('entries-changed', { id });
    return;
  }

  const [first, ...rest] = result.expenses;
  applyFields(entry, first, result.model);
  if (rest.length && rereading) {
    entry.reviewReasons.push(`The AI found ${rest.length + 1} purchases here; only the first was updated.`);
  }
  await putEntry(entry);

  if (!rereading) {
    for (const extra of rest) {
      const copy = structuredClone(entry);
      copy.id = uid();
      copy.splitFrom = entry.id;
      copy.sheet = { dirty: true, receiptUrl: '', syncedAt: null };
      applyFields(copy, extra, result.model);
      await putEntry(copy);
    }
  }
  emit('entries-changed', { id });
}

export async function markAIError(id, message) {
  await updateEntry(id, (e) => {
    e.aiStatus = 'error';
    e.aiError = message;
    delete e.reread;
  }, { syncSheet: false });
}

// What to show in lists: null means "all good, nothing to flag".
export function entryState(e) {
  if (e.aiStatus === 'queued') return { key: 'queued', label: 'Waiting', cls: '', icon: 'clock' };
  if (e.aiStatus === 'processing') return { key: 'processing', label: 'Reading…', cls: '', icon: 'sparkle' };
  if (e.aiStatus === 'error') return { key: 'error', label: 'Needs attention', cls: 'danger', icon: 'alert' };
  if (!e.reviewed && e.reviewReasons?.length) return { key: 'review', label: 'Check this', cls: 'warn', icon: 'alert' };
  return null;
}

export function needsAttention(e) {
  const st = entryState(e);
  return st?.key === 'error' || st?.key === 'review';
}

export function displayTitle(e) {
  if (e.fields.vendor) return e.fields.vendor;
  if (e.aiStatus === 'queued' || e.aiStatus === 'processing') {
    if (e.source === 'voice') return e.inputText ? `“${e.inputText.slice(0, 40)}${e.inputText.length > 40 ? '…' : ''}”` : 'Voice recording';
    return 'New receipt';
  }
  return e.fields.description || 'Expense';
}

// Records that these entries are now in the user's Excel file as they currently are.
// Doesn't touch updatedAt, so it never makes anything look edited.
export function markExcelSynced(ids) {
  return serial(async () => {
    for (const id of ids) {
      const e = await getEntry(id);
      if (!e) continue;
      e.excel = { version: e.updatedAt };
      await putEntry(e);
    }
    emit('entries-changed', {});
  });
}

export async function markExported(ids) {
  const now = Date.now();
  for (const id of ids) await updateEntry(id, (e) => { e.exportedAt = now; }, { syncSheet: false });
}
