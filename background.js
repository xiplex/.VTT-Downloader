// Cross-browser API shim
const api = typeof browser !== "undefined" ? browser : chrome;

// tabId -> Set of VTT URLs detected via network requests
const networkVtts = new Map();

api.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;
    if (!isVttUrl(url) && !isVttContentType(details)) return;

    const tabId = details.tabId;
    if (tabId < 0) return;

    if (!networkVtts.has(tabId)) {
      networkVtts.set(tabId, new Set());
    }
    networkVtts.get(tabId).add(url);

    updateBadge(tabId);
    notifyPopup(tabId);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Also intercept requests before they complete to catch streaming VTTs
api.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    if (!isVttUrl(url)) return;

    const tabId = details.tabId;
    if (tabId < 0) return;

    if (!networkVtts.has(tabId)) {
      networkVtts.set(tabId, new Set());
    }
    networkVtts.get(tabId).add(url);

    updateBadge(tabId);
    notifyPopup(tabId);
  },
  { urls: ["<all_urls>"] }
);

// Clear stored VTTs when tab navigates
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    networkVtts.delete(tabId);
    updateBadge(tabId);
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  networkVtts.delete(tabId);
});

function isVttUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith(".vtt")) return true;
    const search = parsed.search.toLowerCase();
    if (search.includes("format=vtt") || search.includes("type=vtt")) return true;
    return false;
  } catch {
    return url.toLowerCase().includes(".vtt");
  }
}

function isVttContentType(details) {
  const headers = details.responseHeaders || [];
  for (const h of headers) {
    if (h.name.toLowerCase() === "content-type") {
      const v = h.value.toLowerCase();
      return v.includes("text/vtt") || v.includes("webvtt");
    }
  }
  return false;
}

function updateBadge(tabId) {
  const count = networkVtts.has(tabId) ? networkVtts.get(tabId).size : 0;
  const text = count > 0 ? String(count) : "";
  api.action.setBadgeText({ text, tabId });
  api.action.setBadgeBackgroundColor({ color: "#2563eb", tabId });
}

function notifyPopup(tabId) {
  api.runtime.sendMessage({ type: "vtt_updated", tabId }).catch(() => {
    // Popup not open, ignore
  });
}

// Handle messages from content script and popup
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "dom_vtts_found") {
    // Content script reports DOM-detected VTTs
    const tabId = sender.tab?.id;
    if (tabId == null || tabId < 0) return;

    if (!networkVtts.has(tabId)) {
      networkVtts.set(tabId, new Set());
    }
    const set = networkVtts.get(tabId);
    let changed = false;
    for (const url of message.urls) {
      if (!set.has(url)) {
        set.add(url);
        changed = true;
      }
    }
    if (changed) {
      updateBadge(tabId);
      notifyPopup(tabId);
    }
    sendResponse({ ok: true });
  }

  if (message.type === "get_vtts") {
    const tabId = message.tabId;
    const urls = networkVtts.has(tabId)
      ? Array.from(networkVtts.get(tabId))
      : [];
    sendResponse({ urls });
  }

  if (message.type === "clear_vtts") {
    const tabId = message.tabId;
    networkVtts.delete(tabId);
    updateBadge(tabId);
    sendResponse({ ok: true });
  }

  return true; // Keep message channel open for async sendResponse
});
