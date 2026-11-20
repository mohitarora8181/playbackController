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

/** Like call(), but keeps the engine's { error } so it can be shown to the user. */
async function callRaw(tabId, method, ...args) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'engine-call', method, args });
  } catch {
    return { error: "Couldn't reach the page — try reloading the tab" };
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
  $('player').hidden = !has || searching;
  $('empty').hidden = has;
  $('search-bar').hidden = !s?.capabilities?.search;
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
  clearSearch();
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

// ─────────────────────────────── search ───────────────────────────────────
// Typing sends the query to the site's own search box; its dropdown rows come
// back and are shown here instead of the player. Picking one plays it there.
let searching = false; // results view is showing
let searchSeq = 0;     // ignores answers to outdated queries
let searchTimer = null;
let results = [];

const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

function showResultsView(on) {
  searching = on;
  $('results').hidden = !on;
  $('player').hidden = on || !lastState;
  $('search-clear').hidden = !$('search').value;
}

function setSearchMsg(text, busy = false) {
  $('results-msg').textContent = text;
  $('search-spin').hidden = !busy;
}

function clearSearch() {
  clearTimeout(searchTimer);
  searchSeq++;
  results = [];
  $('search').value = '';
  $('results-list').replaceChildren();
  setSearchMsg('');
  showResultsView(false);
}

function renderResults(res) {
  results = res?.results || [];
  const listEl = $('results-list');
  listEl.replaceChildren(
    ...results.map((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'result';
      b.title = [r.title, r.subtitle].filter(Boolean).join(' — ');

      if (r.image && !r.suggestion) {
        const img = document.createElement('img');
        img.src = r.image;
        img.alt = '';
        b.append(img);
      } else {
        const ico = document.createElement('span');
        ico.className = 'r-ico';
        ico.innerHTML = SEARCH_ICON; // static markup, not page data
        b.append(ico);
      }

      const text = document.createElement('span');
      text.className = 'r-text';
      const t = document.createElement('span');
      t.className = 'r-title';
      t.textContent = r.title;
      text.append(t);
      if (r.subtitle) {
        const sub = document.createElement('span');
        sub.className = 'r-sub';
        sub.textContent = r.subtitle;
        text.append(sub);
      }
      b.append(text);

      if (!r.suggestion) {
        b.insertAdjacentHTML('beforeend', '<svg class="r-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>');
      }
      b.onclick = () => pickResult(r);
      li.append(b);
      return li;
    }),
  );
  if (res?.error) setSearchMsg(res.error);
  else setSearchMsg(results.length ? '' : 'No results');
}

async function runSearch(query) {
  const p = current();
  if (!p) return;
  const seq = ++searchSeq;
  setSearchMsg('Searching…', true);
  const res = await callRaw(p.tabId, 'search', query);
  if (seq !== searchSeq || res?.stale) return; // a newer query is on its way
  renderResults(res);
}

async function pickResult(r) {
  const p = current();
  if (!p) return;
  const seq = ++searchSeq;
  setSearchMsg(r.suggestion ? 'Searching…' : `Playing “${r.title}”…`, true);
  const res = await callRaw(p.tabId, 'playResult', r.index, r.key);
  if (seq !== searchSeq) return;
  if (res?.refined) {
    // It was a suggestion: the site searched for it; show the new results.
    $('search').value = res.query || r.title;
    renderResults(res);
    return;
  }
  if (res?.ok) {
    clearSearch();
    setTimeout(refresh, 600);
  } else {
    setSearchMsg(res?.error || "Couldn't play that result");
  }
}

$('search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) return clearSearch();
  showResultsView(true);
  setSearchMsg('Searching…', true);
  searchTimer = setTimeout(() => runSearch(q), 400);
});

$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('search').value) {
    e.preventDefault();
    clearSearch();
  } else if (e.key === 'Enter') {
    const first = results.find((r) => !r.suggestion) || results[0];
    if (first) pickResult(first);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    $('results-list').querySelector('.result')?.focus();
  }
});

$('results-list').addEventListener('keydown', (e) => {
  const items = [...$('results-list').querySelectorAll('.result')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' && i < items.length - 1) { e.preventDefault(); items[i + 1].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? items[i - 1] : $('search')).focus(); }
});

$('search-clear').onclick = () => { clearSearch(); $('search').focus(); };

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (searching && e.target.closest?.('.results')) return; // arrows/space belong to the result list
  if (e.key === '/' && !$('search-bar').hidden) { e.preventDefault(); $('search').focus(); }
  else if (e.key === ' ') { e.preventDefault(); act('togglePlay'); }
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
