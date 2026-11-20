/*
 * Playback Controller — SITE CONFIG
 * ---------------------------------------------------------------------------
 * The single place that describes every supported site. The engine
 * (engine.js) is fully generic: it picks the entry whose `hosts` match
 * location.hostname and uses ONLY these selectors to control and read the
 * player. If a selector doesn't match, that control is disabled.
 *
 * Shape of an entry
 * -----------------
 * {
 *   id, name, color,            // identity + accent colour used in the popup
 *   hosts: ['example.com', /^music\.example\./],   // exact/suffix string or RegExp
 *   shadow: false,              // true => selectors also search open shadow roots
 *
 *   controls: {                 // what to CLICK or SLIDE
 *     playPause | play | pause | next | previous | shuffle | repeat | like | mute:
 *         'css'  |  ['css', 'fallback css']  |  { click: [...], events: 'full' }
 *     seek | volume:
 *         { slider: [...], type?: 'range'|'paper'|'pointer', vertical?: bool,
 *           // how to READ where the slider is (pick one, only needed for <div> sliders):
 *           cssVar?: '--progress', style?: 'width', fill?: '.fill-el', min?, max? }
 *   },
 *
 * Sliders
 * -------
 *   `slider` is the element to click on (the full-length track).
 *   Moving it:  <input type=range> and Polymer sliders get their value set; anything
 *               else (e.g. a <div> track) gets a synthetic click/drag at the right x.
 *   Reading it: <input type=range>, aria-valuenow and Polymer sliders work as-is.
 *               For <div> sliders, tell the engine where the position lives:
 *                 cssVar: '--progress'   CSS variable on the track or a parent ("35%" or 35)
 *                 style:  'width'        inline style on the slider element ("35%")
 *                 fill:   '.fill'        measured: fill element width ÷ track width
 *               Plain numbers are divided by `max` (default 100); "%" needs no max.
 *   The same entry is used to read volume and, when there's no `state.position`
 *   text, the playback position (fraction × duration).
 *
 *   state: {                    // what to READ. Every field is optional.
 *     title | artist | album | artwork | position | duration | volume |
 *     progress (0..1, used when there's no position text) |
 *     isPlaying | shuffle | repeat | liked | muted (default: volume === 0):
 *         'css' | [spec, spec, ...]  (first one that yields a value wins) |
 *         { selector, attr?, prop?, slider?, exists?, match?: RegExp, modes?: {...},
 *           transform?: (text, el) => text, parse?: 'time'|'number' }
 *   },
 * }
 *
 * Repeat modes
 * ------------
 *   state.repeat yields 'off' | 'all' | 'one'. Map what the site shows with `modes`
 *   (checked in order, so put `one` first: its label/class often contains "repeat" too):
 *     repeat: { selector: '#repeat-btn', attr: 'class', modes: { one: /repeat-one/i, all: /active/i } }
 *   Nothing matched → 'off'. A plain `match` rule also works (true = 'all', false = 'off').
 *
 * Field options:
 *   attr: 'aria-label'   read an attribute       (default: the element's text)
 *   prop: 'src'          read a DOM property
 *   slider: true         read a slider's position as 0..1 (accepts cssVar/style/fill too)
 *   exists: true         true if the element is found
 *   match: /pause/i      true/false: does the value match the RegExp
 *   transform: fn        reshape the text before parsing
 *   parse: 'time'        '1:23' -> 83 seconds ('-1:23' = time remaining)
 *
 * Selector extras:
 *   'host-el >>> inner'   descends into host-el's shadowRoot.
 *   Lists are tried in order; the first visible match wins.
 */
