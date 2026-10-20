import { loadSettings, settings } from './settings.js';
import { startQueue } from './queue.js';
import { h, icon } from './util.js';
import { HomeView } from './views/home.js';
import { EntryView } from './views/entry.js';
import { ExportView } from './views/export.js';
import { SettingsView } from './views/settings.js';
import { SetupView } from './views/setup.js';

const ROUTES = [
  [/^\/$/, HomeView],
  [/^\/entry\/([^/]+)$/, EntryView],
  [/^\/export$/, ExportView],
  [/^\/settings(?:\/(\w+)(?:\/([\w-]+))?)?$/, SettingsView],
  [/^\/setup$/, SetupView],
];

const appEl = document.getElementById('app');
let active = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

async function render() {
  const { path, query } = parseHash();
  if (!settings().setupDone && path !== '/setup') {
    location.replace('#/setup');
    return;
  }
  let match = null;
  let View = HomeView;
  for (const [re, view] of ROUTES) {
    match = re.exec(path);
    if (match) { View = view; break; }
  }
  const previous = active;
  active = null;
  if (previous?.destroy) await previous.destroy();
  const view = View({ params: match ? match.slice(1) : [], query });
  active = view;
  appEl.replaceChildren(view.el);
  window.scrollTo(0, 0);
}

function showUpdateBar(worker) {
  if (document.querySelector('.update-bar')) return;
  const bar = h('div', { class: 'update-bar' },
    h('div', { class: 'banner ok', style: { boxShadow: 'var(--shadow)', margin: 0 } }, icon('sparkle'),
      h('div', { class: 'body' }, h('b', null, 'A new version is ready.'),
        h('div', null, h('button', { class: 'btn small primary', onclick: () => worker.postMessage('skipWaiting') }, 'Update now')))));
  document.body.append(bar);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const watch = (worker) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(worker);
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg.waiting);
    if (reg.installing) watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    // Check for a new version whenever the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch((err) => console.warn('Service worker registration failed', err));

  // Reload only when an update replaces a running version, never on the very first install.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

async function boot() {
  try {
    await loadSettings();
  } catch (err) {
    appEl.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'banner danger' }, icon('alert'),
      h('div', { class: 'body' }, h('b', null, 'Storage is unavailable. '), 'This can happen in Private Browsing. Open the app normally and try again.'))));
    console.error(err);
    return;
  }
  window.addEventListener('hashchange', render);
  await render();
  startQueue();
  registerServiceWorker();
}

boot();
