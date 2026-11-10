/* Playback Controller — popup */
const $ = (id) => document.getElementById(id);
const POLL_MS = 500;

let players = []; // [{ tabId, windowId, site, ... , state }]
let currentId = null;
let seeking = false;
let lastState = null;
let volTimer = null;

// ───────────────────────────── messaging ──────────────────────────────────
async function call(tabId, method, ...args) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'engine-call', method, args });
    return res && !res.error ? res : undefined;
  } catch {
    return undefined; // no content script in that tab
  }
}

// ────────────────────────────── helpers ───────────────────────────────────
function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
const setFill = (input) => {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${pct}%`);
};
const current = () => players.find((p) => p.tabId === currentId);

// ────────────────────────────── discovery ─────────────────────────────────
async function discover() {
  const known = (await chrome.runtime.sendMessage({ type: 'list-players' })) || [];
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const candidates = [...known];
  if (active && !known.some((p) => p.tabId === active.id)) {
    candidates.push({ tabId: active.id, windowId: active.windowId, candidate: true });
  }

  const results = await Promise.all(candidates.map((p) => call(p.tabId, 'getState')));
  players = candidates
    .map((p, i) => (results[i]?.hasPlayer ? { ...p, state: results[i] } : null))
    .filter(Boolean);

  const dead = candidates.filter((p, i) => !p.candidate && !results[i]).map((p) => p.tabId);
  if (dead.length) chrome.runtime.sendMessage({ type: 'forget', tabIds: dead });

  currentId =
    players.find((p) => p.state.isPlaying)?.tabId ??
    players.find((p) => p.tabId === active?.id)?.tabId ??
    players[0]?.tabId ??
    null;
}

// ────────────────────────────── rendering ─────────────────────────────────
function renderChips() {
  const nav = $('chips');
  nav.hidden = players.length < 2;
  nav.replaceChildren(
    ...players.map((p) => {
      const b = document.createElement('button');
      b.className = 'chip' + (p.tabId === currentId ? ' active' : '') + (p.state?.isPlaying ? ' playing' : '');
      b.style.setProperty('--chip-color', p.state?.site?.color || '');
      b.title = [p.state?.title, p.state?.artist].filter(Boolean).join(' — ');
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.textContent = p.state?.site?.name || 'Player';
      b.append(dot, label);
      b.onclick = () => select(p.tabId);
      return b;
    }),
  );
}

function render(s) {
  const has = !!s;
  $('player').hidden = !has;
  $('empty').hidden = has;
  if (!has) return;
  lastState = s;

  document.body.style.setProperty('--accent', s.site?.color || '#8b5cf6');
  $('title').textContent = s.title || 'Nothing playing';
  $('title').title = s.title || '';
  $('artist').textContent = s.artist || '';
  $('site-name').textContent = s.site?.name || '';

  const art = $('art');
  if (s.artwork) {
    if (art.src !== s.artwork) art.src = s.artwork;
    art.hidden = false;
    $('art-fallback').hidden = true;
    $('backdrop').style.backgroundImage = `url("${s.artwork.replace(/["\\\n]/g, encodeURIComponent)}")`;
  } else {
    art.hidden = true;
    $('art-fallback').hidden = false;
    $('backdrop').style.backgroundImage = 'none';
  }

  // <svg> has no `.hidden` property (HTML-only), so toggle the attribute directly.
  $('ico-play').toggleAttribute('hidden', !!s.isPlaying);
  $('ico-pause').toggleAttribute('hidden', !s.isPlaying);

  const caps = s.capabilities || {};
  $('toggle').disabled = !caps.togglePlay;
  $('next').disabled = !caps.next;
  $('previous').disabled = !caps.previous;
  $('shuffle').disabled = !caps.shuffle;
  $('repeat').disabled = !caps.repeat;
  $('like').disabled = !caps.like;
  $('shuffle').classList.toggle('on', s.shuffle === true);
  const repeat = s.repeat; // 'off' | 'all' | 'one' | undefined (not configured)
  $('repeat').classList.toggle('on', repeat === 'all' || repeat === 'one');
  $('repeat').classList.toggle('one', repeat === 'one');
  $('repeat').title = repeat ? `Repeat: ${{ off: 'off', all: 'all', one: 'one track' }[repeat]}` : 'Repeat';
  $('like').classList.toggle('on', s.liked === true);

  const seek = $('seek');
  const hasTime = s.duration > 0;
  seek.disabled = !caps.seek || !hasTime;
  if (!seeking) {
    seek.value = hasTime ? Math.round((s.position / s.duration) * 1000) : 0;
    $('pos').textContent = fmt(s.position);
  }
  $('dur').textContent = fmt(s.duration);
  setFill(seek);

  $('mute').disabled = !caps.mute;
  $('mute').title = s.muted ? 'Unmute' : 'Mute';
  $('ico-vol').toggleAttribute('hidden', !!s.muted);
  $('ico-muted').toggleAttribute('hidden', !s.muted);

  const vol = $('volume');
  vol.disabled = !caps.volume;
  if (!volTimer && document.activeElement !== vol && Number.isFinite(s.volume)) {
    vol.value = Math.round(s.volume * 100);
  }
  setFill(vol);
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await refreshOnce();
  } finally {
    refreshing = false;
  }
}

