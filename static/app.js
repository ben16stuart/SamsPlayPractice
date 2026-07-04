/* Sam's Play Practice — front end.
 * The Flask backend (/api/parse) analyzes the pasted script into dialogue,
 * song cues, and stage directions. Speech happens in the browser with two
 * switchable engines:
 *   - Web Speech API (built into the browser, instant)
 *   - Kokoro (kokoro-js, in-browser neural TTS, lazy-loaded on first use)
 */

// ---------------------------------------------------------------------------
// TTS engines
// ---------------------------------------------------------------------------

class WebSpeechEngine {
  constructor() { this.name = 'webspeech'; }
  async init(onStatus) {
    // Voices may load asynchronously
    let voices = speechSynthesis.getVoices();
    if (!voices.length) {
      voices = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
        speechSynthesis.onvoiceschanged = () => { clearTimeout(t); resolve(speechSynthesis.getVoices()); };
      });
    }
    const en = voices.filter(v => v.lang.startsWith('en'));
    this.voices = (en.length ? en : voices).map(v => ({ id: v.voiceURI, label: `${v.name} (${v.lang})`, raw: v }));
    if (!this.voices.length) onStatus?.('No browser voices found — try the Kokoro engine instead.');
  }
  async speak(text, voiceId, rate, signal) {
    if (!text) return;
    await new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.voices.find(x => x.id === voiceId);
      if (v) { u.voice = v.raw; u.lang = v.raw.lang; }
      u.rate = rate;
      const onAbort = () => { speechSynthesis.cancel(); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
      u.onend = () => { signal.removeEventListener('abort', onAbort); resolve(); };
      u.onerror = (e) => {
        signal.removeEventListener('abort', onAbort);
        e.error === 'canceled' || e.error === 'interrupted' ? resolve() : reject(new Error(e.error));
      };
      speechSynthesis.cancel(); // clear any stuck queue
      speechSynthesis.speak(u);
    });
  }
  stop() { speechSynthesis.cancel(); }
}

const KOKORO_VOICES = [
  ['af_heart',    'Heart — US female, warm'],
  ['af_bella',    'Bella — US female, bright'],
  ['af_nicole',   'Nicole — US female, soft'],
  ['af_sarah',    'Sarah — US female'],
  ['af_sky',      'Sky — US female, young'],
  ['am_adam',     'Adam — US male, deep'],
  ['am_michael',  'Michael — US male'],
  ['am_puck',     'Puck — US male, lively'],
  ['am_fenrir',   'Fenrir — US male, gruff'],
  ['bf_emma',     'Emma — UK female'],
  ['bf_isabella', 'Isabella — UK female'],
  ['bm_george',   'George — UK male'],
  ['bm_lewis',    'Lewis — UK male'],
  ['bm_fable',    'Fable — UK male, storyteller'],
];

class KokoroEngine {
  constructor() {
    this.name = 'kokoro';
    this.voices = KOKORO_VOICES.map(([id, label]) => ({ id, label }));
    this.tts = null;
    this.currentAudio = null;
  }
  async init(onStatus) {
    if (this.tts) return;
    onStatus?.('Loading Kokoro (one-time ~80 MB model download — this can take a few minutes)…');
    const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
    const device = navigator.gpu ? 'webgpu' : 'wasm';
    this.tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      device,
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          onStatus?.(`Downloading Kokoro model: ${p.file} — ${Math.round(100 * p.loaded / p.total)}%`);
        }
      },
    });
    onStatus?.(`Kokoro ready (running on ${device}). Voices are generated on the fly.`);
  }
  async speak(text, voiceId, rate, signal) {
    if (!text || !this.tts) return;
    const audio = await this.tts.generate(text, { voice: voiceId || 'af_heart', speed: rate });
    if (signal.aborted) return;
    const url = URL.createObjectURL(audio.toBlob());
    try {
      await new Promise((resolve, reject) => {
        const el = new Audio(url);
        this.currentAudio = el;
        const onAbort = () => { el.pause(); resolve(); };
        signal.addEventListener('abort', onAbort, { once: true });
        el.onended = () => { signal.removeEventListener('abort', onAbort); resolve(); };
        el.onerror = () => { signal.removeEventListener('abort', onAbort); reject(new Error('audio playback failed')); };
        el.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(url);
      this.currentAudio = null;
    }
  }
  stop() { this.currentAudio?.pause(); }
}

const engines = { webspeech: new WebSpeechEngine(), kokoro: new KokoroEngine() };

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  items: [],
  roles: [],                 // [{name, count}] from the server
  songs: [],                 // detected song titles
  voiceByRole: new Map(),    // role -> voiceId
  songFiles: new Map(),      // song title -> object URL
  engine: engines.webspeech,
  myRole: '',
  playing: false,
  paused: false,
  index: 0,
  abort: null,               // AbortController for the current utterance
  waitResolve: null,         // resolver for "wait for me" mode
};

