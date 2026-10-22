// The "How do you want to talk to it?" chooser, shared by setup and Settings → AI.
// read() returns the voice settings; write(fn) changes them (live settings or the setup draft).

import { ASKABLE, PAUSE_OPTIONS, VOICES, VOICE_MODES, prepareAudio, releaseAudio, speak, stopSpeaking, testVoiceKey, voiceCost, voiceId } from '../speech.js';
import { MODELS } from '../ai.js';
import { choiceList, choiceSheet, field, openSheet, toggleRow } from '../ui.js';
import { fill, h, icon } from '../util.js';
import { apiKeyInput } from './setup.js';

export function voiceChooser({ read, write, model, compact = false }) {
  const wrap = h('div', { class: 'stack' });
  let selected = read().openaiKey ? read().mode || 'keyboard' : 'keyboard';
  let pending = null; // a mode that needs a key the user hasn't added yet
  let keySaved = ''; // success message kept across redraws, so it doesn't vanish

  // Each voice has a play button for a short sample (a fraction of a cent) and is picked by tapping its name.
  const pickVoice = () => openSheet((close) => {
    const list = h('div', { class: 'list' });
    const status = h('div', { class: 'small muted' }, 'Tap ▶ to hear a voice. Tap a name to choose it.');
    let loading = null;
    const draw = () => fill(list, VOICES.map((o) => h('div', { class: 'list-item' },
      h('button', { class: 'icon-btn', 'aria-label': `Play ${o.name}`, onclick: () => play(o) },
        loading === o.id ? h('span', { class: 'spinner' }) : icon('play')),
      h('button', {
        class: 'grow', style: { border: 0, background: 'none', textAlign: 'left', padding: 0, color: 'inherit', font: 'inherit' },
        onclick: async () => { await write((x) => { x.aiVoice = o.id; }); close(); render(); },
      }, h('div', null, o.name), h('div', { class: 'tiny muted' }, o.hint)),
      o.id === voiceId(read()) ? icon('check') : null)));
    const play = async (o) => {
      prepareAudio(); // during the tap, so iOS allows the sound
      loading = o.id;
      draw();
      fill(status, 'Tap ▶ to hear a voice. Tap a name to choose it.');
      try {
        await speak(`Hello, I'm ${o.name}. Tell me what you bought, and I'll log it for you.`, { voice: o.id, key: read().openaiKey, sample: true });
      } catch (e) {
        if (loading === o.id) fill(status, h('span', { style: { color: 'var(--danger)' } }, `Couldn't play ${o.name}: ${e.message}`));
      }
      if (loading === o.id) loading = null;
      draw();
    };
    draw();
    return h('div', { class: 'stack' }, h('h3', null, 'Voice'), status, list,
      h('button', { class: 'btn block', onclick: close }, 'Done'));
  }, { onClose: () => { stopSpeaking(); releaseAudio(); } });

  const render = () => {
    const v = read();
    const shown = pending || selected;
    const modelName = MODELS.find((m) => m.id === model())?.name || 'your AI setting';
    const options = VOICE_MODES.map((m) => ({ id: m.id, name: m.name, hint: `${m.hint} About ${voiceCost(m.id, model()).replace('~', '')} per entry.` }));

    const keyCard = () => {
      const { input, row } = apiKeyInput(v.openaiKey);
      input.placeholder = 'sk-…';
      const status = h('div', { class: 'small' },
        keySaved ? h('div', { class: 'banner ok', style: { margin: 0 } }, icon('check'), h('div', { class: 'body' }, keySaved)) : null);
      const save = async () => {
        keySaved = '';
        const key = input.value.trim();
        if (!key) { fill(status, h('span', { class: 'muted' }, 'Paste your OpenAI key first.')); return; }
        fill(status, h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Checking your key…'));
        const res = await testVoiceKey(key);
        if (!res.ok) { fill(status, h('span', { style: { color: 'var(--danger)' } }, res.message)); return; }
        await write((x) => { x.openaiKey = key; x.mode = pending || selected; });
        selected = pending || selected;
        pending = null;
        keySaved = `Key works and is saved. "${VOICE_MODES.find((m) => m.id === selected)?.name}" is on; tap Talk to It on the home screen to try it.`;
        render();
      };
      return h('div', { class: 'card pad stack' },
        h('b', null, v.openaiKey ? 'Your OpenAI key' : 'This option needs an OpenAI key'),
        h('p', { class: 'small muted' }, 'OpenAI provides the voice; you pay them directly for what you use, like the Anthropic account. $5 of credit lasts a long time.'),
        v.openaiKey ? null : h('ol', { class: 'steps' },
          h('li', null, h('div', null, 'Go to ', h('a', { href: 'https://platform.openai.com/api-keys', target: '_blank', rel: 'noopener' }, 'platform.openai.com'), ' and sign in or create an account.')),
          h('li', null, h('div', null, 'Under ', h('b', null, 'Billing'), ', add a little credit. Turn on auto-recharge if you like.')),
          h('li', null, h('div', null, 'Under ', h('b', null, 'API keys'), ', create a key, copy it and paste it below.'))),
        field('OpenAI API key', row),
        h('button', { class: 'btn primary', onclick: save }, v.openaiKey ? 'Save & test key' : 'Save key'),
        status);
    };

    fill(wrap,
      compact ? null : h('p', { class: 'small muted' }, `Estimated costs are for your current AI setting (${modelName}) and change if you switch it.`),
      choiceList({
        options,
        value: shown,
        onChange: async (id) => {
          if (id === 'keyboard' || read().openaiKey) {
            pending = null;
            selected = id;
            await write((x) => { x.mode = id; });
          } else {
            pending = id;
          }
          render();
        },
      }),
      pending || (selected !== 'keyboard' && !compact) ? keyCard() : null,
      selected !== 'keyboard' && !pending ? h('div', { class: 'stack' },
        h('div', { class: 'section-title', style: { margin: '8px 4px 0' } }, 'If I leave it out, ask me for…'),
        h('div', { class: 'list' },
          h('div', { class: 'toggle-row' }, h('div', { class: 'grow' }, h('div', null, 'Amount and what I bought'), h('div', { class: 'tiny muted' }, 'Always asked'))),
          ASKABLE.map((a) => toggleRow({
            label: a.name,
            hint: a.id === 'date' ? 'Off: assumes today unless you say otherwise.' : null,
            checked: (v.askFor || []).includes(a.id),
            onChange: (on) => write((x) => {
              const set = new Set(x.askFor || []);
              if (on) set.add(a.id); else set.delete(a.id);
              x.askFor = ASKABLE.map((y) => y.id).filter((id) => set.has(id));
            }),
          })),
        )) : null,
      selected !== 'keyboard' && !pending ? h('div', { class: 'list' },
        h('button', { class: 'list-item', onclick: pickVoice }, icon('speaker'), h('div', { class: 'grow' }, 'Voice'),
          h('span', { class: 'value small' }, VOICES.find((o) => o.id === voiceId(v)).name), h('span', { class: 'chev' }, icon('chevron'))),
        selected === 'live' ? toggleRow({
          label: 'Let me interrupt it',
          hint: 'Lets you talk over it. Best with headphones or AirPods; on the speaker it can hear itself and stop mid-sentence.',
          checked: v.allowInterrupt === true,
          onChange: (on) => write((x) => { x.allowInterrupt = on; }),
        }) : null,
        selected === 'spoken' ? toggleRow({ label: 'Talk back out loud', hint: 'Off: questions are shown on screen only.', checked: v.talkBack !== false, onChange: (on) => write((x) => { x.talkBack = on; }) }) : null,
        selected === 'spoken' ? h('button', { class: 'list-item', onclick: async () => {
          const p = await choiceSheet({ title: 'Pause before it stops listening', options: PAUSE_OPTIONS.map((o) => ({ label: o.name, hint: o.hint, value: o.id, selected: o.id === v.pause })) });
          if (!p) return;
          await write((x) => { x.pause = p; });
          render();
        } }, icon('clock'), h('div', { class: 'grow' }, 'Pause before it stops listening'),
        h('span', { class: 'value small' }, PAUSE_OPTIONS.find((o) => o.id === v.pause)?.name || 'Normal'), h('span', { class: 'chev' }, icon('chevron'))) : null,
      ) : null,
    );
  };
  render();
  return wrap;
}