async function refreshOnce() {
  const p = current();
  if (!p) return render(null);
  const s = await call(p.tabId, 'getState');
  if (!s?.hasPlayer) {
    // Tab closed or navigated away: drop it and fall back to another player.
    players = players.filter((x) => x.tabId !== p.tabId);
    chrome.runtime.sendMessage({ type: 'forget', tabIds: [p.tabId] });
    currentId = players[0]?.tabId ?? null;
    renderChips();
    return refreshOnce();
  }
  const wasPlaying = p.state?.isPlaying;
  p.state = s;
  if (wasPlaying !== s.isPlaying) renderChips();
  render(s);
}

function select(tabId) {
  currentId = tabId;
  renderChips();
  refresh();
}

// ───────────────────────────── interactions ───────────────────────────────
async function act(method, ...args) {
  const p = current();
  if (!p) return;
  await call(p.tabId, method, ...args);
  setTimeout(refresh, 120);
}

$('toggle').onclick = () => act('togglePlay');
$('next').onclick = () => act('next');
$('previous').onclick = () => act('previous');
$('shuffle').onclick = () => act('toggleShuffle');
$('repeat').onclick = () => act('toggleRepeat');
$('like').onclick = () => act('toggleLike');
$('mute').onclick = () => act('toggleMute');

$('seek').addEventListener('input', (e) => {
  seeking = true;
  setFill(e.target);
  const d = lastState?.duration || 0;
  $('pos').textContent = fmt((e.target.value / 1000) * d);
});
$('seek').addEventListener('change', async (e) => {
  const d = lastState?.duration || 0;
  await act('seek', (e.target.value / 1000) * d);
  setTimeout(() => (seeking = false), 400);
});

$('volume').addEventListener('input', (e) => {
  setFill(e.target);
  clearTimeout(volTimer);
  volTimer = setTimeout(() => {
    act('setVolume', e.target.value / 100);
    setTimeout(() => (volTimer = null), 400);
  }, 80);
});

$('site').onclick = async () => {
  const p = current();
  if (!p) return;
  await chrome.tabs.update(p.tabId, { active: true });
  const tab = await chrome.tabs.get(p.tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
};

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === ' ') { e.preventDefault(); act('togglePlay'); }
  else if (e.key === 'ArrowRight') act(e.shiftKey ? 'seekBy' : 'next', ...(e.shiftKey ? [10] : []));
  else if (e.key === 'ArrowLeft') act(e.shiftKey ? 'seekBy' : 'previous', ...(e.shiftKey ? [-10] : []));
});

// ──────────────────────────────── boot ────────────────────────────────────
(async () => {
  await discover();
  renderChips();
  render(current()?.state || null);
  setInterval(refresh, POLL_MS);
})();
