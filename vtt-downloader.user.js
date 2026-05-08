// ==UserScript==
// @name         VTT Downloader
// @namespace    https://github.com/xiplex/.vtt-downloader
// @version      1.0.0
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

  function resolveUrl(url) {
    try { return new URL(url, location.href).href; } catch { return url; }
  }

  function filenameFromUrl(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/");
      const name = parts[parts.length - 1];
      if (name && name.toLowerCase().includes(".vtt")) return decodeURIComponent(name);
    } catch {}
    return "subtitles.vtt";
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

  // Patch XMLHttpRequest
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      if (isVttUrl(url) && addVtt(url, "network")) updateUI();
      return origOpen(method, url, ...rest);
    };
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // Patch fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    if (url && isVttUrl(url) && addVtt(url, "network")) updateUI();
    return origFetch.apply(this, arguments);
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
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: #2563eb;
      color: #fff;
      border: none;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.4);
      display: none;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      transition: transform 0.15s, background 0.15s;
      line-height: 1;
      flex-direction: column;
      gap: 1px;
    }
    #vtt-dl-fab:hover { background: #1d4ed8; transform: scale(1.07); }
    #vtt-dl-fab .fab-label { font-size: 9px; font-weight: 600; letter-spacing: 0.5px; }
    #vtt-dl-fab .fab-count {
      position: absolute;
      top: -4px; right: -4px;
      background: #ef4444;
      color: #fff;
      border-radius: 10px;
      padding: 1px 5px;
      font-size: 10px;
      font-weight: 700;
      min-width: 18px;
      text-align: center;
    }

    #vtt-dl-panel {
      position: fixed;
      bottom: 86px;
      right: 24px;
      z-index: 2147483646;
      width: 340px;
      max-height: 460px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      display: none;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #f1f5f9;
      overflow: hidden;
    }
    #vtt-dl-panel.open { display: flex; }

    #vtt-dl-panel .vdp-header {
      display: flex;
      align-items: center;
      padding: 12px 14px 10px;
      border-bottom: 1px solid #334155;
      gap: 8px;
    }
    #vtt-dl-panel .vdp-logo {
      background: #2563eb;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 6px;
      border-radius: 5px;
    }
    #vtt-dl-panel .vdp-title { font-size: 13px; font-weight: 600; flex: 1; }
    #vtt-dl-panel .vdp-close {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 16px;
      cursor: pointer;
      line-height: 1;
      padding: 2px 4px;
    }
    #vtt-dl-panel .vdp-close:hover { color: #f1f5f9; }

    #vtt-dl-panel .vdp-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 14px;
      border-bottom: 1px solid #334155;
    }
    #vtt-dl-panel .vdp-count { font-size: 11px; color: #94a3b8; }
    #vtt-dl-panel .vdp-dl-all {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    #vtt-dl-panel .vdp-dl-all:hover { background: #1d4ed8; }

    #vtt-dl-panel .vdp-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    #vtt-dl-panel .vdp-item {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 9px 11px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 9px;
    }
    #vtt-dl-panel .vdp-item:last-child { margin-bottom: 0; }
    #vtt-dl-panel .vdp-info { flex: 1; min-width: 0; }
    #vtt-dl-panel .vdp-name {
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #vtt-dl-panel .vdp-src {
      font-size: 10px;
      color: #94a3b8;
      margin-top: 2px;
    }
    #vtt-dl-panel .vdp-tag {
      display: inline-block;
      background: #1e3a5f;
      color: #60a5fa;
      border-radius: 4px;
      padding: 1px 4px;
      font-size: 9px;
      font-weight: 700;
      margin-right: 4px;
      text-transform: uppercase;
    }
    #vtt-dl-panel .vdp-btn {
      background: transparent;
      border: 1px solid #2563eb;
      color: #2563eb;
      border-radius: 5px;
      padding: 4px 9px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #vtt-dl-panel .vdp-btn:hover { background: #2563eb; color: #fff; }
    #vtt-dl-panel .vdp-btn.done { border-color: #22c55e; color: #22c55e; }
  `);

  // ── UI construction ────────────────────────────────────────────────────────

  function buildUI() {
    // FAB button
    fab = document.createElement("button");
    fab.id = "vtt-dl-fab";
    fab.innerHTML = `VTT<span class="fab-label">FILES</span><span class="fab-count" id="vtt-dl-badge">0</span>`;
    fab.addEventListener("click", togglePanel);
    document.documentElement.appendChild(fab);

    // Panel
    panel = document.createElement("div");
    panel.id = "vtt-dl-panel";
    panel.innerHTML = `
      <div class="vdp-header">
        <span class="vdp-logo">VTT</span>
        <span class="vdp-title">VTT Downloader</span>
        <button class="vdp-close" id="vtt-dl-close">✕</button>
      </div>
      <div class="vdp-toolbar">
        <span class="vdp-count" id="vtt-dl-count">0 files found</span>
        <button class="vdp-dl-all" id="vtt-dl-all">Download All</button>
      </div>
      <div class="vdp-list" id="vtt-dl-list"></div>
    `;
    document.documentElement.appendChild(panel);

    document.getElementById("vtt-dl-close").addEventListener("click", () => {
      panel.classList.remove("open");
      panelVisible = false;
    });

    document.getElementById("vtt-dl-all").addEventListener("click", () => {
      const items = [...foundVtts.values()];
      items.forEach((item, i) => {
        setTimeout(() => downloadVtt(item.url, item.filename), i * 300);
      });
    });
  }

  function togglePanel() {
    panelVisible = !panelVisible;
    panel.classList.toggle("open", panelVisible);
  }

  function updateUI() {
    if (!fab || !panel) return;

    const count = foundVtts.size;
    fab.style.display = count > 0 ? "flex" : "none";
    document.getElementById("vtt-dl-badge").textContent = count;
    document.getElementById("vtt-dl-count").textContent =
      `${count} VTT file${count !== 1 ? "s" : ""} found`;

    const list = document.getElementById("vtt-dl-list");
    list.innerHTML = "";

    for (const { url, filename, source } of foundVtts.values()) {
      const item = document.createElement("div");
      item.className = "vdp-item";

      item.innerHTML = `
        <div class="vdp-info">
          <div class="vdp-name" title="${url}">${filename}</div>
          <div class="vdp-src">
            <span class="vdp-tag">${sourceLabel(source)}</span>${new URL(url).hostname}
          </div>
        </div>
        <button class="vdp-btn">Download</button>
      `;

      const btn = item.querySelector(".vdp-btn");
      btn.addEventListener("click", () => {
        downloadVtt(url, filename, btn);
      });

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
    a.style.display = "none";
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

    // Re-scan on SPA navigation
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
