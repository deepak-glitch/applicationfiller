/*
 * JobFill background service worker (MV3).
 *
 * Two small jobs:
 *   1. FILL_TAB   (from the popup) — broadcast a fill to every frame in a tab
 *                 and report back the total number of fields filled.
 *   2. FILL_ALL_FRAMES (from the floating button) — broadcast a fill to every
 *                 frame in the sender's tab (so an embedded iframe form fills).
 *
 * Content scripts report each frame's result via FRAME_RESULT; we sum those
 * for the popup so it can show an accurate count even when the form lives in
 * an iframe.
 */

var pending = null; // { tabId, total, respond }

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  if (msg.type === 'FILL_TAB' && typeof msg.tabId === 'number') {
    pending = { tabId: msg.tabId, total: 0, respond: sendResponse };
    chrome.tabs.sendMessage(msg.tabId, { type: 'FILL' });
    // Frames fill synchronously and report within a few ms; wait a beat, then
    // return the aggregated total to the popup.
    setTimeout(function () {
      if (pending && pending.respond) {
        try { pending.respond({ count: pending.total }); } catch (e) { /* popup closed */ }
      }
      pending = null;
    }, 400);
    return true; // keep the message channel open for the async response
  }

  if (msg.type === 'FILL_ALL_FRAMES' && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'FILL' });
    return;
  }

  if (msg.type === 'FRAME_RESULT') {
    if (pending && sender.tab && sender.tab.id === pending.tabId) {
      pending.total += (msg.count || 0);
    }
    return;
  }
});
