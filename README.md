# Playback Controller (Chrome extension, MV3)

Control music on **Spotify, YouTube Music, Amazon Music, Gaana and JioSaavn** from one popup (`Alt+P`).

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a supported site, play something, click the toolbar icon.

Press `Alt+P` to open the popup (change it at `chrome://extensions/shortcuts`).
In the popup: `Space` play/pause, `←/→` prev/next, `Shift+←/→` seek ±10s.

## Search (Spotify for now)

Type in the popup's search box: the text is typed into the site's own search box, the site's
results dropdown is read back and shown in the popup, and picking a row clicks that row's ▶ on
the site. Suggestion rows (just a search term) search for that term instead. Configure it per
site with a `search` block in `src/content/sites.js`.

## How it works

```
popup ─────────────chrome.runtime──▶ bridge.js (isolated world)
                                        │ window.postMessage
                                        ▼
                    engine.js (page MAIN world) ◀── sites.js (per-site config)
```

- **`src/content/sites.js`**: the **only** site-specific file. Each entry lists hostnames and the
  selectors to *click* (play/pause, next, previous, shuffle, repeat, like), *slide* (seek, volume)
  and *read* (title, artist, artwork, times, toggle states).
- **`src/content/engine.js`**: one generic controller. It detects the site by hostname and acts
  **only** through that site's selectors: it clicks buttons and moves sliders (range input,
  Polymer slider, or a synthetic pointer drag). If a selector doesn't match, that control is
  disabled in the popup. Nothing falls back.
- **`src/background.js`**: keeps a registry of player tabs, and injects scripts into tabs that were already open at install.
- **`src/popup/`**: now-playing UI. Shows chips to switch between players when several tabs have one.

## Adding / fixing a site

1. Add (or edit) an entry in `src/content/sites.js`, plus its URL pattern in both
   `content_scripts.matches` and `host_permissions` in `manifest.json`.
2. Reload the extension and the site tab.
3. Open the popup. A greyed-out button means its selector matched nothing on the page.

Music sites change their markup often. Spotify and YouTube Music selectors are based on their
stable `data-testid`/component names. JioSaavn has been tuned against the live site. Amazon Music
and Gaana entries are still best guesses.
