// Automatic backup to the user's own Google Drive, using the same Google sign-in as Google Sheets.
// After changes it backs up at most once an hour while the app is open. Each backup replaces backup.json
// (Drive keeps earlier versions of it) and uploads only receipt photos it hasn't sent before.
// The 'remind' option instead reminds the user to save a backup file themselves (e.g. to iCloud Drive).

import { getAllEntries, getFile, kvGet, kvSet } from './db.js';
import { backupData, restoreData } from './exporter.js';
import { backupFolder, backupFolderFiles, deleteDriveFile, downloadDriveFile, saveDriveFile } from './google.js';
import { settings } from './settings.js';
import { emit, on } from './util.js';

const EVERY_MS = 60 * 60_000;
const REMIND_EVERY_MS = 7 * 86_400_000;
const DATA_FILE = 'backup.json';
const photoName = (fileId) => `photo-${fileId}`;

export const backupState = { running: false, error: '', lastAt: null, lastManualAt: null };

export const backupMode = () => settings().backup?.mode || 'off';
export const googleSignedIn = () => Boolean(settings().sheets.google?.refreshToken);

// Notes any change so the next check knows there's something new to back up.
export async function watchForChanges() {
  const st = (await kvGet('backupState')) || {};
  backupState.lastAt = st.lastAt || null;
  backupState.lastManualAt = st.lastManualAt || null;
  backupState.error = st.error || '';
  const changed = () => { kvSet('backupChanged', true).catch(() => {}); };
  on('entries-changed', changed);
  on('settings-changed', changed);
}

async function saveState() {
  await kvSet('backupState', { lastAt: backupState.lastAt, lastManualAt: backupState.lastManualAt, error: backupState.error });
  emit('backup-changed');
}

// Backs up to Drive if it's turned on, something changed and the last backup was over an hour ago
// (or right away with now: true).
export async function maybeBackup({ now = false } = {}) {
  if (backupMode() !== 'drive' || !googleSignedIn() || backupState.running) return;
  if (!now && (!(await kvGet('backupChanged')) || (backupState.lastAt && Date.now() - backupState.lastAt < EVERY_MS))) return;
  backupState.running = true;
  emit('backup-changed');
  try {
    await kvSet('backupChanged', false); // changes made during the backup mark it again
    const folder = await backupFolder();
    // Which photos are already in Drive (photo id -> Drive file id); a new folder starts from nothing.
    const sent = folder.created ? {} : ((await kvGet('backupPhotos')) || {});
    const trash = (await kvGet('trash')) || [];
    const needed = new Set([...(await getAllEntries()), ...trash.map((t) => t.entry)].map((e) => e.fileId).filter(Boolean));
    for (const fileId of needed) {
      if (sent[fileId]) continue;
      const blob = await getFile(fileId);
      if (!blob) continue;
      sent[fileId] = (await saveDriveFile({ name: photoName(fileId), folderId: folder.id, blob })).id;
      await kvSet('backupPhotos', sent);
    }
    // Photos of expenses that are gone for good are removed from Drive too.
    for (const [fileId, driveId] of Object.entries(sent)) {
      if (!needed.has(fileId)) {
        await deleteDriveFile(driveId);
        delete sent[fileId];
      }
    }
    await kvSet('backupPhotos', sent);
    const data = new Blob([JSON.stringify(await backupData({ photos: false }))], { type: 'application/json' });
    const existing = folder.created ? null : (await backupFolderFiles(folder.id)).find((f) => f.name === DATA_FILE);
    await saveDriveFile({ fileId: existing?.id, name: DATA_FILE, folderId: folder.id, blob: data });
    backupState.lastAt = Date.now();
    backupState.error = '';
  } catch (err) {
    await kvSet('backupChanged', true);
    backupState.error = err.offline ? '' : err.message;
  } finally {
    backupState.running = false;
    await saveState();
  }
}

// The backup in Drive, if there is one: { modifiedTime } or null.
export async function findDriveBackup() {
  const folder = await backupFolder({ create: false });
  if (!folder) return null;
  const file = (await backupFolderFiles(folder.id)).find((f) => f.name === DATA_FILE);
  return file ? { ...file, folderId: folder.id } : null;
}

// Replaces everything on this phone with the backup in Drive. Returns the number of expenses restored.
export async function restoreFromDrive() {
  const backup = await findDriveBackup();
  if (!backup) throw new Error('No backup was found in your Google Drive. It has to be made by this app, signed in with the same Google account.');
  let data;
  try {
    data = JSON.parse(await (await downloadDriveFile(backup.id)).text());
  } catch (err) {
    throw err.offline !== undefined ? err : new Error('The backup in Google Drive could not be read.');
  }
  const files = await backupFolderFiles(backup.folderId);
  const byName = new Map(files.map((f) => [f.name, f.id]));
  const wanted = new Set([...data.entries, ...(data.trash || []).map((t) => t.entry)].map((e) => e.fileId).filter(Boolean));
  const photos = new Map();
  const sent = {};
  for (const fileId of wanted) {
    const driveId = byName.get(photoName(fileId));
    if (!driveId) continue;
    photos.set(fileId, await downloadDriveFile(driveId));
    sent[fileId] = driveId;
  }
  const count = await restoreData(data, { photos });
  // Restoring clears the phone's records; these photos are already in Drive, so don't send them again.
  await kvSet('backupPhotos', sent);
  backupState.lastAt = Date.now();
  backupState.error = '';
  await saveState();
  return count;
}

// ---------- Reminders (for backing up by hand, e.g. to iCloud Drive) ----------

export const reminderDue = () => backupMode() === 'remind' && (!backupState.lastManualAt || Date.now() - backupState.lastManualAt > REMIND_EVERY_MS);

export async function noteManualBackup() {
  backupState.lastManualAt = Date.now();
  await saveState();
}
