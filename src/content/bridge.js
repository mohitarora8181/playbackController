/*
 * Playback Controller — BRIDGE (isolated content-script world)
 * ---------------------------------------------------------------------------
 * The engine lives in the page's MAIN world (so it can see the site's media
 * session handlers / web-component properties) but has no chrome.* APIs.
 * This script relays:
 *   popup/background --chrome.runtime--> bridge --postMessage--> engine
 *   engine --postMessage--> bridge --chrome.runtime--> background
 */
(() => {
  'use strict';
  const CHANNEL = 'playback-controller:v1';
  const TIMEOUT_MS = 10000; // search waits for the site's results, which can take a few seconds
  const pending = new Map();
  let seq = 0;

  function callEngine(method, args = []) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++seq}-${Math.random().toString(36).slice(2)}`;
      pending.set(id, resolve);
      window.postMessage({ channel: CHANNEL, dir: 'to-engine', id, method, args }, location.origin);
      setTimeout(() => {
        if (pending.delete(id)) resolve({ error: 'engine timeout' });
      }, TIMEOUT_MS);
    });
  }

  function toBackground(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // Extension was reloaded; this orphaned script can no longer talk to it.
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'to-bridge') return;
    if (msg.id) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg.result);
      }
    } else if (msg.event === 'state') {
      toBackground({ type: 'player-event', data: msg.data });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'engine-call') return false;
    callEngine(msg.method, msg.args).then(sendResponse);
    return true; // async response
  });

  // Ask the engine to (re)announce its state now that we're listening.
  callEngine('hello');
})();