(() => {
  "use strict";

  /** Build "<container> <inner>" selector combinations. */
  const scoped = (containers, inners) =>
    containers.flatMap((c) => inners.map((i) => `${c} ${i}`));

  /** Match an element by its accessible label or tooltip (case-insensitive). */
  const label = (word) => [`[aria-label="${word}" i]`, `[title="${word}" i]`];

  const YTM = "ytmusic-player-bar"; // YouTube Music bottom player bar
  const GAANA = ".miniPlayerWrapper"; // Gaana bottom player bar
  const SAAVN_BAR = ["#player", ".c-player", '[class*="c-player"]'];

  const SITES = [
    // ───────────────────────────────── Spotify ─────────────────────────────────
    {
      id: "spotify",
      name: "Spotify",
      color: "#1db954",
      hosts: ["open.spotify.com"],
      controls: {
        playPause: '[data-testid="control-button-playpause"]',
        next: '[data-testid="control-button-skip-forward"]',
        previous: '[data-testid="control-button-skip-back"]',
        // No data-testid any more: <button aria-label="Enable Shuffle for <song title>">
        shuffle: [
          '[data-testid="control-button-shuffle"]',
          '[data-testid="player-controls"] button[aria-label*="shuffle" i]',
        ],
        repeat: '[data-testid="control-button-repeat"]',
        // <button aria-label="Add to Liked Songs" aria-checked="false"> next to the track title.
        // Scoped to the now-playing widget (track rows on the page have their own like buttons).
        // [data-testid^=…] matches both "now-playing-widget" and the newer "now-playing-widget-v2".
        like: [
          '[data-testid^="now-playing-widget"] button[aria-checked]',
          '[data-testid^="now-playing-widget"] [data-testid="add-button"]',
        ],
        // <button data-testid="volume-bar-toggle-mute-button" aria-label="Mute">
        mute: '[data-testid="volume-bar-toggle-mute-button"]',
        // <div data-testid="progress-bar" style="--progress-bar-transform: 14.29%"> is the visible bar;
        // a hidden <input type="range"> sits next to it.
        seek: {
          slider: [
            '[data-testid="playback-progressbar"] [data-testid="progress-bar"]',
            '[data-testid="playback-progressbar"] input[type="range"]',
          ],
          cssVar: "--progress-bar-transform",
        },
        volume: {
          slider: [
            '[data-testid="volume-bar"] [data-testid="progress-bar"]',
            '[data-testid="volume-bar"] input[type="range"]',
          ],
          cssVar: "--progress-bar-transform",
        },
      },
      state: {
        // aria-label is "Pause" while playing, "Play" while paused
        isPlaying: {
          selector: '[data-testid="control-button-playpause"]',
          attr: "aria-label",
          match: /pause/i,
        },
        // <div data-testid="now-playing-widget-v2">
        //   <a data-testid="context-item-link">Tu Mil Jaaye (From "KING")</a>
        //   <span data-testid="now-playing-widget-v2-byline"><a>Sachin-Jigar</a>, <a>Ed Sheeran</a>, …</span>
        //   <img data-testid="cover-art-image" src="https://i.scdn.co/image/…">
        title: [
          '[data-testid^="now-playing-widget"] [data-testid="context-item-link"]',
          '[data-testid="context-item-info-title"]',
        ],
        // The byline's text reads "Sachin-Jigar, Ed Sheeran, Arijit Singh, …"
        artist: [
          '[data-testid^="now-playing-widget"] [data-testid$="byline"]',
          '[data-testid="context-item-info-subtitles"]',
        ],
        artwork: {
          selector: [
            '[data-testid^="now-playing-widget"] [data-testid="cover-art-image"]',
            '[data-testid^="now-playing-widget"] img',
          ],
          prop: "src",
        },
        position: {
          selector: '[data-testid="playback-position"]',
          parse: "time",
        },
        duration: {
          selector: '[data-testid="playback-duration"]',
          parse: "time",
        },
        // Read the visible bar's CSS variable (68.01%), not the hidden <input step="0.1">,
        // whose value the browser rounds to the step (0.68 → 0.7).
        volume: {
          selector: '[data-testid="volume-bar"] [data-testid="progress-bar"]',
          slider: true,
          cssVar: "--progress-bar-transform",
        },
        // Mute button label flips to "Unmute" while muted
        muted: {
          selector: '[data-testid="volume-bar-toggle-mute-button"]',
          attr: "aria-label",
          match: /unmute/i,
        },
        // The label names the NEXT action: "Enable Shuffle …" means shuffle is off.
        // (When on it reads e.g. "Disable Shuffle …" / "Enable Smart Shuffle …".)
        shuffle: {
          selector: [
            '[data-testid="control-button-shuffle"]',
            '[data-testid="player-controls"] button[aria-label*="shuffle" i]',
          ],
          attr: "aria-label",
          match: /^(?!enable shuffle)/i,
        },
        // The label names the NEXT mode:
        //   "Enable repeat"     → currently off
        //   "Enable repeat one" → currently repeat all
        //   "Disable repeat"    → currently repeat one
        repeat: {
          selector: '[data-testid="control-button-repeat"]',
          attr: "aria-label",
          modes: { one: /^disable repeat/i, all: /repeat one/i },
        },
        liked: {
          selector: '[data-testid^="now-playing-widget"] button[aria-checked]',
          attr: "aria-checked",
          match: /true/,
        },
      },
    },

    // ────────────────────────────── YouTube Music ──────────────────────────────
    // <ytmusic-player-bar repeat-mode="NONE"> holds everything. Buttons are
    // <yt-icon-button class="next-button" title="Next"><button aria-label="Next">: the label and the
    // click handler live on the INNER <button>. Several controls exist twice (hidden mobile bar
    // #right-controls-mweb and the hidden "More player controls" menu), so selectors are scoped
    // to #left-controls / #right-controls.
    {
      id: "ytmusic",
      name: "YouTube Music",
      color: "#ff0033",
      hosts: ["music.youtube.com"],
      controls: {
        playPause: `${YTM} #play-pause-button button`,
        next: `${YTM} #left-controls .next-button button`,
        previous: `${YTM} #left-controls .previous-button button`,
        shuffle: [
          `${YTM} #right-controls .shuffle button`,
          `${YTM} .expand-shuffle button`, // copy inside "More player controls" (narrow windows)
        ],
        repeat: `${YTM} #right-controls .repeat button`,
        // 👍 in the player bar = "Add to liked songs" (the ⋮ menu item only exists while the menu is open)
        like: `${YTM} #like-button-renderer #button-shape-like button`,
        mute: `${YTM} #right-controls .volume button`,
        // Polymer <tp-yt-paper-slider>s: the value is set directly (works even while hidden)
        seek: { slider: `${YTM} #progress-bar`, type: "paper" },
        volume: { slider: `${YTM} #volume-slider`, type: "paper" },
      },
      state: {
        // Inner button reads "Pause" while playing (the outer element only has a title)
        isPlaying: {
          selector: `${YTM} #play-pause-button button`,
          attr: "aria-label",
          match: /pause/i,
        },
        title: `${YTM} .content-info-wrapper .title`,
        // byline title="Shaan & Kailash Kher • Fanaa • 2006"
        artist: {
          selector: `${YTM} .content-info-wrapper .byline`,
          transform: (v) => v.split("•")[0].trim(),
        },
        album: {
          selector: `${YTM} .content-info-wrapper .byline`,
          transform: (v) => v.split("•")[1]?.trim(),
        },
        // src="https://yt3.googleusercontent.com/…=w60-h60-l90-rj" → ask for a bigger image.
        // (i.ytimg.com video thumbnails have no size part and are left as-is.)
        artwork: {
          selector: `${YTM} .thumbnail-image-wrapper img.image`,
          prop: "src",
          transform: (v) => v.replace(/=w\d+-h\d+/, "=w300-h300"),
        },
        // <span class="time-info">0:27 / 4:36</span>
        position: {
          selector: `${YTM} .time-info`,
          transform: (v) => v.split("/")[0],
          parse: "time",
        },
        duration: {
          selector: `${YTM} .time-info`,
          transform: (v) => v.split("/")[1],
          parse: "time",
        },
        // aria-valuenow="100" of aria-valuemax="100"
        volume: { selector: `${YTM} #volume-slider`, slider: true },
        muted: {
          selector: `${YTM} #right-controls .volume button`,
          attr: "aria-label",
          match: /unmute/i,
        },
        // Shuffle has no label/attribute change — only the icon changes: when ON, the SVG path
        // gains a small dot, drawn as a circle arc "…M3 10.001a2 2 0 110 4 2 2 0 010-4Z".
        shuffle: {
          selector: [
            `${YTM} #right-controls .shuffle button svg path`,
            `${YTM} .expand-shuffle button svg path`,
          ],
          attr: "d",
          match: /a2 2 0 11/,
        },
        // <ytmusic-like-button-renderer like-status="INDIFFERENT" | "LIKE" | "DISLIKE">
        liked: {
          selector: `${YTM} #like-button-renderer`,
          attr: "like-status",
          match: /^LIKE$/,
        },
        // <ytmusic-player-bar repeat-mode="NONE" | "ALL" | "ONE">
        repeat: {
          selector: YTM,
          attr: "repeat-mode",
          modes: { one: /^ONE$/, all: /^ALL$/ },
        },
      },
    },

    // ─────────────────────────────── Amazon Music ──────────────────────────────
    // Built with web components (<music-button>, <music-horizontal-item>) that
    // live partly in shadow DOM, hence `shadow: true`.
    {
      id: "amazon",
      name: "Amazon Music",
      color: "#25d1da",
      hosts: [/^music\.amazon\./],
      shadow: true,
      controls: {
        playPause: [
          '#transport music-button[icon-name="pause"]',
          '#transport music-button[icon-name="play"]',
          ...label("Pause"),
          ...label("Play"),
        ],
        next: ['#transport music-button[icon-name="next"]', ...label("Next")],
        previous: [
          '#transport music-button[icon-name="previous"]',
          ...label("Previous"),
        ],
        shuffle: [
          '#transport music-button[icon-name="shuffle"]',
          ...label("Shuffle"),
        ],
        repeat: [
          '#transport music-button[icon-name="repeat"]',
          '#transport music-button[icon-name="repeatone"]',
          ...label("Repeat"),
        ],
        seek: {
          slider: [
            '#transport [role="slider"]',
            "music-slider",
            '#transport input[type="range"]',
          ],
        },
        volume: {
          slider: [
            '#volume [role="slider"]',
            'music-volume-control input[type="range"]',
          ],
        },
      },
      state: {
        isPlaying: [
          {
            selector: '#transport music-button[icon-name="pause"]',
            exists: true,
          },
          { selector: label("Pause"), exists: true },
        ],
        title: [
          {
            selector: "#transport music-horizontal-item",
            attr: "primary-text",
          },
          "#transport music-horizontal-item >>> .primaryText",
        ],
        artist: [
          {
            selector: "#transport music-horizontal-item",
            attr: "secondary-text",
          },
          "#transport music-horizontal-item >>> .secondaryText",
        ],
        artwork: {
          selector: "#transport music-horizontal-item",
          attr: "image-src",
        },
      },
    },

    // ────────────────────────────────── Gaana ──────────────────────────────────
    // Bottom bar: <div class="miniPlayerWrapper">. Sliders are PrimeReact (.p-slider).
    // Several buttons exist twice (mobile + desktop layouts); the visible one is used.
    {
      id: "gaana",
      name: "Gaana",
      color: "#e72c30",
      hosts: ["gaana.com"],
      controls: {
        // <div class="play-pause-btn"><button class="pause" aria-label="Pause">
        playPause: `${GAANA} .play-pause-btn button`,
        next: `${GAANA} .nextButton`,
        previous: `${GAANA} .prevButton`,
        shuffle: `${GAANA} .shuffleButton`,
        repeat: `${GAANA} .repButton`,
        like: `${GAANA} .likeButton`,
        mute: `${GAANA} .volButton`,
        // <div id="miniPlayerSeekBar" class="p-slider p-slider-horizontal">
        //   <span class="p-slider-range" style="width: 85.136%">  ← filled part
        // (The handle's aria values are unreliable here: valuenow is %, valuemax is seconds.)
        seek: {
          slider: "#miniPlayerSeekBar",
          fill: ".p-slider-range",
        },
        // <div id="volumeSlider" class="p-slider p-slider-vertical">
        //   <span class="p-slider-range" style="height: 50%">
        volume: {
          slider: "#volumeSlider",
          vertical: true,
          fill: ".p-slider-range",
        },
      },
      state: {
        // Button reads "Pause" while playing
        isPlaying: {
          selector: `${GAANA} .play-pause-btn button`,
          attr: "aria-label",
          match: /pause/i,
        },
        // <h3><a title="Jugni (feat. Jacqueline Fernandez)" href="/song/…">
        title: [
          { selector: `${GAANA} .minPlayDetail h3 a`, attr: "title" },
          `${GAANA} .minPlayDetail h3`,
        ],
        artist: `${GAANA} .minPlayShortDesc`,
        artwork: { selector: `${GAANA} .miniPlayImg img`, prop: "src" },
        // <div class="minPlayTime">00:16 / 00:19</div>
        position: {
          selector: `${GAANA} .minPlayTime`,
          transform: (v) => v.split("/")[0],
          parse: "time",
        },
        duration: {
          selector: `${GAANA} .minPlayTime`,
          transform: (v) => v.split("/")[1],
          parse: "time",
        },
        // Volume handle: aria-valuenow="50" aria-valuemax="100" (these ARE consistent)
        volume: { selector: '#volumeSlider [role="slider"]', slider: true },
        muted: { selector: `${GAANA} .volButton`, attr: "aria-pressed", match: /true/ },
        shuffle: { selector: `${GAANA} .shuffleButton`, attr: "aria-pressed", match: /true/ },
        liked: { selector: `${GAANA} .likeButton`, attr: "aria-pressed", match: /true/ },
        // aria-label="Repeat mode: off" — the label states the CURRENT mode
        repeat: {
          selector: `${GAANA} .repButton`,
          attr: "aria-label",
          modes: { one: /:\s*(one|single|song)\b/i, all: /:\s*(all|on)\b/i },
        },
      },
    },

    // ───────────────────────────────── JioSaavn ────────────────────────────────
    {
      id: "jiosaavn",
      name: "JioSaavn",
      color: "#2bc5b4",
      hosts: ["jiosaavn.com"],
      controls: {
        playPause: [
          "#player_play_pause",
          ...scoped(SAAVN_BAR, [
            ...label("Play"),
            ...label("Pause"),
            '[class*="play" i]',
          ]),
        ],
        next: [
          "#player_next",
          ...scoped(SAAVN_BAR, [...label("Next"), '[class*="next" i]']),
        ],
        previous: [
          "#player_prev",
          ...scoped(SAAVN_BAR, [...label("Previous"), '[class*="prev" i]']),
        ],
        shuffle: [
          "#player_shuffle",
          ...scoped(SAAVN_BAR, [...label("Shuffle"), '[class*="shuffle" i]']),
        ],
        repeat: [
          "#player_repeat",
          ...scoped(SAAVN_BAR, [...label("Repeat"), '[class*="repeat" i]']),
        ],
        // <li class="c-player__btn"><span aria-label="Add to Favourites button" role="button" aria-pressed="false">
        // Scoped to the player bar: song rows on the page have their own favourite buttons.
        like: [
          '.c-player__btn [role="button"][aria-label*="Favourite" i]',
          '.c-player__btn [role="button"][aria-label*="Favorite" i]',
        ],
        // Speaker icon toggles mute:
        // <span id="player_volume" class="o-icon-volume …" role="slider" aria-label="Volume control" aria-valuenow="67">
        mute: "#player_volume",
        // Vertical slider: <div class="c-slider__track"><div class="c-slider__level" style="height: 68%">
        volume: {
          slider: [
            '[class*="c-player"] .c-slider__track',
            ".c-slider__content .c-slider__track",
          ],
          vertical: true,
        },
        // <div class="c-progress" role="slider" aria-label="Playback progress" aria-valuenow="16" aria-valuemax="315">
        //   <div class="c-progress__start">0:16</div> <div class="c-progress__end">5:15</div>
        //   <div class="c-progress__track"><div class="c-progress__seek" style="width:74px"></div>…</div>
        // Click on the track itself (the outer .c-progress also contains the time labels).
        seek: {
          slider: [
            '[role="slider"][aria-label="Playback progress" i] .c-progress__track',
            ".c-progress .c-progress__track",
          ],
          fill: ".c-progress__seek",
        },
      },
      state: {
        // Paused: <span id="player_play_pause" class="o-icon-play …" aria-label="Play">
        // Playing: the icon class / label switch to "pause".
        isPlaying: {
          selector: '#player_play_pause[class*="pause" i], #player_play_pause[aria-label*="pause" i]',
          exists: true,
        },
        // Only the class changes:
        //   off: "o-icon-repeat o-icon--xlarge"
        //   all: "u-color-js-green o-icon-repeat o-icon--xlarge"
        //   one: "u-color-js-green o-icon-repeat-one o-icon--xlarge"   ← also green, so test `one` first
        repeat: {
          selector: '#player_repeat[class*="o-icon-repeat"], #player_repeat [class*="o-icon-repeat"]',
          attr: "class",
          modes: { one: /\bo-icon-repeat-one\b/, all: /\bu-color-js-green\b/ },
        },
        // off: "o-icon-shuffle o-icon--xlarge"   on: green highlight, same as repeat
        shuffle: {
          selector: '#player_shuffle[class*="o-icon-shuffle"], #player_shuffle [class*="o-icon-shuffle"]',
          attr: "class",
          match: /\bu-color-js-green\b/,
        },
        liked: {
          selector: [
            '.c-player__btn [role="button"][aria-label*="Favourite" i]',
            '.c-player__btn [role="button"][aria-label*="Favorite" i]',
          ],
          attr: "aria-pressed",
          match: /true/,
        },
        // Muted if the speaker icon switches to a "mute" class, or its aria-valuenow drops to 0.
        muted: [
          { selector: '#player_volume[class*="mute" i]', exists: true },
          { selector: "#player_volume", attr: "aria-valuenow", match: /^0$/ },
        ],
        // Inline "height: 68.4679%" on the level → 0.684679 (readable even while the slider is hidden)
        volume: {
          selector: [
            '[class*="c-player"] .c-slider__level',
            ".c-slider__content .c-slider__level",
          ],
          slider: true,
          style: "height",
        },
        // Exact seconds from the ARIA slider; the visible time labels are the backup.
        position: [
          { selector: '[role="slider"][aria-label="Playback progress" i]', attr: "aria-valuenow", parse: "number" },
          { selector: ".c-progress__start", parse: "time" },
        ],
        duration: [
          { selector: '[role="slider"][aria-label="Playback progress" i]', attr: "aria-valuemax", parse: "number" },
          { selector: ".c-progress__end", parse: "time" },
        ],
        title: ["figcaption > h2", ...scoped(SAAVN_BAR, ['[role="heading"]'])],
        artist: ["figcaption > p"],
        artwork: {
          selector: scoped(SAAVN_BAR, ["img"]),
          prop: "src",
        },
      },
    },
  ];

  Object.defineProperty(window, "__pbcSites", {
    value: SITES,
    configurable: true,
  });
})();