const ROLE_COLORS = ['#3b82f6', '#ef4444', '#0ea5e9', '#e11d48', '#14b8a6',
  '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#f59e0b', '#ec4899', '#10b981'];

const $ = (id) => document.getElementById(id);

function roleColor(role) {
  const i = state.roles.findIndex(r => r.name === role);
  return ROLE_COLORS[(i >= 0 ? i : 0) % ROLE_COLORS.length];
}

// ---------------------------------------------------------------------------
// Analyze (server-side parse)
// ---------------------------------------------------------------------------

async function analyzeScript() {
  const text = $('script-input').value;
  const btn = $('parse-btn');
  btn.disabled = true;
  btn.textContent = '🎩 Reading the script…';
  let data;
  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: text, use_ai: true }),
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    data = await res.json();
  } catch (e) {
    alert(`Could not analyze the script (${e.message}). Is the Flask server running?`);
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Analyze script & find roles';
  }

  const status = $('parse-status');
  status.classList.remove('hidden');
  status.textContent = data.parser === 'ai'
    ? '✨ Cast, songs, and lines extracted by Claude AI.'
    : `🔍 Parsed with the pattern parser. ${data.note || ''}`;

  state.items = data.items;
  state.roles = data.roles;
  state.songs = data.songs;

  if (!state.roles.length) {
    alert('No character lines found. Make sure lines look like "NAME: dialogue" or have the character name on its own line.');
    return;
  }

  // Default "my role" to SAM if present
  const sam = state.roles.find(r => /\bSAM\b/.test(r.name));
  state.myRole = sam ? sam.name : state.roles[0].name;

  stopAll();
  autoAssignVoices();
  renderMyRoleSelect();
  renderRoles();
  await loadSavedSongs();
  renderSongs();
  renderScriptView();
  $('setup-section').classList.remove('hidden');
  $('play-section').classList.remove('hidden');
  $('input-details').open = false;   // script is in — tuck the input away
  $('setup-details').open = true;
  $('setup-section').scrollIntoView({ behavior: 'smooth' });
  scheduleSave();
}

function autoAssignVoices() {
  const voices = state.engine.voices || [];
  state.voiceByRole.clear();
  if (!voices.length) return;
  // Spread distinct voices across roles; narrator gets the last one.
  state.roles.forEach((r, i) => state.voiceByRole.set(r.name, voices[i % voices.length].id));
  state.voiceByRole.set('__narrator__', voices[voices.length - 1].id);
}

// ---------------------------------------------------------------------------
// Setup UI (roles, voices, songs)
// ---------------------------------------------------------------------------

function renderMyRoleSelect() {
  const sel = $('my-role-select');
  sel.innerHTML = '';
  for (const r of state.roles) {
    const opt = document.createElement('option');
    opt.value = r.name;
    opt.textContent = `${r.name} (${r.count} lines)`;
    if (r.name === state.myRole) opt.selected = true;
    sel.appendChild(opt);
  }
}

function voiceSelect(role) {
  const sel = document.createElement('select');
  for (const v of state.engine.voices || []) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    if (state.voiceByRole.get(role) === v.id) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => { state.voiceByRole.set(role, sel.value); scheduleSave(); };
  return sel;
}

