/*
 * Playback Controller — ENGINE (runs in the page's MAIN world)
 * ---------------------------------------------------------------------------
 * One generic controller for every site. It:
 *   1. picks the site entry from sites.js whose `hosts` match this page,
 *   2. performs actions ONLY through that entry's `controls` selectors
 *      (click buttons / drag sliders),
 *   3. reads the player ONLY through that entry's `state` selectors,
 *   4. answers the bridge (bridge.js) over window.postMessage.
 *
 * If a selector doesn't match, the action reports { ok: false } and the popup
 * disables that button. Use the popup's "Diagnostics" to see what matched.
 */
(() => {
  'use strict';
  if (window.__pbcEngineLoaded) return;
  Object.defineProperty(window, '__pbcEngineLoaded', { value: true });

  const CHANNEL = 'playback-controller:v1';
  const SITES = window.__pbcSites || [];

  // ───────────────────────────── small utils ──────────────────────────────
  const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
  const present = (v) => v !== undefined && v !== null && v !== '' && !Number.isNaN(v);
  const first = (...vals) => vals.find(present);
  const log = (...a) => console.debug('[PlaybackController]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parseTime(text) {
    const m = String(text).trim().match(/^([-−])?\s*(\d+(?::\d{1,2}){0,2})/);
    if (!m) return undefined;
    const secs = m[2].split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
    return m[1] ? -secs : secs;
  }

  // ─────────────────────────── site detection ─────────────────────────────
  const host = location.hostname;
  const site = SITES.find((s) =>
    list(s.hosts).some((h) => (h instanceof RegExp ? h.test(host) : host === h || host.endsWith('.' + h))),
  );
  if (!site) return; // not a configured site
  const siteInfo = { id: site.id, name: site.name, color: site.color };

  // ───────────────────────────── DOM querying ─────────────────────────────
  let rootsCache = { at: -Infinity, roots: [] };
  function shadowRoots() {
    const now = performance.now();
    if (now - rootsCache.at < 1000) return rootsCache.roots;
    const roots = [];
    const visit = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = w.nextNode())) {
        if (n.shadowRoot) { roots.push(n.shadowRoot); visit(n.shadowRoot); }
      }
    };
    visit(document);
    rootsCache = { at: now, roots };
    return roots;
  }

  /**
   * querySelectorAll with optional shadow-DOM search and `a >>> b` piercing.
   * `root` limits the search to one element (e.g. a single search-result row).
   */
  function queryAll(selector, deep, root = document) {
    const [head, ...rest] = selector.split('>>>').map((s) => s.trim());
    let nodes = deep && root === document
      ? [document, ...shadowRoots()].flatMap((r) => [...r.querySelectorAll(head)])
      : [...root.querySelectorAll(head)];
    for (const part of rest) {
      nodes = nodes.flatMap((n) => (n.shadowRoot ? [...n.shadowRoot.querySelectorAll(part)] : []));
    }
    return nodes;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** First match across a selector list, preferring visible elements. */
  function find(selectors, root = document) {
    for (const sel of list(selectors)) {
      // ':self' = the root element itself (e.g. a search-result row whose own aria-label is the title)
      if (sel === ':self') {
        if (root !== document) return root;
        continue;
      }
      let nodes;
      try { nodes = queryAll(sel, !!site.shadow, root); } catch { continue; } // invalid selector
      if (nodes.length) return nodes.find(isVisible) || nodes[0];
    }
    return null;
  }

  // ────────────────────────────── reading ─────────────────────────────────
  function readField(spec, root = document) {
    if (spec == null) return undefined;
    if (Array.isArray(spec)) {
      for (const s of spec) {
        const v = readField(s, root);
        if (present(v)) return v;
      }
      return undefined;
    }
    if (typeof spec === 'string') spec = { selector: spec };

    const el = find(spec.selector, root);
    if (!el) return undefined;
    if (spec.exists) return true;

    let v;
    if (spec.attr) v = el.getAttribute(spec.attr);
    else if (spec.prop) v = el[spec.prop];
    else if (spec.slider) v = sliderFraction(el, spec);
    else v = el.textContent;
    if (typeof v === 'string') v = v.replace(/\s+/g, ' ').trim();

    if (spec.modes) {
      // { one: /…/, all: /…/ } → first key whose RegExp matches; none → spec.default ('off')
      const text = v == null ? '' : String(v);
      for (const [mode, re] of Object.entries(spec.modes)) {
        if (re.test(text)) return mode;
      }
      return spec.default ?? 'off';
    }
    if (spec.match) return spec.match.test(v == null ? '' : String(v));
    if (!present(v)) return undefined;
    if (spec.transform) {
      try { v = spec.transform(v, el); } catch { return undefined; }
    }
    if (spec.parse === 'time') v = parseTime(v);
    else if (spec.parse === 'number') v = parseFloat(v);
    return present(v) ? v : undefined;
  }

  /** "35%" -> 0.35, "35" -> 35/max (max defaults to 100), "120px" -> 120 / parent width. */
  function toFraction(raw, el, opts) {
    const s = String(raw ?? '').trim();
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return undefined;
    if (s.endsWith('%')) return clamp01(n / 100);
    if (s.endsWith('px')) {
      const r = el.parentElement?.getBoundingClientRect();
      const size = opts.vertical ? r?.height : r?.width;
      return size ? clamp01(n / size) : undefined;
    }
    const min = opts.min ?? 0;
    const max = opts.max ?? 100;
    return max > min ? clamp01((n - min) / (max - min)) : undefined;
  }

  /**
   * Where a slider currently is, as 0..1. Options (from a control or state spec):
   *   cssVar: '--progress'  read a CSS custom property (inherited, so may sit on a parent)
   *   style:  'width'       read an inline style value of the element
   *   fill:   '.fill'       measure the fill element's size relative to the slider
   *   min/max, vertical     scale + orientation for the above
   * Without options: <input type=range>, aria-valuenow, or Polymer .value/.max.
   */
  function sliderFraction(el, opts = {}) {
    if (!el) return undefined;
    if (opts.cssVar) {
      return toFraction(getComputedStyle(el).getPropertyValue(opts.cssVar), el, opts);
    }
    if (opts.style) {
      // Inline style first ("35%"); otherwise the computed value (px, relative to parent).
      const raw = el.style.getPropertyValue(opts.style) || getComputedStyle(el).getPropertyValue(opts.style);
      return toFraction(raw, el, opts);
    }
    if (opts.fill) {
      const fillEl = el.querySelector(opts.fill) || find(opts.fill);
      if (!fillEl) return undefined;
      const t = el.getBoundingClientRect();
      const f = fillEl.getBoundingClientRect();
      const total = opts.vertical ? t.height : t.width;
      return total > 0 ? clamp01((opts.vertical ? f.height : f.width) / total) : undefined;
    }
    if (el instanceof HTMLInputElement) {
      const min = Number(el.min) || 0;
      const max = el.max === '' ? 100 : Number(el.max);
      return max > min ? clamp01((Number(el.value) - min) / (max - min)) : undefined;
    }
    const now = el.getAttribute('aria-valuenow');
    if (now != null) {
      const min = Number(el.getAttribute('aria-valuemin') ?? 0);
      const max = Number(el.getAttribute('aria-valuemax') ?? 100);
      return max > min ? clamp01((Number(now) - min) / (max - min)) : undefined;
    }
    if (typeof el.value === 'number' && typeof el.max === 'number') {
      const min = el.min || 0;
      return el.max > min ? clamp01((el.value - min) / (el.max - min)) : undefined;
    }
    return undefined;
  }

  const isPlaying = () => readField(site.state?.isPlaying) === true;

  /** Repeat as 'off' | 'all' | 'one'. Plain true/false rules still work (true = 'all'). */
  function repeatMode() {
    const v = readField(site.state?.repeat);
    if (v === true) return 'all';
    if (v === false) return 'off';
    return ['off', 'all', 'one'].includes(v) ? v : undefined;
  }

  /** Current fraction of a `controls.seek` / `controls.volume` slider. */
  function readSliderControl(name) {
    const c = ctl(name);
    const el = c?.slider && find(c.slider);
    return el ? sliderFraction(el, c) : undefined;
  }

  function timing() {
    const S = site.state || {};
    let position = readField(S.position);
    let duration = readField(S.duration);
    if (duration < 0 && present(position)) duration = position - duration; // "-1:23" remaining-time display
    if (!present(position) && duration > 0) {
      // No position text: derive it from the seek bar (state.progress or controls.seek).
      const progress = first(readField(S.progress), readSliderControl('seek'));
      if (present(progress)) position = progress * duration;
    }
    return { position, duration };
  }

  // ────────────────────────────── acting ──────────────────────────────────
  const ctl = (name) => {
    const spec = site.controls?.[name];
    if (spec == null) return null;
    return typeof spec === 'string' || Array.isArray(spec) ? { click: spec } : spec;
  };

  function clickEl(el, mode) {
    const target = el.shadowRoot?.querySelector('button, [role="button"], a') || el;
    if (mode === 'full') {
      const r = target.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const p = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      target.dispatchEvent(new PointerEvent('pointerdown', { ...p, buttons: 1 }));
      target.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
      target.dispatchEvent(new PointerEvent('pointerup', p));
      target.dispatchEvent(new MouseEvent('mouseup', o));
    }
    target.click();
    return true;
  }

  function clickControl(name) {
    const c = ctl(name);
    if (!c?.click) return false;
    const el = find(c.click);
    return el ? clickEl(el, c.events) : false;
  }

  function pointerSlide(el, fraction, vertical) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = vertical ? r.left + r.width / 2 : r.left + r.width * fraction;
    const y = vertical ? r.bottom - r.height * fraction : r.top + r.height / 2;
    // Like a real click, hit whatever is on top at that point (fill, thumb, overlay…)
    // as long as it belongs to the slider; events then bubble up through the track.
    const hit = document.elementFromPoint(x, y);
    const target = hit && (hit === el || el.contains(hit)) ? hit : el;
    const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: x, clientY: y, screenX: x, screenY: y };
    const p = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...p, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointermove', { ...p, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousemove', { ...o, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', p));
    target.dispatchEvent(new MouseEvent('mouseup', o));
    target.dispatchEvent(new MouseEvent('click', o));
    return true;
  }

  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  /** Move a slider to `fraction` (0..1): range input, Polymer slider, or synthetic drag. */
  function setSlider(el, fraction, opts = {}) {
    fraction = clamp01(fraction);
    let kind = opts.type;
    if (!kind) {
      if (el instanceof HTMLInputElement && el.type === 'range') kind = 'range';
      else if (el.localName.includes('slider') && 'value' in el && 'max' in el) kind = 'paper';
      else kind = 'pointer';
    }
    if (kind === 'range') {
      const min = Number(el.min) || 0;
      const max = el.max === '' ? 100 : Number(el.max);
      nativeValueSetter.call(el, String(min + fraction * (max - min))); // works with React
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (kind === 'paper') {
      const min = Number(el.min) || 0;
      const max = Number(el.max) || 100;
      el.value = min + fraction * (max - min);
      el.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true }));
      return true;
    }
    return pointerSlide(el, fraction, opts.vertical);
  }

  /** Simulate the mouse entering (on=true) or leaving (on=false) an element. */
  function hover(el, on) {
    const base = { cancelable: true, composed: true, view: window, relatedTarget: document.body };
    const types = on
      ? ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']
      : ['pointerout', 'pointerleave', 'mouseout', 'mouseleave'];
    for (const type of types) {
      const bubbles = !type.endsWith('enter') && !type.endsWith('leave');
      el.dispatchEvent(type.startsWith('pointer')
        ? new PointerEvent(type, { ...base, bubbles, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        : new MouseEvent(type, { ...base, bubbles }));
    }
  }

  /**
   * Move a `controls.seek` / `controls.volume` slider. If the slider only exists while
   * something is hovered (`reveal: 'selector'`), hover that first, wait for the slider
   * to appear, set it, then move the "mouse" away again.
   */
  async function slideControl(name, fraction) {
    const c = ctl(name);
    if (!c?.slider) return false;
    let el = find(c.slider);
    let revealEl = null;
    if (!el && c.reveal) {
      revealEl = find(c.reveal);
      if (!revealEl) return false;
      hover(revealEl, true);
      for (let i = 0; i < 20 && !(el = find(c.slider)); i++) await sleep(25); // up to ~0.5 s
    }
    try {
      return el ? setSlider(el, fraction, c) : false;
    } finally {
      if (revealEl) setTimeout(() => hover(revealEl, false), 300);
    }
  }

  const ACTIONS = {
    togglePlay: () => clickControl('playPause') || clickControl(isPlaying() ? 'pause' : 'play'),
    next: () => clickControl('next'),
    previous: () => clickControl('previous'),
    seek: (seconds) => {
      const { duration } = timing();
      return duration > 0 && slideControl('seek', seconds / duration);
    },
    setVolume: (v) => slideControl('volume', v),
    toggleShuffle: () => clickControl('shuffle'),
    toggleRepeat: () => clickControl('repeat'),
    toggleLike: () => clickControl('like'),
    toggleMute: () => clickControl('mute'),
  };

  async function run(name, ...args) {
    try {
      const ok = !!(await ACTIONS[name](...args));
      if (ok) {
        if (name === 'setVolume') lastVolume = args[0];
        scheduleCheck(300);
      }
      return { ok };
    } catch (e) {
      log(name, 'failed:', e);
      return { ok: false };
    }
  }

  // ─────────────────────────────── state ──────────────────────────────────
  /** Is the control usable? (Its element exists, or the element that reveals it does.) */
  function found(name) {
    const c = ctl(name);
    if (!c) return false;
    return !!find(c.click || c.slider) || (!!c.reveal && !!find(c.reveal));
  }

  // Last volume we saw, for sliders that only exist while hovered.
  let lastVolume;
  function readVolume() {
    const v = first(readField(site.state?.volume), readSliderControl('volume'));
    if (present(v)) lastVolume = v;
    return lastVolume;
  }

  function getState() {
    const S = site.state || {};
    const { position, duration } = timing();
    const capabilities = {
      togglePlay: found('playPause') || found('play') || found('pause'),
      next: found('next'),
      previous: found('previous'),
      seek: found('seek'),
      volume: found('volume'),
      shuffle: found('shuffle'),
      repeat: found('repeat'),
      like: found('like'),
      mute: found('mute'),
      search: !!site.search && !!(find(site.search.input) || (site.search.open && find(site.search.open))),
    };
    const state = {
      site: siteInfo,
      isPlaying: isPlaying(),
      title: readField(S.title),
      artist: readField(S.artist),
      album: readField(S.album),
      artwork: readField(S.artwork),
      position,
      duration,
      volume: readVolume(),
      shuffle: readField(S.shuffle),
      repeat: repeatMode(),
      liked: readField(S.liked),
      capabilities,
    };
    // No `muted` rule: a volume of exactly 0 (read from the site) counts as muted.
    state.muted = readField(S.muted) ?? (state.volume === 0);
    state.hasPlayer = !!(state.title || state.isPlaying || capabilities.togglePlay);
    return state;
  }

  /** Which selector matched for each control, and what each state field read. */
  function diagnose() {
    const controls = {};
    for (const k of Object.keys(site.controls || {})) {
      const c = ctl(k);
      controls[k] = list(c.click || c.slider).find((s) => {
        try { return queryAll(s, !!site.shadow).length > 0; } catch { return false; }
      }) || null;
    }
    const state = {};
    for (const k of Object.keys(site.state || {})) {
      const v = readField(site.state[k]);
      state[k] = v === undefined ? null : String(v).slice(0, 80);
    }
    const sliders = {};
    for (const k of ['seek', 'volume']) {
      const v = readSliderControl(k);
      sliders[k] = v === undefined ? null : Math.round(v * 1000) / 1000;
    }
    return { site: siteInfo, controls, state, sliders };
  }

  // ─────────────────────────────── search ─────────────────────────────────
  // Driven by `site.search` in sites.js:
  //   input       the site's search box
  //   open        (optional) button to click first if the box isn't on the page
  //   results     one element per dropdown row
  //   title / subtitle / image   field specs read INSIDE each row
  //   play        (optional) what to click inside a row to play it (default: the row)
  //   suggestion  (optional) selector inside a row marking a plain query suggestion
  let lastQuery = '';

  const nativeInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  /**
   * Focus the search box. While the popup is open the browser window itself isn't
   * focused, so input.focus() alone fires no focus events — and many sites only show
   * their results while the box is focused. Fire them ourselves too.
   */
  function focusInput(input) {
    input.focus();
    input.dispatchEvent(new FocusEvent('focus', { composed: true }));
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  }

  function setValue(input, text) {
    nativeInputValue.call(input, text); // bypasses React's value tracking, so React sees a change
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  }

  /** Type into a (React-controlled) input: set the value natively, then fire the events a keypress would. */
  function typeInto(input, text) {
    focusInput(input);
    // React ignores an "input" whose value didn't change: when re-running the same
    // query, clear the box first so the site really searches again.
    if (input.value === text) setValue(input, '');
    setValue(input, text);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function resultRows() {
    for (const sel of list(site.search.results)) {
      let nodes;
      try { nodes = queryAll(sel, false); } catch { continue; }
      if (nodes.length) return nodes;
    }
    return [];
  }

  const rowKey = (r) => `${r.title}|${r.subtitle ?? ''}`;

  function readResults() {
    const cfg = site.search;
    return resultRows()
      .map((row, index) => {
        const r = {
          index,
          title: readField(cfg.title, row),
          subtitle: readField(cfg.subtitle, row),
          image: readField(cfg.image, row),
          suggestion: cfg.suggestion ? !!find(cfg.suggestion, row) : false,
        };
        r.key = rowKey(r);
        return r;
      })
      .filter((r) => r.title);
  }

  /** Wait until the dropdown shows rows that are new (≠ before) and have stopped changing. */
  async function waitForResults(before, cfg) {
    const start = performance.now();
    const timeout = cfg.timeout ?? 6000;
    let prev = null;
    let stable = 0;
    await sleep(cfg.delay ?? 300);
    while (performance.now() - start < timeout) {
      const rows = readResults();
      const sig = rows.map((r) => r.key).join('\n');
      // Same rows as before typing are only accepted after a while (re-running the same query).
      const fresh = sig !== before || performance.now() - start > 1500;
      if (rows.length && fresh && sig === prev) {
        if (++stable >= 2) return rows; // unchanged for 3 reads in a row
      } else {
        stable = 0;
      }
      prev = sig;
      await sleep(200);
    }
    return readResults();
  }

  async function search(query) {
    const cfg = site.search;
    if (!cfg) return { error: 'Search is not set up for this site' };
    query = String(query ?? '').trim();
    lastQuery = query;

    let input = find(cfg.input);
    if (!input && cfg.open) {
      const opener = find(cfg.open);
      if (opener) {
        clickEl(opener);
        for (let i = 0; i < 20 && !(input = find(cfg.input)); i++) await sleep(50);
      }
    }
    if (!input) return { error: 'Search box not found on the page' };

    const before = readResults().map((r) => r.key).join('\n');
    clickEl(input);
    typeInto(input, query);
    if (!query) return { query, results: [] };

    const results = await waitForResults(before, cfg);
    if (query !== lastQuery) return { query, stale: true, results: [] }; // a newer search started
    return { query, results };
  }

  /** Play the row at `index` (checked against its key, since the dropdown may have changed). */
  async function playResult(index, key) {
    const cfg = site.search;
    if (!cfg) return { ok: false, error: 'Search is not set up for this site' };

    const locate = () => {
      const rows = resultRows();
      const results = readResults();
      const hit = results.find((r) => r.index === index && r.key === key) || results.find((r) => r.key === key);
      return hit ? { result: hit, row: rows[hit.index] } : null;
    };

    let found = locate();
    const input = find(cfg.input);
    if (!found && input) {
      // The list may only exist while the box is focused — focus it and look again.
      focusInput(input);
      for (let i = 0; i < 6 && !found; i++) {
        await sleep(100);
        found = locate();
      }
    }
    if (!found && lastQuery) {
      // Still gone (e.g. the site cleared it) — search again and look for the same row.
      await search(lastQuery);
      found = locate();
    }
    if (!found) return { ok: false, error: 'That result is no longer shown — search again' };

    // A plain suggestion ("tu mil jaaye king") isn't playable: search for it instead.
    if (found.result.suggestion) {
      const refined = await search(found.result.title);
      return { ok: true, refined: true, ...refined };
    }

    const target = (cfg.play && find(cfg.play, found.row)) || found.row;
    clickEl(target, cfg.events);

    // Close the dropdown again.
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    scheduleCheck(800);
    return { ok: true };
  }

  // ─────────────────── change notifications to background ─────────────────
  let lastSig = null;
  let checkTimer = null;
  function scheduleCheck(delay = 0) {
    if (checkTimer) return;
    checkTimer = setTimeout(() => { checkTimer = null; check(); }, delay);
  }
  function check() {
    let s;
    try { s = getState(); } catch { return; }
    if (!s.hasPlayer) return;
    const data = { site: s.site, isPlaying: s.isPlaying, title: s.title, artist: s.artist, artwork: s.artwork };
    const sig = JSON.stringify(data);
    if (sig === lastSig) return;
    lastSig = sig;
    post({ event: 'state', data });
  }
  setInterval(check, 1500);

  // ───────────────────────────── messaging ────────────────────────────────
  function post(msg) {
    window.postMessage({ channel: CHANNEL, dir: 'to-bridge', ...msg }, location.origin);
  }

  const api = {
    hello() { lastSig = null; scheduleCheck(0); return { ok: true }; },
    ping: () => ({ ok: true, site: siteInfo }),
    getState,
    diagnose,
    togglePlay: () => run('togglePlay'),
    play: () => (isPlaying() ? { ok: true } : run('togglePlay')),
    pause: () => (isPlaying() ? run('togglePlay') : { ok: true }),
    next: () => run('next'),
    previous: () => run('previous'),
    seek: (seconds) => run('seek', Math.max(0, Number(seconds) || 0)),
    seekBy: (delta) => {
      const { position } = timing();
      return present(position) ? run('seek', Math.max(0, position + Number(delta))) : { ok: false };
    },
    setVolume: (v) => run('setVolume', clamp01(v)),
    toggleShuffle: () => run('toggleShuffle'),
    toggleRepeat: () => run('toggleRepeat'),
    toggleLike: () => run('toggleLike'),
    toggleMute: () => run('toggleMute'),
    search: (query) => search(query),
    playResult: (index, key) => playResult(Number(index), String(key ?? '')),
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'to-engine') return;
    let result;
    try {
      const fn = Object.hasOwn(api, msg.method) ? api[msg.method] : null;
      result = fn ? await fn(...list(msg.args)) : { error: `unknown method ${msg.method}` };
    } catch (err) {
      result = { error: String(err?.message || err) };
    }
    post({ id: msg.id, result });
  });

  log(`engine ready for ${site.name}`);
})();
