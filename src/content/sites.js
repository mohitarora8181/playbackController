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

  const GAANA_BAR = [".player", "#player", ".playerbar", '[class*="player" i]'];
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
    {
      id: "ytmusic",
      name: "YouTube Music",
      color: "#ff0033",
      hosts: ["music.youtube.com"],
      controls: {
        playPause: "ytmusic-player-bar #play-pause-button",
        next: "ytmusic-player-bar .next-button",
        previous: "ytmusic-player-bar .previous-button",
        shuffle: "ytmusic-player-bar .shuffle",
        repeat: "ytmusic-player-bar .repeat",
        like: [
          "ytmusic-player-bar ytmusic-like-button-renderer #button-shape-like button",
          "ytmusic-player-bar ytmusic-like-button-renderer .like",
        ],
        seek: { slider: "ytmusic-player-bar #progress-bar", type: "paper" },
        volume: { slider: "ytmusic-player-bar #volume-slider", type: "paper" },
      },
      state: {
        isPlaying: {
          selector: "ytmusic-player-bar #play-pause-button",
          attr: "aria-label",
          match: /pause/i,
        },
        title: "ytmusic-player-bar .content-info-wrapper .title",
        artist: {
          selector: "ytmusic-player-bar .content-info-wrapper .byline",
          transform: (v) => v.split("•")[0].trim(), // "Artist • Album • 2020"
        },
        artwork: {
          selector: [
            "ytmusic-player-bar .thumbnail-image-wrapper img",
            "ytmusic-player-bar img.image",
          ],
          prop: "src",
        },
        // time-info text looks like "1:23 / 3:45"
        position: {
          selector: "ytmusic-player-bar .time-info",
          transform: (v) => v.split("/")[0],
          parse: "time",
        },
        duration: {
          selector: "ytmusic-player-bar .time-info",
          transform: (v) => v.split("/")[1],
          parse: "time",
        },
        volume: { selector: "ytmusic-player-bar #volume-slider", slider: true },
        liked: {
          selector: "ytmusic-player-bar ytmusic-like-button-renderer",
          attr: "like-status",
          match: /^LIKE$/,
        },
        // Button label describes the current mode: "Repeat off" / "Repeat all" / "Repeat one"
        repeat: {
          selector: "ytmusic-player-bar .repeat",
          attr: "aria-label",
          modes: { one: /one/i, all: /all/i },
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
    {
      id: "gaana",
      name: "Gaana",
      color: "#e72c30",
      hosts: ["gaana.com"],
      controls: {
        playPause: scoped(GAANA_BAR, [
          ...label("Play"),
          ...label("Pause"),
          ".playPause",
          '[class*="play_pause" i]',
          '[class*="playpause" i]',
        ]),
        next: scoped(GAANA_BAR, [...label("Next"), '[class*="next" i]']),
        previous: scoped(GAANA_BAR, [
          ...label("Previous"),
          '[class*="prev" i]',
        ]),
        shuffle: scoped(GAANA_BAR, [
          ...label("Shuffle"),
          '[class*="shuffle" i]',
        ]),
        repeat: scoped(GAANA_BAR, [...label("Repeat"), '[class*="repeat" i]']),
        seek: {
          slider: scoped(GAANA_BAR, [
            'input[type="range"]',
            '[role="slider"]',
            '[class*="progress" i]',
          ]),
        },
      },
      state: {
        isPlaying: {
          selector: scoped(GAANA_BAR, label("Pause")),
          exists: true,
        },
        title: scoped(GAANA_BAR, [
          '[class*="track_name" i]',
          '[class*="song_name" i]',
          '[class*="title" i]',
        ]),
        artist: scoped(GAANA_BAR, [
          '[class*="artist" i]',
          '[class*="singer" i]',
        ]),
        artwork: { selector: scoped(GAANA_BAR, ["img"]), prop: "src" },
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