function renderRoles() {
  const list = $('roles-list');
  list.innerHTML = '';
  const rows = [...state.roles.map(r => [r.name, `${r.count} lines`]), ['__narrator__', 'directions']];
  for (const [role, countLabel] of rows) {
    if (role === '__narrator__' && !$('read-directions').checked) continue;
    const row = document.createElement('div');
    row.className = 'role-row';
    const badge = document.createElement('span');
    badge.className = 'role-badge';
    badge.textContent = role === '__narrator__' ? 'NARRATOR' : role;
    badge.style.background = role === '__narrator__' ? '#4b5563' : roleColor(role);
    const count = document.createElement('span');
    count.className = 'role-count';
    count.textContent = countLabel;
    const preview = document.createElement('button');
    preview.className = 'preview-btn';
    preview.textContent = '🔊';
    preview.title = 'Preview this voice';
    preview.onclick = async () => {
      const ok = await ensureEngineReady();
      if (!ok) return;
      const ac = new AbortController();
      const name = role === '__narrator__' ? 'the narrator' : role;
      try { await state.engine.speak(`Hello! I will be reading for ${name}.`, state.voiceByRole.get(role), rate(), ac.signal); }
      catch (e) { console.error(e); }
    };
    row.append(badge, voiceSelect(role), count, preview);
    list.appendChild(row);
  }
}

// --- persistent show sessions (everything saved per show on the server) ---

let restoring = false;
let saveTimer = null;

function snapshot() {
  return {
    displayName: playName(),
    script: $('script-input').value,
    items: state.items,
    roles: state.roles,
    songs: state.songs,
    songSources: Object.fromEntries([...state.songFiles].filter(([, u]) => !u.startsWith('blob:'))),
    voices: Object.fromEntries(state.voiceByRole),
    engine: $('engine-select').value,
    myRole: state.myRole,
    myLineMode: $('my-line-mode').value,
    rate: $('rate-slider').value,
    gap: $('gap-slider').value,
    readDirections: $('read-directions').checked,
    hideMyLines: $('hide-my-lines').checked,
    index: state.index,
    savedAt: Date.now(),
  };
}

function scheduleSave() {
  if (restoring || !state.items.length) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ play: playName(), state: snapshot() }),
      });
    } catch { /* saving is best-effort; next change retries */ }
  }, 600);
}

async function restorePlay() {
  let data;
  try {
    const res = await fetch(`/api/play?play=${encodeURIComponent(playName())}`);
    data = await res.json();
  } catch { return false; }
  if (!data.exists || !data.state?.items?.length) return false;

  const s = data.state;
  restoring = true;
  try {
    $('script-input').value = s.script || '';
    state.items = s.items;
    state.roles = s.roles || [];
    state.songs = s.songs || [];
    state.myRole = s.myRole || (state.roles[0] && state.roles[0].name) || '';
    $('engine-select').value = s.engine || 'webspeech';
    state.engine = engines[$('engine-select').value];
    $('my-line-mode').value = s.myLineMode || 'wait';
    $('rate-slider').value = s.rate || 1;
    $('gap-slider').value = s.gap || 1;
    $('rate-value').textContent = `${rate().toFixed(1)}×`;
    $('gap-value').textContent = `${gapScale().toFixed(2)}×`;
    $('read-directions').checked = !!s.readDirections;
    $('hide-my-lines').checked = !!s.hideMyLines;

    state.songFiles = new Map(Object.entries(s.songSources || {}));
    if (state.engine.name === 'webspeech') await state.engine.init().catch(() => {});
    autoAssignVoices(); // defaults for anything the save doesn't cover
    for (const [role, voice] of Object.entries(s.voices || {})) state.voiceByRole.set(role, voice);

    renderMyRoleSelect();
    renderRoles();
    renderSongs();
    renderScriptView();
    $('setup-section').classList.remove('hidden');
    $('play-section').classList.remove('hidden');
    $('input-details').open = false;

    state.index = Math.min(s.index || 0, state.items.length - 1);
    if (state.index > 0) markCurrent(state.index);

    const status = $('parse-status');
    status.classList.remove('hidden');
    status.textContent = `⏪ Restored “${s.displayName || playName()}” — ${state.items.length} lines` +
      (state.index > 0 ? `, ready to resume at line ${state.index + 1}. Press Play.` : '. Press Play.');
  } finally {
    restoring = false;
  }
  return true;
}

