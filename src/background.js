/*
 * Playback Controller — background service worker
 * ---------------------------------------------------------------------------
 *  - keeps a registry of tabs that have a music player (chrome.storage.session
 *    so it survives service-worker restarts),
 *  - routes keyboard shortcuts to the most relevant player,
 *  - injects the content scripts into already-open tabs on install/update.
 */
const KEY = 'players';

let queue = Promise.resolve();
/** Serialised read-modify-write of the registry. */
function mutate(fn) {
  queue = queue
    .then(async () => {
      const { [KEY]: players = {} } = await chrome.storage.session.get(KEY);
      fn(players);
      await chrome.storage.session.set({ [KEY]: players });
    })
    .catch((e) => console.error('[PlaybackController]', e));
  return queue;
}

async function listPlayers() {
  await queue;
  const { [KEY]: players = {} } = await chrome.storage.session.get(KEY);
  return Object.values(players).sort(
    (a, b) =>
      Number(b.isPlaying) - Number(a.isPlaying) ||
      (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) ||
      (b.updatedAt || 0) - (a.updatedAt || 0),
  );
}

const forget = (tabIds) => mutate((p) => tabIds.forEach((id) => delete p[id]));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'player-event': {
      const tab = sender.tab;
      if (!tab?.id) return false;
      mutate((p) => {
        const prev = p[tab.id] || {};
        const now = Date.now();
        p[tab.id] = {
          ...prev,
          ...msg.data,
          tabId: tab.id,
          windowId: tab.windowId,
          updatedAt: now,
          lastPlayedAt: msg.data.isPlaying ? now : prev.lastPlayedAt || 0,
        };
      });
      return false;
    }
    case 'list-players':
      listPlayers().then(sendResponse);
      return true;
    case 'forget':
      forget(msg.tabIds || []);
      return false;
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => forget([tabId]));

// ─────────────── inject into tabs that were open before install ───────────
chrome.runtime.onInstalled.addListener(async () => {
  const scripts = chrome.runtime.getManifest().content_scripts || [];
  const matches = [...new Set(scripts.flatMap((cs) => cs.matches))];
  const tabs = await chrome.tabs.query({ url: matches });
  for (const tab of tabs) {
    for (const cs of scripts) {
      try {
        // MAIN (engine) first, then ISOLATED (bridge) — order matters.
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: cs.js,
          world: cs.world || 'ISOLATED',
        });
      } catch {
        /* discarded / restricted tab */
      }
    }
  }
});
