// Shown instead of the app when it's opened in a browser tab: the app only runs once it's installed
// to the Home Screen (or as a desktop app), so it feels like a real install.

import { openSheet } from '../ui.js';
import { fill, h, icon, isIOS, shareGlyph } from '../util.js';

// Chrome/Edge/Android hand us this event so a button can trigger the real install prompt.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

const ua = navigator.userAgent;
// Browsers inside other apps (Gmail, Facebook, Instagram, etc.) can't add to the Home Screen.
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|GSA\/|LinkedInApp|Snapchat|Twitter|; wv\)|WebView/i.test(ua);
const android = /Android/i.test(ua);
const firefox = /Firefox|FxiOS/i.test(ua);
const iosSafari = isIOS() && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);

// Local development keeps working in a normal tab (automated tests run there).
export function installRequired() {
  const dev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !/install-gate/.test(location.search);
  return !dev;
}

function steps(items) {
  return h('ol', { class: 'steps' }, items.map((content) => h('li', null, h('div', null, ...[].concat(content)))));
}

function showInstructions() {
  let title = 'Install the app';
  let body;
  if (inAppBrowser) {
    title = 'Open it in your browser first';
    const copy = h('button', { class: 'btn block', onclick: async () => {
      try { await navigator.clipboard.writeText(location.href); copy.textContent = 'Link copied'; } catch { /* shown below */ }
    } }, icon('share'), 'Copy link');
    body = [
      h('p', { class: 'muted' }, 'This page is open inside another app, which can\'t install apps.'),
      steps([
        isIOS() ? ['Tap the ', h('b', null, '•••'), ' or compass button and choose ', h('b', null, 'Open in Safari'), ', or copy the link below and paste it into Safari.'] : ['Open the menu and choose ', h('b', null, 'Open in Chrome'), ', or copy the link below and paste it into Chrome.'],
        'Then tap Install App again.',
      ]),
      copy,
    ];
  } else if (isIOS()) {
    body = [
      steps([
        ['Tap the ', h('b', null, 'Share'), ' button ', shareGlyph(), iosSafari ? ' in Safari\'s toolbar (if you don\'t see it, tap ' : ' next to the address bar.', iosSafari ? h('b', null, '•••') : null, iosSafari ? ' first).' : null],
        ['Scroll down and tap ', h('b', null, 'Add to Home Screen'), '.'],
        ['Tap ', h('b', null, 'Add'), '. Then open ', h('b', null, 'AI Expenses'), ' from your Home Screen.'],
      ]),
      h('p', { class: 'small muted' }, 'After that, use the Home Screen icon. It opens like any other app and works offline.'),
    ];
  } else if (firefox) {
    body = [h('p', { class: 'muted' }, 'Firefox can\'t install apps. Open this page in Chrome, Edge or Safari, then tap Install App.')];
  } else if (android) {
    body = [steps([
      ['Tap the ', h('b', null, '⋮'), ' menu in the corner of your browser.'],
      ['Tap ', h('b', null, 'Install app'), ' (or ', h('b', null, 'Add to Home screen'), ').'],
      ['Open ', h('b', null, 'AI Expenses'), ' from your home screen.'],
    ])];
  } else {
    body = [steps([
      ['In Chrome or Edge, click the ', h('b', null, 'install'), ' icon at the right end of the address bar (or menu → ', h('b', null, 'Install AI Expense Tracker'), ').'],
      'The app opens in its own window. You can also find it with your other apps.',
    ])];
  }
  openSheet((close) => h('div', { class: 'stack' }, h('h3', null, title), ...body, h('button', { class: 'btn primary block', onclick: close }, 'Got it')));
}

export function InstallView() {
  const el = h('div', { class: 'page' });
  const status = h('div');

  const install = async () => {
    // One-tap install where the browser supports it (Chrome, Edge, Android); iPhones always need the Share menu.
    if (installPrompt && !isIOS() && !inAppBrowser) {
      try {
        installPrompt.prompt();
        const { outcome } = await installPrompt.userChoice;
        installPrompt = null;
        if (outcome === 'accepted') {
          fill(status, h('div', { class: 'banner ok' }, icon('check'), h('div', { class: 'body' },
            h('b', null, 'Installed. '), 'Open AI Expense Tracker from your home screen or app list.')));
        }
        return;
      } catch {
        installPrompt = null; // fall through to the written steps
      }
    }
    showInstructions();
  };

  el.append(h('div', { class: 'setup' },
    h('img', { class: 'hero-icon', src: 'icons/icon-192.png', alt: '' }),
    h('h2', null, 'AI Expense Tracker'),
    h('p', { class: 'lead' }, 'Snap a receipt or just say what you spent. AI logs it for your books.'),
    h('div', { class: 'content' },
      h('div', { class: 'list' },
        h('div', { class: 'list-item' }, icon('phone'), h('div', null, h('b', null, 'Install to get started'), h('div', { class: 'small muted' }, 'It takes about 10 seconds and doesn\'t need the App Store.'))),
        h('div', { class: 'list-item' }, icon('cloudOff'), h('div', null, h('b', null, 'Works offline'), h('div', { class: 'small muted' }, 'Once installed, it opens even with no signal.'))),
      ),
      status,
    ),
    h('div', { class: 'footer', style: { flexDirection: 'column' } },
      h('button', { class: 'btn primary block', onclick: install }, icon('download'), 'Install App'),
      h('p', { class: 'tiny muted center', style: { marginTop: '6px' } }, 'Already installed? Open it from your Home Screen.'),
    ),
  ));
  return { el };
}