async function refreshPlaysList() {
  try {
    const data = await (await fetch('/api/plays')).json();
    $('plays-list').innerHTML = '';
    for (const name of data.plays || []) {
      const opt = document.createElement('option');
      opt.value = name;
      $('plays-list').appendChild(opt);
    }
  } catch { /* picker is a nicety */ }
}

// --- persistent music library (saved per show on the server) ---

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';
const playName = () => $('play-name').value.trim() || 'my-play';
const YOUTUBE_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;

async function loadSavedSongs() {
  try {
    const res = await fetch(`/api/songs?play=${encodeURIComponent(playName())}`);
    const data = await res.json();
    const byStem = new Map((data.songs || []).map(s => [s.stem, s.url]));
    for (const title of state.songs) {
      const url = byStem.get(slug(title));
      if (url) state.songFiles.set(title, url);
    }
  } catch { /* offline server list is best-effort */ }
}

function setSongSource(title, url) {
  const old = state.songFiles.get(title);
  if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
  state.songFiles.set(title, url);
  renderScriptView();
  if (state.playing) markCurrent(state.index);
  scheduleSave();
}

function renderSongs() {
  $('songs-block').classList.toggle('hidden', !state.songs.length);
  const list = $('songs-list');
  list.innerHTML = '';
  for (const title of state.songs) {
    const row = document.createElement('div');
    row.className = 'song-row';
    const label = document.createElement('span');
    label.className = 'song-title';
    label.textContent = `🎵 ${title}`;

    const status = document.createElement('span');
    status.className = 'song-status';
    const setStatus = (msg) => {
      if (msg) { status.textContent = msg; return; }
      const src = state.songFiles.get(title);
      status.textContent = !src ? 'no audio — will be announced instead'
        : src.startsWith('blob:') ? 'file attached (this session only)'
        : src.startsWith('/media/') ? `saved for this show ✔ (${src.split('/').pop()})`
        : `linked ✔ (${src.length > 40 ? src.slice(0, 40) + '…' : src})`;
    };
    setStatus();

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.onchange = async () => {
      const f = fileInput.files[0];
      if (!f) return;
      urlInput.value = '';
      setStatus(`saving ${f.name}…`);
      const form = new FormData();
      form.append('audio', f);
      form.append('play', playName());
      form.append('title', title);
      try {
        const res = await fetch('/api/upload_song', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setSongSource(title, data.url);
      } catch {
        setSongSource(title, URL.createObjectURL(f)); // still usable this session
      }
      setStatus();
    };

    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.placeholder = 'or paste a YouTube link / direct audio URL…';
    const src = state.songFiles.get(title);
    if (src && !src.startsWith('blob:') && !src.startsWith('/media/')) urlInput.value = src;
    urlInput.onchange = async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      fileInput.value = '';
      if (YOUTUBE_RE.test(url)) {
        setStatus('⬇️ downloading audio from YouTube — this can take a minute…');
        try {
          const res = await fetch('/api/download_song', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, play: playName(), title }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
          setSongSource(title, data.url);
          urlInput.value = '';
          setStatus();
        } catch (e) {
          setStatus(`⚠️ ${e.message}`);
        }
        return;
      }
      setSongSource(title, url);
      setStatus();
    };

    const preview = document.createElement('button');
    preview.className = 'preview-btn';
    preview.textContent = '🔊';
    preview.title = 'Test this audio (plays a few seconds)';
    preview.onclick = () => {
      const src = state.songFiles.get(title);
      if (!src) { status.textContent = 'nothing attached yet'; return; }
      const el = new Audio(src);
      el.play().then(() => setTimeout(() => el.pause(), 4000))
        .catch(() => { status.textContent = '⚠️ could not play — check the link is a direct audio file'; });
    };

    row.append(label, fileInput, urlInput, preview, status);
    list.appendChild(row);
  }
}

// --- inserting / removing song cues in the script ---

function insertSongAfter(i) {
  const title = prompt('Song name (as it should appear in the script):');
  if (!title || !title.trim()) return;
  const clean = title.trim();
  state.items.splice(i + 1, 0, { type: 'song', title: clean });
  if (!state.songs.includes(clean)) state.songs.push(clean);
  if (state.playing && state.index > i) state.index++;
  renderSongs();
  renderScriptView();
  if (state.playing) markCurrent(state.index);
  scheduleSave();
}

