// Cross-browser API shim
const api = typeof browser !== "undefined" ? browser : chrome;

const foundVtts = new Set();

function isVttUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url, location.href);
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith(".vtt")) return true;
    const search = parsed.search.toLowerCase();
    if (search.includes("format=vtt") || search.includes("type=vtt")) return true;
    return false;
  } catch {
    return url.toLowerCase().includes(".vtt");
  }
}

function resolveUrl(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

function reportVtts(urls) {
  if (urls.length === 0) return;
  api.runtime.sendMessage({ type: "dom_vtts_found", urls }).catch(() => {});
}

function scanDOM() {
  const newUrls = [];

  // <track src="*.vtt"> inside <video>
  document.querySelectorAll("track[src]").forEach((el) => {
    const url = resolveUrl(el.src || el.getAttribute("src"));
    if (isVttUrl(url) && !foundVtts.has(url)) {
      foundVtts.add(url);
      newUrls.push(url);
    }
  });

  // <source src="*.vtt"> (rare but valid)
  document.querySelectorAll("source[src]").forEach((el) => {
    const url = resolveUrl(el.src || el.getAttribute("src"));
    if (isVttUrl(url) && !foundVtts.has(url)) {
      foundVtts.add(url);
      newUrls.push(url);
    }
  });

  // <a href="*.vtt">
  document.querySelectorAll("a[href]").forEach((el) => {
    const url = resolveUrl(el.getAttribute("href"));
    if (isVttUrl(url) && !foundVtts.has(url)) {
      foundVtts.add(url);
      newUrls.push(url);
    }
  });

  // Scan inline script content for VTT URLs (e.g. JSON config blobs)
  document.querySelectorAll("script:not([src])").forEach((el) => {
    const text = el.textContent || "";
    const matches = text.match(/https?:\/\/[^\s"'<>]+\.vtt[^\s"'<>]*/gi) || [];
    for (const raw of matches) {
      const url = raw.replace(/[,;)\]}>]+$/, ""); // strip trailing punctuation
      if (!foundVtts.has(url)) {
        foundVtts.add(url);
        newUrls.push(url);
      }
    }
  });

  reportVtts(newUrls);
}

// Initial scan
scanDOM();

// Watch for dynamically added elements
const observer = new MutationObserver((mutations) => {
  let needsScan = false;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        needsScan = true;
        break;
      }
    }
    if (needsScan) break;
  }
  if (needsScan) scanDOM();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// Handle rescan requests from popup
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "rescan") {
    foundVtts.clear();
    scanDOM();
    sendResponse({ ok: true });
  }
  return true;
});

// Rescan on page-level attribute changes (e.g. SPA route changes)
let lastUrl = location.href;
const urlObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    foundVtts.clear();
    setTimeout(scanDOM, 500);
  }
});
urlObserver.observe(document.documentElement, { subtree: true, childList: true });
