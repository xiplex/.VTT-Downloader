// ==UserScript==
// @name         VTT Downloader
// @namespace    https://github.com/xiplex/.vtt-downloader
// @version      1.2.0
// @description  Detects WebVTT subtitle files on any page and shows a floating download panel
// @author       xiplex
// @match        *://*/*
// @grant        GM_download
// @grant        GM_addStyle
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // url -> { url, filename, source, isHls?, isBlob? }
  const foundVtts = new Map();
  // blob: url -> vtt text content (so we can re-download after page revokes it)
  const blobVttStore = new Map();

  let panelVisible = false;
  let panel = null;
  let fab = null;
  let uiReady = false;

  // ── URL / content-type helpers ─────────────────────────────────────────────

  function isVttUrl(url) {
    if (!url || typeof url !== "string") return false;
    try {
      const parsed = new URL(url, location.href);
      const path = parsed.pathname.toLowerCase();
      if (path.endsWith(".vtt")) return true;
      const q = parsed.search.toLowerCase();
      if (q.includes("format=vtt") || q.includes("type=vtt")) return true;
    } catch {
      return url.toLowerCase().includes(".vtt");
    }
    return false;
  }

  function isVttContentType(ct) {
    const l = (ct || "").toLowerCase();
    return l.includes("text/vtt") || l.includes("webvtt");
  }

  function isHlsContentType(ct) {
    const l = (ct || "").toLowerCase();
    return l.includes("mpegurl") || l.includes("x-mpegurl");
  }

  // Only inspect bodies that are text-like and small enough
  function shouldInspectBody(ct, contentLength) {
    const cl = parseInt(contentLength || "0", 10);
    if (cl > 524288) return false; // skip > 512 KB
    const l = (ct || "").toLowerCase();
    if (/^(video|audio|image|font)\//.test(l)) return false;
    return true;
  }

  function resolveUrl(url, base) {
    try { return new URL(url, base || location.href).href; } catch { return url; }
  }

  function filenameFromUrl(url, fallback) {
    try {
      const parsed = new URL(url);
      const seg = parsed.pathname.split("/").filter(Boolean).pop() || "";
      const clean = decodeURIComponent(seg.split("?")[0]);
      if (clean) return clean.endsWith(".vtt") ? clean : clean + ".vtt";
    } catch {}
    return fallback || "subtitles.vtt";
  }

  function hostnameFromUrl(url) {
    try { return new URL(url).hostname; } catch { return url.slice(0, 30); }
  }

  function sourceLabel(src) {
    return { network: "Network", track: "<track>", link: "<a>",
             script: "<script>", blob: "Blob", hls: "HLS", api: "API" }[src] || src;
  }

  // ── VTT store ──────────────────────────────────────────────────────────────

  function addVtt(url, source, extra) {
    const resolved = resolveUrl(url);
    if (!resolved || foundVtts.has(resolved)) return false;
    foundVtts.set(resolved, {
      url: resolved,
      filename: filenameFromUrl(resolved),
      source,
      ...extra,
    });
    return true;
  }

  // ── HLS / M3U8 parsing ─────────────────────────────────────────────────────

  function parseM3U8Attrs(str) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
    let m;
    while ((m = re.exec(str)) !== null) attrs[m[1]] = m[2] ?? m[3];
    return attrs;
  }

  function processM3U8Body(text, fromUrl) {
    const isM3U8 = text.trimStart().startsWith("#EXTM3U");
    if (!isM3U8) return false;

    // Master playlist — extract subtitle track URIs
    const extMediaRe = /#EXT-X-MEDIA:([^\r\n]+)/g;
    let m;
    let found = false;
    while ((m = extMediaRe.exec(text)) !== null) {
      const attrs = parseM3U8Attrs(m[1]);
      if (attrs.TYPE !== "SUBTITLES" && attrs.TYPE !== "CLOSED-CAPTIONS") continue;
      if (!attrs.URI) continue;
      const trackUrl = resolveUrl(attrs.URI, fromUrl);
      const name = attrs.NAME || attrs.LANGUAGE || "Subtitles";
      const lang = attrs.LANGUAGE || "";
      if (addVtt(trackUrl, "hls", {
        filename: `${name}${lang ? "_" + lang : ""}.vtt`,
        isHls: true,
        hlsLabel: name,
      })) {
        found = true;
        updateUI();
      }
    }

    // Subtitle segment playlist — lines that aren't comments are segment URLs
    const lines = text.split(/\r?\n/);
    const segUrls = lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .filter((l) => {
        // Only include if looks like a URL (relative or absolute)
        try { new URL(l, fromUrl); return true; } catch { return false; }
      })
      .map((l) => resolveUrl(l, fromUrl));

    if (segUrls.length > 0 && text.includes("EXTINF")) {
      // This IS a subtitle segment playlist — add the playlist itself for merged download
      if (addVtt(fromUrl, "hls", {
        isHls: true,
        hlsSegments: segUrls,
        filename: filenameFromUrl(fromUrl, "subtitles.vtt"),
        hlsLabel: "HLS Subtitles",
      })) {
        found = true;
        updateUI();
      }
    }

    return found;
  }

  // ── Response body inspection ───────────────────────────────────────────────

  function inspectBody(text, finalUrl) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("WEBVTT")) {
      if (addVtt(finalUrl, "network")) updateUI();
      return;
    }
    if (trimmed.startsWith("#EXTM3U")) {
      processM3U8Body(text, finalUrl);
      return;
    }
    // JSON API responses — scan for VTT URLs in string values
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const scanObj = (obj, depth) => {
          if (depth > 6 || !obj || typeof obj !== "object") return;
          for (const val of Object.values(obj)) {
            if (typeof val === "string" && isVttUrl(val)) {
              if (addVtt(val, "api")) updateUI();
            } else if (val && typeof val === "object") {
              scanObj(val, depth + 1);
            }
          }
        };
        scanObj(JSON.parse(text), 0);
      } catch {}
    }
  }

  // ── Network interception ───────────────────────────────────────────────────

  // Patch fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    if (url && isVttUrl(url) && addVtt(url, "network")) updateUI();

    const promise = origFetch.apply(this, arguments);

    if (url) {
      promise.then((response) => {
        try {
          const ct = response.headers.get("content-type") || "";
          const cl = response.headers.get("content-length") || "";
          const finalUrl = response.url || url;

          if (isVttContentType(ct)) {
            if (addVtt(finalUrl, "network")) updateUI();
            return;
          }
          if (isHlsContentType(ct)) {
            response.clone().text().then((t) => processM3U8Body(t, finalUrl)).catch(() => {});
            return;
          }
          if (shouldInspectBody(ct, cl)) {
            response.clone().text().then((t) => inspectBody(t, finalUrl)).catch(() => {});
          }
        } catch {}
      }).catch(() => {});
    }

    return promise;
  };

  // Patch XMLHttpRequest
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
      const cl = xhr.getResponseHeader("content-length") || "";
      const finalUrl = xhr.responseURL || pendingUrl;

      if (isVttContentType(ct)) {
        if (addVtt(finalUrl, "network")) updateUI();
        return;
      }
      if (isHlsContentType(ct)) {
        const t = xhr.responseText;
        if (t) processM3U8Body(t, finalUrl);
        return;
      }
      if (shouldInspectBody(ct, cl)) {
        const t = xhr.responseType === "" || xhr.responseType === "text"
          ? xhr.responseText
          : null;
        if (t) inspectBody(t, finalUrl);
      }
    });

    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // Intercept blob: URLs created from VTT content (e.g. ASS→VTT conversion)
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL.call(URL, obj);
    if (obj instanceof Blob && obj.size < 524288) {
      obj.text().then((text) => {
        if (text.trimStart().startsWith("WEBVTT")) {
          blobVttStore.set(blobUrl, text);
          if (addVtt(blobUrl, "blob", { isBlob: true, blobText: text })) updateUI();
        }
      }).catch(() => {});
    }
    return blobUrl;
  };

  const origRevokeObjectURL = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) {
    // Keep blobVttStore entry — user may still want to download it
    return origRevokeObjectURL.call(URL, url);
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
        if (addVtt(raw.replace(/[,;)\]}>]+$/, ""), "script")) changed = true;
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
      transition: transform 0.15s, background 0.15s, opacity 0.15s !important;
      line-height: 1 !important;
      flex-direction: column !important;
      gap: 1px !important;
      opacity: 0.5 !important;
      user-select: none !important;
    }
    #vtt-dl-fab.has-vtts { background: #2563eb !important; opacity: 1 !important; }
    #vtt-dl-fab:hover    { background: #1d4ed8 !important; opacity: 1 !important; transform: scale(1.07) !important; }
    #vtt-dl-fab .fab-label { font-size: 8px !important; font-weight: 600 !important; letter-spacing: 0.5px !important; font-family: inherit !important; }
    #vtt-dl-fab .fab-count {
      all: initial; position: absolute !important; top: -4px !important; right: -4px !important;
      background: #ef4444 !important; color: #fff !important; border-radius: 10px !important;
      padding: 1px 5px !important; font-size: 10px !important; font-weight: 700 !important;
      min-width: 18px !important; text-align: center !important; display: none !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    }
    #vtt-dl-fab.has-vtts .fab-count { display: block !important; }

    #vtt-dl-panel {
      all: initial; position: fixed !important; bottom: 86px !important; right: 24px !important;
      z-index: 2147483646 !important; width: 360px !important; max-height: 480px !important;
      background: #0f172a !important; border: 1px solid #334155 !important; border-radius: 12px !important;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6) !important; display: none !important;
      flex-direction: column !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      color: #f1f5f9 !important; overflow: hidden !important;
    }
    #vtt-dl-panel.open { display: flex !important; }
    #vtt-dl-panel * { box-sizing: border-box !important; }

    .vdp-header { display: flex !important; align-items: center !important; padding: 12px 14px 10px !important; border-bottom: 1px solid #334155 !important; gap: 8px !important; }
    .vdp-logo   { background: #2563eb !important; color: #fff !important; font-size: 11px !important; font-weight: 700 !important; padding: 3px 6px !important; border-radius: 5px !important; }
    .vdp-title  { font-size: 13px !important; font-weight: 600 !important; flex: 1 !important; color: #f1f5f9 !important; }
    .vdp-close  { all: initial !important; color: #94a3b8 !important; font-size: 16px !important; cursor: pointer !important; padding: 2px 4px !important; font-family: inherit !important; }
    .vdp-close:hover { color: #f1f5f9 !important; }

    .vdp-toolbar { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 7px 14px !important; border-bottom: 1px solid #334155 !important; }
    .vdp-count  { font-size: 11px !important; color: #94a3b8 !important; }
    .vdp-dl-all { all: initial !important; background: #2563eb !important; color: #fff !important; border-radius: 6px !important; padding: 4px 10px !important; font-size: 11px !important; font-weight: 600 !important; cursor: pointer !important; font-family: inherit !important; }
    .vdp-dl-all:hover    { background: #1d4ed8 !important; }
    .vdp-dl-all:disabled { opacity: 0.4 !important; cursor: default !important; background: #2563eb !important; }

    .vdp-list { flex: 1 !important; overflow-y: auto !important; padding: 8px !important; }
    .vdp-empty { display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; padding: 28px 16px !important; gap: 8px !important; color: #94a3b8 !important; text-align: center !important; font-size: 12px !important; line-height: 1.5 !important; }
    .vdp-empty-icon { font-size: 28px !important; }

    .vdp-item { background: #1e293b !important; border: 1px solid #334155 !important; border-radius: 8px !important; padding: 9px 11px !important; margin-bottom: 6px !important; display: flex !important; align-items: center !important; gap: 9px !important; }
    .vdp-item:last-child { margin-bottom: 0 !important; }
    .vdp-info { flex: 1 !important; min-width: 0 !important; }
    .vdp-name { font-size: 12px !important; font-weight: 500 !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; color: #f1f5f9 !important; }
    .vdp-src  { font-size: 10px !important; color: #94a3b8 !important; margin-top: 2px !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
    .vdp-tag  { display: inline-block !important; background: #1e3a5f !important; color: #60a5fa !important; border-radius: 4px !important; padding: 1px 4px !important; font-size: 9px !important; font-weight: 700 !important; margin-right: 4px !important; text-transform: uppercase !important; }
    .vdp-tag.hls  { background: #1c3a2a !important; color: #4ade80 !important; }
    .vdp-tag.blob { background: #3a1c3a !important; color: #e879f9 !important; }

    .vdp-btn { all: initial !important; border: 1px solid #2563eb !important; color: #2563eb !important; border-radius: 5px !important; padding: 4px 9px !important; font-size: 10px !important; font-weight: 600 !important; cursor: pointer !important; white-space: nowrap !important; flex-shrink: 0 !important; font-family: inherit !important; transition: background 0.1s !important; }
    .vdp-btn:hover { background: #2563eb !important; color: #fff !important; }
    .vdp-btn.done { border-color: #22c55e !important; color: #22c55e !important; }
    .vdp-btn.busy { border-color: #f59e0b !important; color: #f59e0b !important; cursor: default !important; }
    .vdp-btn.err  { border-color: #ef4444 !important; color: #ef4444 !important; }
  `);

  // ── UI ─────────────────────────────────────────────────────────────────────

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
      <div class="vdp-list" id="vtt-dl-list"></div>
    `;
    document.documentElement.appendChild(panel);

    document.getElementById("vtt-dl-close").addEventListener("click", () => {
      panel.classList.remove("open");
      panelVisible = false;
    });

    document.getElementById("vtt-dl-all").addEventListener("click", () => {
      [...foundVtts.values()].forEach((item, i) => {
        setTimeout(() => triggerItemDownload(item), i * 400);
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

    fab.classList.toggle("has-vtts", count > 0);
    const badge = document.getElementById("vtt-dl-badge");
    if (badge) badge.textContent = count > 0 ? count : "";

    const countEl = document.getElementById("vtt-dl-count");
    const dlAll   = document.getElementById("vtt-dl-all");
    if (countEl) countEl.textContent = count > 0 ? `${count} VTT file${count !== 1 ? "s" : ""} found` : "No VTT files yet";
    if (dlAll)   dlAll.disabled = count === 0;

    const list = document.getElementById("vtt-dl-list");
    if (!list) return;
    list.innerHTML = "";

    if (count === 0) {
      list.innerHTML = `<div class="vdp-empty"><div class="vdp-empty-icon">🔍</div><div>Watching for VTT files.<br>Play the video and enable captions to trigger loading.</div></div>`;
      return;
    }

    for (const entry of foundVtts.values()) {
      const { url, filename, source, isHls, isBlob } = entry;
      const item = document.createElement("div");
      item.className = "vdp-item";

      const tagClass = isHls ? "hls" : isBlob ? "blob" : "";
      const tagLabel = isHls ? "HLS" : isBlob ? "Blob" : sourceLabel(source);
      const host = isBlob ? "in-page" : hostnameFromUrl(url);

      const info = document.createElement("div");
      info.className = "vdp-info";
      info.innerHTML = `
        <div class="vdp-name" title="${url}">${filename}</div>
        <div class="vdp-src"><span class="vdp-tag ${tagClass}">${tagLabel}</span>${host}</div>
      `;

      const btn = document.createElement("button");
      btn.className = "vdp-btn";
      btn.textContent = "Download";
      btn.addEventListener("click", () => triggerItemDownload(entry, btn));

      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    }
  }

  // ── Download logic ─────────────────────────────────────────────────────────

  function triggerItemDownload(entry, btn) {
    if (entry.isHls) {
      downloadHls(entry, btn);
    } else if (entry.isBlob) {
      downloadBlobVtt(entry, btn);
    } else {
      downloadDirect(entry.url, entry.filename, btn);
    }
  }

  function downloadDirect(url, filename, btn) {
    if (typeof GM_download !== "undefined") {
      GM_download({
        url,
        name: filename,
        onerror: () => fallbackDownload(url, filename),
      });
    } else {
      fallbackDownload(url, filename);
    }
    if (btn) { btn.textContent = "✓ Saved"; btn.classList.add("done"); }
  }

  function downloadBlobVtt(entry, btn) {
    const text = entry.blobText || blobVttStore.get(entry.url);
    if (!text) { if (btn) { btn.textContent = "✗ Expired"; btn.classList.add("err"); } return; }
    saveTextAsVtt(text, entry.filename, btn);
  }

  async function downloadHls(entry, btn) {
    if (btn) { btn.textContent = "⏳ Fetching…"; btn.classList.add("busy"); }
    try {
      let segments = entry.hlsSegments;

      // If we only have the playlist URL, fetch it first
      if (!segments) {
        const resp = await origFetch(entry.url);
        const text = await resp.text();
        const lines = text.split(/\r?\n/);
        segments = lines
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => resolveUrl(l, entry.url));
      }

      if (segments.length === 0) {
        // Maybe the URL itself is a plain VTT file
        const resp = await origFetch(entry.url);
        const text = await resp.text();
        if (text.trimStart().startsWith("WEBVTT")) {
          saveTextAsVtt(text, entry.filename, btn);
          return;
        }
        throw new Error("No segments found");
      }

      // Fetch all segments
      const parts = [];
      for (let i = 0; i < segments.length; i++) {
        if (btn) btn.textContent = `⏳ ${i + 1}/${segments.length}`;
        const r = await origFetch(segments[i]);
        parts.push(await r.text());
      }

      // Merge: keep header from first segment, strip it from rest
      const merged = parts.map((seg, i) => {
        const s = seg.trim();
        if (i === 0) return s;
        // Remove WEBVTT header line and optional X-TIMESTAMP-MAP line
        return s.replace(/^WEBVTT[^\r\n]*[\r\n]+(X-TIMESTAMP-MAP[^\r\n]*[\r\n]+)?[\r\n]*/i, "");
      }).join("\n\n");

      saveTextAsVtt(merged, entry.filename, btn);
    } catch (e) {
      console.error("[VTT Downloader] HLS merge failed:", e);
      if (btn) { btn.textContent = "✗ Failed"; btn.classList.remove("busy"); btn.classList.add("err"); }
    }
  }

  function saveTextAsVtt(text, filename, btn) {
    const blob = new Blob([text], { type: "text/vtt" });
    const url = origCreateObjectURL(blob);
    fallbackDownload(url, filename);
    setTimeout(() => origRevokeObjectURL(url), 5000);
    if (btn) { btn.textContent = "✓ Saved"; btn.classList.remove("busy"); btn.classList.add("done"); }
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
        blobVttStore.clear();
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