function removeSongAt(i) {
  const [removed] = state.items.splice(i, 1);
  if (!state.items.some(x => x.type === 'song' && x.title === removed.title)) {
    state.songs = state.songs.filter(t => t !== removed.title);
  }
  if (state.playing && state.index > i) state.index--;
  renderSongs();
  renderScriptView();
  if (state.playing) markCurrent(state.index);
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Teleprompter view
// ---------------------------------------------------------------------------

function renderScriptView() {
  const view = $('prompter-lines');
  view.innerHTML = '';
  const hideMine = $('hide-my-lines').checked;
  state.items.forEach((it, i) => {
    const div = document.createElement('div');
    div.className = `line ${it.type}`;
    div.dataset.index = i;
    const who = document.createElement('span');
    who.className = 'who';
    const what = document.createElement('span');
    what.className = 'what';
    if (it.type === 'dialogue') {
      who.textContent = it.role;
      who.style.color = roleColor(it.role);
      what.textContent = it.display;
      if (it.role === state.myRole) {
        div.classList.add('mine');
        if (hideMine) what.classList.add('masked');
      }
    } else if (it.type === 'song') {
      who.textContent = '🎵 SONG';
      what.textContent = it.title + (state.songFiles.get(it.title) ? '' : '  (no audio attached)');
    } else {
      who.textContent = '✧';
      what.textContent = `(${it.text})`;
    }
    div.onclick = () => startFrom(i);

    const tools = document.createElement('span');
    tools.className = 'line-tools';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+🎵';
    addBtn.title = 'Insert music after this line';
    addBtn.onclick = (e) => { e.stopPropagation(); insertSongAfter(i); };
    tools.appendChild(addBtn);
    if (it.type === 'song') {
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'Remove this music cue';
      delBtn.onclick = (e) => { e.stopPropagation(); removeSongAt(i); };
      tools.appendChild(delBtn);
    }

    div.append(who, what, tools);
    view.appendChild(div);
  });
}

function markCurrent(i) {
  document.querySelectorAll('.line.current').forEach(el => el.classList.remove('current'));
  const el = document.querySelector(`.line[data-index="${i}"]`);
  if (el) {
    el.classList.add('current');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  $('progress-fill').style.width = `${(100 * (i + 1)) / Math.max(1, state.items.length)}%`;
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Playback engine
// ---------------------------------------------------------------------------

const rate = () => parseFloat($('rate-slider').value);
const gapScale = () => parseFloat($('gap-slider').value);

function beep(signal) {
  return new Promise((resolve) => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    let done = false;
    const stop = () => { if (done) return; done = true; osc.stop(); ctx.close(); resolve(); };
    setTimeout(stop, 250);
    signal.addEventListener('abort', stop, { once: true });
  });
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function waitForContinue(signal) {
  $('continue-btn').classList.remove('hidden');
  return new Promise((resolve) => {
    const cleanup = () => {
      $('continue-btn').classList.add('hidden');
      state.waitResolve = null;
    };
    state.waitResolve = () => { cleanup(); resolve(); };
    signal.addEventListener('abort', () => { if (state.waitResolve) { cleanup(); resolve(); } }, { once: true });
  });
}

function playSongFile(url, signal) {
  return new Promise((resolve, reject) => {
    const el = new Audio(url);
    const onAbort = () => { el.pause(); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
    el.onended = () => { signal.removeEventListener('abort', onAbort); resolve(); };
    el.onerror = () => { signal.removeEventListener('abort', onAbort); reject(new Error('song playback failed')); };
    el.play().catch(reject);
  });
}

async function playItem(it, signal) {
  const mode = $('my-line-mode').value;
  if (it.type === 'dialogue') {
    if (it.role === state.myRole) {
      switch (mode) {
        case 'skip': return;
        case 'speak':
          return state.engine.speak(it.speak, state.voiceByRole.get(it.role), rate(), signal);
        case 'beep':
          await beep(signal);
          return wait(1000 * gapScale(), signal);
        case 'timed': {
          // ~150 words/min speaking pace, scaled by the gap slider, min 2s
          const words = it.speak.split(/\s+/).length;
          return wait(Math.max(2000, words * 400) * gapScale(), signal);
        }
        case 'wait':
        default:
          return waitForContinue(signal);
      }
    }
    return state.engine.speak(it.speak, state.voiceByRole.get(it.role), rate(), signal);
  }
  if (it.type === 'song') {
    const url = state.songFiles.get(it.title);
    if (url) return playSongFile(url, signal);
    return state.engine.speak(`Song: ${it.title}`, state.voiceByRole.get('__narrator__'), rate(), signal);
  }
  if (it.type === 'direction' && $('read-directions').checked) {
    return state.engine.speak(it.text, state.voiceByRole.get('__narrator__'), rate(), signal);
  }
}

async function playLoop() {
  state.playing = true;
  updateTransport();
  while (state.playing && state.index < state.items.length) {
    if (state.paused) { await new Promise(r => setTimeout(r, 150)); continue; }
    const i = state.index;
    markCurrent(i);
    state.abort = new AbortController();
    try {
      await playItem(state.items[i], state.abort.signal);
    } catch (e) {
      console.error('Playback error:', e);
      const status = $('engine-status');
      status.classList.remove('hidden');
      status.textContent = `Playback error: ${e.message}`;
    }
    if (!state.playing) break;
    if (state.index === i) state.index++; // only advance if user didn't jump
    await new Promise(r => setTimeout(r, 250)); // small beat between lines
  }
  if (state.index >= state.items.length) state.index = 0;
  state.playing = false;
  state.paused = false;
  updateTransport();
}

function startFrom(i) {
  state.index = i;
  markCurrent(i);
  if (state.playing) {
    state.abort?.abort();   // cancel current utterance; loop picks up new index
    state.paused = false;
    updateTransport();
  }
}

async function play() {
  if (state.playing) { state.paused = false; updateTransport(); return; }
  const ok = await ensureEngineReady();
  if (!ok) return;
  // Showtime: collapse the settings so the screen is (almost) all script.
  $('input-details').open = false;
  $('setup-details').open = false;
  playLoop();
}

function pause() {
  state.paused = true;
  state.abort?.abort();
  state.engine.stop();
  updateTransport();
}

function stopAll() {
  state.playing = false;
  state.paused = false;
  state.abort?.abort();
  state.engine.stop();
  state.index = 0;
  document.querySelectorAll('.line.current').forEach(el => el.classList.remove('current'));
  $('progress-fill').style.width = '0%';
  updateTransport();
}

function updateTransport() {
  document.body.classList.toggle('performing', state.playing);
  $('play-btn').textContent = state.playing && !state.paused ? '🎬 Performing…' : '▶ Play';
  $('play-btn').disabled = state.playing && !state.paused;
  $('pause-btn').disabled = !state.playing || state.paused;
  $('stop-btn').disabled = !state.playing;
  if (!state.playing) $('continue-btn').classList.add('hidden');
}

async function ensureEngineReady() {
  const status = $('engine-status');
  try {
    status.classList.remove('hidden');
    await state.engine.init((msg) => { status.textContent = msg; });
    if (state.engine.name === 'webspeech') status.classList.add('hidden');
    if (![...state.voiceByRole.values()].length) autoAssignVoices();
    return true;
  } catch (e) {
    status.textContent = `Could not load engine: ${e.message}. ` +
      (state.engine.name === 'kokoro'
        ? 'Check your internet connection (needed once for the model download), or switch back to Browser voices.'
        : '');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('parse-btn').onclick = analyzeScript;
$('sample-btn').onclick = () => { $('script-input').value = SAMPLE_SCRIPT; analyzeScript(); };

const EXTRACT_METHODS = {
  'text-layer': 'from the PDF text layer (no AI)',
  'tesseract': 'with local Tesseract OCR (no AI)',
  'ai-vision': 'with Claude AI vision',
};

async function extractUpload(endpoint, form, label) {
  const status = $('pdf-status');
  status.classList.remove('hidden');
  status.textContent = `⏳ Reading ${label}…`;
  try {
    const res = await fetch(endpoint, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
    $('script-input').value = data.text;
    status.textContent = `✅ Extracted ${label} ${EXTRACT_METHODS[data.method] || ''} — review the text, then Analyze.`;
  } catch (e) {
    status.textContent = `⚠️ ${e.message}`;
  }
}

$('pdf-btn').onclick = () => $('pdf-input').click();
$('pdf-input').onchange = () => {
  const file = $('pdf-input').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('pdf', file);
  extractUpload('/api/extract_pdf', form, file.name);
  $('pdf-input').value = ''; // allow re-selecting the same file
};

$('photo-btn').onclick = () => $('photo-input').click();
$('photo-input').onchange = () => {
  const files = [...$('photo-input').files];
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('images', f);
  extractUpload('/api/extract_image', form,
    files.length === 1 ? files[0].name : `${files.length} photos`);
  $('photo-input').value = '';
};

$('engine-select').onchange = async () => {
  stopAll();
  state.engine = engines[$('engine-select').value];
  const ok = await ensureEngineReady();
  if (ok) { autoAssignVoices(); renderRoles(); }
  scheduleSave();
};

$('my-role-select').onchange = () => {
  state.myRole = $('my-role-select').value;
  renderScriptView();
  scheduleSave();
};

$('my-line-mode').onchange = scheduleSave;

$('play-name').value = localStorage.getItem('playName') || '';
$('play-name').onchange = async () => {
  localStorage.setItem('playName', $('play-name').value.trim());
  if (await restorePlay()) return;
  // No saved session under this name — keep what's on screen and re-map music
  for (const [title, src] of [...state.songFiles]) {
    if (src.startsWith('/media/')) state.songFiles.delete(title);
  }
  await loadSavedSongs();
  renderSongs();
  renderScriptView();
  scheduleSave(); // adopt the current session under the new show name
};

$('read-directions').onchange = () => { renderRoles(); scheduleSave(); };
$('hide-my-lines').onchange = () => { renderScriptView(); scheduleSave(); };
$('rate-slider').oninput = () => { $('rate-value').textContent = `${rate().toFixed(1)}×`; scheduleSave(); };
$('gap-slider').oninput = () => { $('gap-value').textContent = `${gapScale().toFixed(2)}×`; scheduleSave(); };

$('play-btn').onclick = play;
$('pause-btn').onclick = pause;
$('stop-btn').onclick = stopAll;
$('prev-btn').onclick = () => startFrom(Math.max(0, state.index - 1));
$('next-btn').onclick = () => startFrom(Math.min(state.items.length - 1, state.index + 1));
$('continue-btn').onclick = () => state.waitResolve?.();

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && state.waitResolve && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    state.waitResolve();
  }
});

// Init browser voices up front so the cast list has voices immediately
engines.webspeech.init().catch(() => {});

// Restore the remembered show, if it has a saved session
(async () => {
  refreshPlaysList();
  if ($('play-name').value.trim()) await restorePlay();
})();

// ---------------------------------------------------------------------------
// Sample script
// ---------------------------------------------------------------------------

const SAMPLE_SCRIPT = `ACT I, SCENE 1

(The curtain rises on a small-town theater. SAM stands center stage, clutching a script.)

SAM: I can't believe opening night is only a week away. I still don't know half my lines!

DOROTHY: You'll be wonderful, Sam. You just need to practice. Here — I'll read everyone else's parts.

SAM: Would you really? That would help so much.

MR. JENKINS: (entering from stage left) Practice, practice, practice! That's what I always say. When I was your age, I played Hamlet with a fever of a hundred and two!

DOROTHY: We know, Mr. Jenkins. You tell us every day.

[SONG: The Show Must Go On]

MR. JENKINS: Now then — from the top! And this time, Sam, project! The people in the back row paid for tickets too.

SAM: From the top. Right. I can do this.

DOROTHY: That's the spirit! And remember — if you forget a line, just keep moving. The audience never knows the script.

SAM: Unless the audience is my mom. She's been running lines with me all month.

MR. JENKINS: Then she shall be our toughest critic! Places, everyone. Places!

(All exit except SAM, who looks out at the audience.)

SAM: One week. Okay. Let's do this.

[SONG: Opening Night]

THE END`;
