// Settings → Backup: automatic backup to Google Drive, or a weekly reminder to save a backup by hand
// (for iCloud Drive or Files). Also restores from Drive, including on a new phone before setup.

import { backupMode, backupState, findDriveBackup, googleSignedIn, maybeBackup, noteManualBackup, restoreFromDrive } from '../backup.js';
import { backupFile, deliverFiles } from '../exporter.js';
import { pollDeviceAuth, startDeviceAuth } from '../google.js';
import { settings, updateSettings } from '../settings.js';
import { choiceList, confirmSheet, toast, topbar } from '../ui.js';
import { fill, formatDateTime, h, icon, navBack, on } from '../util.js';

export const BACKUP_MODES = [
  { id: 'drive', name: 'Google Drive', hint: 'Automatic. Everything, receipt photos included, is saved to your Google Drive.' },
  { id: 'remind', name: 'Remind me', hint: 'Once a week, a reminder to save a backup to iCloud Drive or Files yourself.' },
  { id: 'off', name: 'Off', hint: 'You can still save a backup any time in Settings → Your data.' },
];

// Google sign-in with a code (the same one Google Sheets uses). Calls onDone once signed in.
function googleSignIn(onDone) {
  const el = h('div', { class: 'stack' });
  let device = null;
  let timer = null;
  let error = '';
  const stop = () => { clearTimeout(timer); timer = null; };
  const copy = async () => { try { await navigator.clipboard.writeText(device.userCode); toast('Code copied'); } catch { /* it's on screen */ } };
  const render = () => {
    if (!device) {
      return fill(el, h('button', { class: 'btn primary block', onclick: start }, icon('key'), 'Sign in with Google'),
        error ? h('div', { class: 'small', style: { color: 'var(--danger)' } }, error) : null);
    }
    return fill(el,
      h('ol', { class: 'steps' },
        h('li', null, h('div', null, 'Copy this code:')),
        h('li', null, h('div', null, 'Tap ', h('b', null, 'Open Google'), ', sign in if asked, and paste the code.')),
        h('li', null, h('div', null, 'Tap ', h('b', null, 'Allow'), ', then come back here. This screen updates by itself.'))),
      h('div', { class: 'card pad center' },
        h('div', { class: 'num', style: { fontSize: '30px', fontWeight: 750, letterSpacing: '.08em' } }, device.userCode),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: copy }, 'Copy code')),
      h('a', { class: 'btn primary', href: device.verificationUrl, target: '_blank', rel: 'noopener', onclick: copy }, 'Open Google'),
      error
        ? h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' }, error, h('div', null, h('button', { class: 'btn small', onclick: start }, 'Get a new code'))))
        : h('div', { class: 'row small muted', style: { justifyContent: 'center' } }, h('span', { class: 'spinner' }), 'Waiting for you to allow access…'));
  };
  async function start() {
    error = '';
    try {
      device = await startDeviceAuth();
      schedule(device.interval);
    } catch (err) {
      error = err.message;
    }
    render();
  }
  function schedule(seconds) { stop(); timer = setTimeout(poll, seconds * 1000); }
  async function poll() {
    if (!device) return;
    if (Date.now() > device.expiresAt) { error = 'That code expired. Tap "Get a new code".'; return render(); }
    try {
      const out = await pollDeviceAuth(device.deviceCode);
      if (out === 'done') { stop(); toast('Google connected'); onDone(); return; }
      schedule(out === 'slow_down' ? device.interval + 5 : device.interval);
    } catch (err) {
      if (err.offline) return schedule(device.interval);
      error = err.message;
      render();
    }
  }
  render();
  return { el, stop };
}

