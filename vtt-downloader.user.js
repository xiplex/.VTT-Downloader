// ==UserScript==
// @name         VTT Downloader
// @namespace    https://github.com/xiplex/.vtt-downloader
// @version      1.1.0
// @description  Detects WebVTT subtitle files on any page and shows a floating download panel
// @author       xiplex
// @match        *://*/*
// @grant        GM_download
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const foundVtts = new Map(); // url -> { url, filename, source }
  let panelVisible = false;
  let panel = null;
  let fab = null;
  let uiReady = false;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function isVttUrl(url) {
    if (!url || typeof url !== "string") return false;
    try {
      const parsed = new URL(url, location.href);
      const path = parsed.pathname.toLowerCase();
      if (path.endsWith(".vtt")) return true;
      const search = parsed.search.toLowerCase();
      if (search.includes("format=vtt") || search.includes("type=vtt")) return true;
    } catch {
      return url.toLowerCase().includes(".vtt");
    }
    return false;
  }

  function isVttContentType(ct) {
    if (!ct) return false;
    const l = ct.toLowerCase();
    return l.includes("text/vtt") || l.includes("webvtt");
  }

  function resolveUrl(url) {
    try { return new URL(url, location.href).href; } catch { return url; }
  }

  function filenameFromUrl(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/");
      const name = parts[parts.length - 1];
      if (name && name.toLowerCase().includes(".vtt")) return decodeURIComponent(name);
      // Fall back to last path segment + .vtt
      const seg = name || parts.filter(Boolean).pop() || "subtitles";
      return decodeURIComponent(seg.split("?")[0]) + ".vtt";
    } catch {}
    return "subtitles.vtt";
  }

  function hostnameFromUrl(url) {
    try { return new URL(url).hostname; } catch { return url.slice(0, 30); }
  }

  function sourceLabel(src) {
    const labels = { network: "Network", track: "<track>", link: "<a>", script: "<script>" };
    return labels[src] || src;
  }

  function addVtt(url, source) {
    const resolved = resolveUrl(url);
    if (!resolved || foundVtts.has(resolved)) return false;
    foundVtts.set(resolved, { url: resolved, filename: filenameFromUrl(resolved), source });
    return true;
  }

  // ── Network interception (runs before page scripts) ────────────────────────

  // Patch XMLHttpRequest — check both request URL and response Content-Type
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let pendingUrl = null;

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      pendingUrl = url;
      if (isVttUrl(url) && addVtt(url, "network")) updateUI();
      return origOpen(method, url, ...rest);
    };

    xhr.addEventListener("load", function () {
      if (!pendingUrl) return;
      const ct = xhr.getResponseHeader("content-type") || "";
      if (isVttContentType(ct) && addVtt(pendingUrl, "network")) updateUI();
    });

    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // Patch fetch — check both request URL and response Content-Type
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url);
    if (url && isVttUrl(url) && addVtt(url, "network")) updateUI();

    const promise = origFetch.apply(this, arguments);

    if (url) {
      promise.then((response) => {
        try {
          const ct = response.headers.get("content-type") || "";
          const finalUrl = response.url || url;
          if (isVttContentType(ct) && addVtt(finalUrl, "network")) updateUI();
        } catch {}
        return response;
      }).catch(() => {});
    }

    return promise;
  };

  // ── DOM scanning ───────────────────────────────────────────────────────────

  function scanDOM() {
    let changed = false;

    document.querySelectorAll("track[src]").forEach((el) => {
      const url = el.src || el.getAttribute("src");
      if (url && isVttUrl(url) && addVtt(url, "track")) changed = true;
    });

    document.querySelectorAll("source[src]").forEach((el) => {
      const url = el.src || el.getAttribute("src");
      if (url && isVttUrl(url) && addVtt(url, "track")) changed = true;
    });

    document.querySelectorAll("a[href]").forEach((el) => {
      const url = el.getAttribute("href");
      if (url && isVttUrl(url) && addVtt(url, "link")) changed = true;
    });

    document.querySelectorAll("script:not([src])").forEach((el) => {
      const matches = (el.textContent || "").match(/https?:\/\/[^\s"'<>]+\.vtt[^\s"'<>]*/gi) || [];
      for (const raw of matches) {
        const url = raw.replace(/[,;)\]}>]+$/, "");
        if (addVtt(url, "script")) changed = true;
      }
    });

    if (changed) updateUI();
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  GM_addStyle(`
    #vtt-dl-fab {
      all: initial;
      position: fixed !important;
      bottom: 24px !important;
      right: 24px !important;
      z-index: 2147483647 !important;
      width: 52px !important;
      height: 52px !important;
      border-radius: 50% !important;
      background: #64748b !important;
      color: #fff !important;
      border: none !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      box-shadow: 0 4px 14px rgba(0,0,0,0.35) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      transition: transform 0.15s, background 0.15s !important;
      line-height: 1 !important;
      flex-direction: column !important;
      gap: 1px !important;
      opacity: 0.55 !important;
      user-select: none !important;
    }
    #vtt-dl-fab.has-vtts {
      background: #2563eb !important;
      opacity: 1 !important;
    }
    #vtt-dl-fab:hover {
      background: #1d4ed8 !important;
      transform: scale(1.07) !important;
      opacity: 1 !important;
    }
    #vtt-dl-fab .fab-label {
      font-size: 8px !important;
      font-weight: 600 !important;
      letter-spacing: 0.5px !important;
      font-family: inherit !important;
    }
    #vtt-dl-fab .fab-count {
      all: initial;
      position: absolute !important;
      top: -4px !important;
      right: -4px !important;
      background: #ef4444 !important;
      color: #fff !important;
      border-radius: 10px !important;
      padding: 1px 5px !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      min-width: 18px !important;
      text-align: center !important;
      display: none !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    }
    #vtt-dl-fab.has-vtts .fab-count { display: block !important; }

    #vtt-dl-panel {
      all: initial;
      position: fixed !important;
      bottom: 86px !important;
      right: 24px !important;
      z-index: 2147483646 !important;
      width: 340px !important;
      max-height: 460px !important;
      background: #0f172a !important;
      border: 1px solid #334155 !important;
      border-radius: 12px !important;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6) !important;
      display: none !important;
      flex-direction: column !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      color: #f1f5f9 !important;
      overflow: hidden !important;
    }
    #vtt-dl-panel.open { display: flex !important; }

    #vtt-dl-panel * { box-sizing: border-box !important; }

    .vdp-header {
      display: flex !important;
      align-items: center !important;
      padding: 12px 14px 10px !important;
      border-bottom: 1px solid #334155 !important;
      gap: 8px !important;
    }
    .vdp-logo {
      background: #2563eb !important;
      color: #fff !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      padding: 3px 6px !important;
      border-radius: 5px !important;
    }
    .vdp-title { font-size: 13px !important; font-weight: 600 !important; flex: 1 !important; color: #f1f5f9 !important; }
    .vdp-close {
      all: initial !important;
      color: #94a3b8 !important;
      font-size: 16px !important;
      cursor: pointer !important;
      line-height: 1 !important;
      padding: 2px 4px !important;
      font-family: inherit !important;
    }
    .vdp-close:hover { color: #f1f5f9 !important; }

    .vdp-toolbar {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 7px 14px !important;
      border-bottom: 1px solid #334155 !important;
    }
    .vdp-toolbar-left { display: flex !important; align-items: center !important; gap: 8px !important; }
    .vdp-count { font-size: 11px !important; color: #94a3b8 !important; }
    .vdp-dl-all {
      all: initial !important;
      background: #2563eb !important;
      color: #fff !important;
      border-radius: 6px !important;
      padding: 4px 10px !important;
      font-size: 11px !important;
      font-weight: 600 !important;
      cursor: pointer !important;
      font-family: inherit !important;
    }
    .vdp-dl-all:hover { background: #1d4ed8 !important; }
    .vdp-dl-all:disabled { opacity: 0.4 !important; cursor: default !important; }

    .vdp-list {
      flex: 1 !important;
      overflow-y: auto !important;
      padding: 8px !important;
    }

    .vdp-empty {
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 28px 16px !important;
      gap: 8px !important;
      color: #94a3b8 !important;
      text-align: center !important;
      font-size: 12px !important;
    }
    .vdp-empty-icon { font-size: 28px !important; }

    .vdp-item {
      background: #1e293b !important;
      border: 1px solid #334155 !important;
      border-radius: 8px !important;
      padding: 9px 11px !important;
      margin-bottom: 6px !important;
      display: flex !important;
      align-items: center !important;
      gap: 9px !important;
    }
    .vdp-item:last-child { margin-bottom: 0 !important; }
    .vdp-info { flex: 1 !important; min-width: 0 !important; }
    .vdp-name {
      font-size: 12px !important;
      font-weight: 500 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      color: #f1f5f9 !important;
    }
    .vdp-src {
      font-size: 10px !important;
      color: #94a3b8 !important;
      margin-top: 2px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    .vdp-tag {
      display: inline-block !important;
      background: #1e3a5f !important;
      color: #60a5fa !important;
      border-radius: 4px !important;
      padding: 1px 4px !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      margin-right: 4px !important;
      text-transform: uppercase !important;
    }
    .vdp-btn {
      all: initial !important;
      border: 1px solid #2563eb !important;
      color: #2563eb !important;
      border-radius: 5px !important;
      padding: 4px 9px !important;
      font-size: 10px !important;
      font-weight: 600 !important;
      cursor: pointer !important;
      white-space: nowrap !important;
      flex-shrink: 0 !important;
      font-family: inherit !important;
    }
    .vdp-btn:hover { background: #2563eb !important; color: #fff !important; }
    .vdp-btn.done { border-color: #22c55e !important; color: #22c55e !important; }
  `);

  // ── UI construction ────────────────────────────────────────────────────────

  function buildUI() {
    fab = document.createElement("button");
    fab.id = "vtt-dl-fab";
    fab.title = "VTT Downloader — click to open";
    fab.innerHTML = `VTT<span class="fab-label">FILES</span><span class="fab-count" id="vtt-dl-badge"></span>`;
    fab.addEventListener("click", togglePanel);
    document.documentElement.appendChild(fab);

    panel = document.createElement("div");
    panel.id = "vtt-dl-panel";
    panel.innerHTML = `
      <div class="vdp-header">
        <span class="vdp-logo">VTT</span>
        <span class="vdp-title">VTT Downloader</span>
        <button class="vdp-close" id="vtt-dl-close" title="Close">✕</button>
      </div>
      <div class="vdp-toolbar">
        <span class="vdp-count" id="vtt-dl-count">Scanning…</span>
        <button class="vdp-dl-all" id="vtt-dl-all" disabled>Download All</button>
      </div>
      <div class="vdp-list" id="vtt-dl-list">
        <div class="vdp-empty">
          <div class="vdp-empty-icon">🔍</div>
          <div>Watching for VTT files.<br>Play the video to trigger subtitle loading.</div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    document.getElementById("vtt-dl-close").addEventListener("click", () => {
      panel.classList.remove("open");
      panelVisible = false;
    });

    document.getElementById("vtt-dl-all").addEventListener("click", () => {
      [...foundVtts.values()].forEach((item, i) => {
        setTimeout(() => downloadVtt(item.url, item.filename), i * 300);
      });
    });

    uiReady = true;
    updateUI();
  }

  function togglePanel() {
    panelVisible = !panelVisible;
    panel.classList.toggle("open", panelVisible);
  }

  function updateUI() {
    if (!uiReady) return;

    const count = foundVtts.size;

    // FAB state
    fab.classList.toggle("has-vtts", count > 0);
    const badge = document.getElementById("vtt-dl-badge");
    if (badge) badge.textContent = count > 0 ? count : "";

    // Toolbar
    const countEl = document.getElementById("vtt-dl-count");
    const dlAll = document.getElementById("vtt-dl-all");
    if (countEl) countEl.textContent = count > 0 ? `${count} VTT file${count !== 1 ? "s" : ""} found` : "No VTT files yet";
    if (dlAll) dlAll.disabled = count === 0;

    // List
    const list = document.getElementById("vtt-dl-list");
    if (!list) return;
    list.innerHTML = "";

    if (count === 0) {
      list.innerHTML = `
        <div class="vdp-empty">
          <div class="vdp-empty-icon">🔍</div>
          <div>Watching for VTT files.<br>Play the video to trigger subtitle loading.</div>
        </div>`;
      return;
    }

    for (const { url, filename, source } of foundVtts.values()) {
      const item = document.createElement("div");
      item.className = "vdp-item";

      const info = document.createElement("div");
      info.className = "vdp-info";
      info.innerHTML = `
        <div class="vdp-name" title="${url}">${filename}</div>
        <div class="vdp-src"><span class="vdp-tag">${sourceLabel(source)}</span>${hostnameFromUrl(url)}</div>
      `;

      const btn = document.createElement("button");
      btn.className = "vdp-btn";
      btn.textContent = "Download";
      btn.addEventListener("click", () => downloadVtt(url, filename, btn));

      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    }
  }

  function downloadVtt(url, filename, btn) {
    if (typeof GM_download !== "undefined") {
      GM_download({ url, name: filename, onerror: () => fallbackDownload(url, filename) });
    } else {
      fallbackDownload(url, filename);
    }
    if (btn) { btn.textContent = "✓ Saved"; btn.classList.add("done"); }
  }

  function fallbackDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.cssText = "display:none!important";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function init() {
    buildUI();
    scanDOM();

    const observer = new MutationObserver(() => scanDOM());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        foundVtts.clear();
        setTimeout(scanDOM, 600);
      }
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