export function BackupSettings({ query }) {
  const el = h('div', { class: 'page' });
  const restoring = query?.get('restore') === '1' || !settings().setupDone;
  let signIn = null;
  let found; // the Drive backup, once looked up: object, null, or undefined (not yet)
  let busy = '';

  const lookUp = async () => {
    found = undefined;
    try { found = await findDriveBackup(); } catch (err) { found = null; toast(err.message, { error: true }); }
    render();
  };

  async function restore() {
    if (settings().setupDone && !(await confirmSheet({ title: 'Restore from Google Drive?', message: 'Everything on this phone is replaced by the backup.', confirmText: 'Restore', danger: true }))) return;
    busy = 'Restoring your expenses…';
    render();
    try {
      const n = await restoreFromDrive();
      toast(`Restored ${n} expense${n === 1 ? '' : 's'}`);
      location.hash = '#/';
    } catch (err) {
      busy = '';
      toast(err.message, { error: true });
      render();
    }
  }

  // Made once and reused, so a redraw doesn't throw away a sign-in code in progress.
  function needSignIn(onDone) {
    signIn ||= googleSignIn(() => { signIn = null; onDone(); });
    return h('div', { class: 'card pad stack' },
      h('b', null, 'Sign in with Google'),
      h('p', { class: 'small muted' }, 'The app can only see files it saves itself. It can\'t see anything else in your Google Drive.'),
      signIn.el);
  }

  function restoreScreen() {
    if (!googleSignedIn()) return [needSignIn(() => { render(); lookUp(); })];
    if (found === undefined) {
      lookUp();
      return [h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), 'Looking for your backup…')];
    }
    if (!found) {
      return [h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' }, 'No backup was found in this Google account. It has to be one this app made, signed in with the same Google account.'))];
    }
    return [
      h('div', { class: 'card pad' }, h('b', null, 'Backup found'), h('div', { class: 'small muted' }, `Last saved ${formatDateTime(Date.parse(found.modifiedTime))}`)),
      h('button', { class: 'btn primary block', onclick: restore }, icon('download'), 'Restore it'),
    ];
  }

  function statusCard() {
    const st = backupState;
    return h('div', { class: 'stack' },
      st.error ? h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'body' }, h('b', null, 'The last backup didn\'t finish. '), st.error)) : null,
      h('div', { class: 'card pad row' }, st.running ? h('span', { class: 'spinner' }) : icon('check'),
        h('div', { class: 'grow' }, st.running ? 'Backing up…' : st.lastAt ? `Last backed up ${formatDateTime(st.lastAt)}` : 'Not backed up yet',
          h('div', { class: 'tiny muted' }, 'After changes, it backs up about once an hour while the app is open.'))),
      h('button', { class: 'btn', disabled: st.running, onclick: () => maybeBackup({ now: true }) }, icon('refresh'), 'Back up now'),
      h('button', { class: 'btn', onclick: () => { location.hash = '#/settings/backup?restore=1'; } }, icon('download'), 'Restore from Google Drive'));
  }

  function render() {
    const mode = backupMode();
    if (busy) return fill(el, topbar({ title: 'Backup', back: () => navBack('#/settings') }), h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), busy));
    if (restoring) {
      return fill(el, topbar({ title: 'Restore from Google Drive', back: () => navBack(settings().setupDone ? '#/settings/backup' : '#/setup') }),
        h('div', { class: 'stack' }, h('p', { class: 'small muted', style: { margin: '0 4px' } }, 'Bring back your expenses, receipt photos and settings from a backup this app saved to Google Drive.'), ...restoreScreen()));
    }
    fill(el,
      topbar({ title: 'Backup', back: () => navBack('#/settings') }),
      h('div', { class: 'stack' },
        h('p', { class: 'small muted', style: { margin: '0 4px' } }, 'Everything is stored on this phone. A backup means nothing is lost if the phone is.'),
        choiceList({ options: BACKUP_MODES, value: mode, onChange: async (id) => { await updateSettings((d) => { d.backup = { ...d.backup, mode: id }; }); if (id === 'drive') maybeBackup({ now: true }); } }),
        mode === 'drive' ? (googleSignedIn() ? statusCard() : needSignIn(() => { render(); maybeBackup({ now: true }); })) : null,
        mode === 'remind' ? h('div', { class: 'stack' },
          h('p', { class: 'small muted', style: { margin: '0 4px' } }, 'Tap Save a backup, choose Save to Files, then pick iCloud Drive (or anywhere you like).'),
          backupState.lastManualAt ? h('div', { class: 'small muted', style: { margin: '0 4px' } }, `Last saved ${formatDateTime(backupState.lastManualAt)}`) : null,
          h('button', { class: 'btn primary', onclick: saveByHand }, icon('download'), 'Save a backup')) : null,
      ));
  }

  render();
  const offs = [on('settings-changed', () => { if (!busy) render(); }), on('backup-changed', () => { if (!busy) render(); })];
  return { el, destroy: () => { signIn?.stop(); offs.forEach((off) => off()); } };
}

// Saves a backup file wherever the user picks (iCloud Drive, Files…) and notes it for the reminder.
export async function saveByHand() {
  const file = await backupFile();
  if (await deliverFiles([file], 'AI Expense Tracker backup')) await noteManualBackup();
}
