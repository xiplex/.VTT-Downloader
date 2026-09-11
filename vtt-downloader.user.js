// ==UserScript==
// @name         VTT Downloader
// @namespace    https://github.com/xiplex/.vtt-downloader
// @version      1.37.0
// @description  Detect WebVTT subtitles on any page; on Crunchyroll, name files by episode (via its content API) and auto-download a whole season
// @author       xiplex
// @match        *://*/*
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

// ─────────────────────────────────────────────────────────────────────────────
// This script has two layers:
//   1. A SITE-AGNOSTIC detector — patches fetch/XHR/blob and scans the DOM to
//      find WebVTT subtitle files on any page (see "Network interception" and
//      "DOM scanning").
//   2. A CRUNCHYROLL layer built on top — English-[CC] filtering, HLS segment
//      merging, "Series_S01E01_Title" filename building, and a season
//      auto-downloader that walks episode → episode.
//
// The Crunchyroll layer works by reading the page (JSON-LD, the DOM) and driving
// its player UI, which makes it inherently fragile. Before "fixing" the metadata
// or navigation heuristics, read ARCHITECTURE.md — it documents the invariants
// that must NOT be reverted and why, so the same bugs stop recurring.
//
// Section map: Download history · URL helpers · English-[CC] filter · VTT store ·
// HLS parsing · Network interception · Episode metadata · Filename building ·
// DOM scanning · Styles · UI · Download logic · Season auto-download · Bootstrap.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  "use strict";

  // Use the page's real window so our patches affect the page's fetch / XHR.
  // With @grant directives Tampermonkey runs in an isolated context where
  // `window` is a wrapper — `unsafeWindow` is the actual page window.
  const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const isTopFrame = (() => { try { return window === window.top; } catch { return false; } })();

  // url -> { url, filename, source, isHls?, isBlob? }
  const foundVtts = new Map();
  // blob: url -> vtt text content (so we can re-download after page revokes it)
  const blobVttStore = new Map();
  // VTT segment URLs that belong to a known HLS subtitle playlist — these
  // shouldn't appear as separate entries since the playlist entry merges them all.
  const hlsSegmentUrls = new Set();

  let panelVisible = false;
  let panel = null;
  let fab = null;
  let uiReady = false;
  let metaCache = null;     // cached episode metadata for this page
  let metaCacheUrl = null;  // the URL the cache was extracted from (auto-invalidates on SPA nav)
  let seasonActive = false;
  let seasonStop = false;
  let seasonCount = 0;

  // ── Download history ───────────────────────────────────────────────────────
  // Persist which episodes have already been downloaded so repeat runs — and the
  // Season auto-downloader — can skip duplicates.  Stored via Tampermonkey so the
  // record survives page reloads and browser restarts.
  const DL_HISTORY_KEY = "vtt_downloaded_episodes";
  let downloadedEpisodes = new Set();
  try {
    if (typeof GM_getValue === "function") {
      const arr = JSON.parse(GM_getValue(DL_HISTORY_KEY, "[]"));
      if (Array.isArray(arr)) downloadedEpisodes = new Set(arr);
    }
  } catch {}

  function persistHistory() {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(DL_HISTORY_KEY, JSON.stringify([...downloadedEpisodes]));
      }
    } catch {}
  }

  // Stable per-episode identity = the episode PAGE url path (e.g.
  // "/watch/g7pu323xq/eternity"). It's unique per episode and updates instantly
  // on navigation, unlike metadata tags which lag a moment after an SPA jump and
  // could make a fresh episode look already-downloaded (causing skips).
  function episodeKey() {
    try { return "url:" + new URL(location.href).pathname.toLowerCase().replace(/\/+$/, ""); }
    catch { return "url:" + location.href; }
  }

  function isDownloaded(entry) {
    return downloadedEpisodes.has(episodeKey(entry));
  }

  function markDownloaded(keyOrEntry) {
    const key = typeof keyOrEntry === "string" ? keyOrEntry : episodeKey(keyOrEntry);
    if (key && !downloadedEpisodes.has(key)) {
      downloadedEpisodes.add(key);
      persistHistory();
      if (isTopFrame) updateUI();
    }
  }

  function clearHistory() {
    downloadedEpisodes.clear();
    persistHistory();
    if (isTopFrame) updateUI();
  }

  // Report a found VTT — bubble up from iframes to the top frame's UI
  function reportVtt(url, source, extra) {
    if (isTopFrame) {
      if (addVtt(url, source, extra)) updateUI();
    } else {
      try {
        window.top.postMessage({
          __vtt_downloader: true,
          type: "vtt_found",
          url, source,
          extra: extra && {
            isHls: !!extra.isHls,
            isBlob: !!extra.isBlob,
            filename: extra.filename,
            hlsLabel: extra.hlsLabel,
            hlsSegments: extra.hlsSegments,
          },
        }, "*");
      } catch {}
    }
  }

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

  // Strict filter — only accept tracks labeled as English [CC] (closed captions).
  // Matches: "English [CC]", "English (CC)", "English CC", "English Closed Captions",
  // "EN [CC]", etc. Rejects plain "English", "English (Dubs)", "Spanish", and so on.
  function isEnglishCC(label) {
    if (!label) return false;
    const l = String(label).toLowerCase();
    // Accept English language codes with or without a separator: en, eng,
    // english, en-us, en_us, en-gb, and the joined forms enus / engb.
    const isEnglish = /\benglish\b|\beng\b|\ben(?:us|gb)?\b|\ben[-_](?:us|gb)\b/.test(l);
    const hasCC = /\[\s*cc\s*\]|\(\s*cc\s*\)|\bcc\b|closed[\s-]*caption|\bsdh\b/.test(l);
    return isEnglish && hasCC;
  }

  // URL-only hint check for cases where no track label is available.
  // Crunchyroll's DASH CDN serves the closed-caption track at paths like
  //   /clean/captions/enus/<timestamp>/caption.vtt
  // — a language code with no separator ("enus"/"engb") inside a /captions/
  // folder — so recognise those alongside the older "en-us"/"[cc]" forms.
  function urlSuggestsEnglishCC(url) {
    if (!url) return false;
    try {
      const u = new URL(url, location.href);
      const path = (u.pathname + " " + u.search).toLowerCase();
      const isEnglish = /(^|[^a-z])en(?:g|us|gb|glish)?(?:[-_](?:us|gb))?([^a-z]|$)/.test(path);
      const hasCC = /(^|[^a-z])(cc|captions?|sdh)([^a-z]|$)/.test(path) || /\/captions?\//.test(path);
      return isEnglish && hasCC;
    } catch {
      return false;
    }
  }

  function sourceLabel(src) {
    return { network: "Network", track: "<track>", link: "<a>",
             script: "<script>", blob: "Blob", hls: "HLS", api: "API" }[src] || src;
  }

  // ── VTT store ──────────────────────────────────────────────────────────────

  function addVtt(url, source, extra) {
    const resolved = resolveUrl(url);
    if (!resolved || foundVtts.has(resolved)) return false;

    // Strict filter: only English [CC] tracks ever enter the panel.
    if (hlsSegmentUrls.has(resolved)) return false; // belongs to an HLS playlist entry
    const label = (extra && (extra.hlsLabel || extra.trackLabel)) || "";
    if (label) {
      if (!isEnglishCC(label)) return false;
    } else if (!urlSuggestsEnglishCC(resolved)) {
      return false;
    }

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
    while ((m = extMediaRe.exec(text)) !== null) {
      const attrs = parseM3U8Attrs(m[1]);
      if (attrs.TYPE !== "SUBTITLES" && attrs.TYPE !== "CLOSED-CAPTIONS") continue;
      if (!attrs.URI) continue;
      const trackUrl = resolveUrl(attrs.URI, fromUrl);
      const name = attrs.NAME || attrs.LANGUAGE || "Subtitles";
      const lang = attrs.LANGUAGE || "";
      // Only allow English [CC] tracks
      if (!isEnglishCC(`${name} ${lang}`)) continue;
      reportVtt(trackUrl, "hls", {
        filename: `${name}${lang ? "_" + lang : ""}.vtt`,
        isHls: true,
        hlsLabel: name,
      });
    }

    // Subtitle segment playlist — lines that aren't comments are segment URLs
    const lines = text.split(/\r?\n/);
    const segUrls = lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .filter((l) => { try { new URL(l, fromUrl); return true; } catch { return false; } })
      .map((l) => resolveUrl(l, fromUrl));

    if (segUrls.length > 0 && text.includes("EXTINF")) {
      // Remember segment URLs so they don't appear as separate entries, and
      // remove any that may have already slipped in via earlier network detection.
      let removedAny = false;
      for (const seg of segUrls) {
        hlsSegmentUrls.add(seg);
        if (foundVtts.delete(seg)) removedAny = true;
      }
      if (removedAny && isTopFrame) updateUI();

      // Only register the playlist itself when its URL hints that it's English [CC]
      // (so non-English subtitle playlists don't sneak in via this path).
      if (urlSuggestsEnglishCC(fromUrl)) {
        reportVtt(fromUrl, "hls", {
          isHls: true,
          hlsSegments: segUrls,
          filename: filenameFromUrl(fromUrl, "subtitles.vtt"),
          hlsLabel: "English [CC]",
        });
      }
    }

    return true;
  }

  // ── Response body inspection ───────────────────────────────────────────────

  function inspectBody(text, finalUrl) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("WEBVTT")) {
      reportVtt(finalUrl, "network");
      return;
    }
    if (trimmed.startsWith("#EXTM3U")) {
      processM3U8Body(text, finalUrl);
      return;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const scanObj = (obj, depth) => {
          if (depth > 6 || !obj || typeof obj !== "object") return;
          for (const val of Object.values(obj)) {
            if (typeof val === "string" && isVttUrl(val)) {
              reportVtt(val, "api");
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

  // Patch the PAGE'S fetch via unsafeWindow so we actually catch real requests.
  const origFetch = pageWin.fetch.bind(pageWin);
  pageWin.fetch = function (input, init) {
    let url = "";
    try { url = typeof input === "string" ? input : (input && input.url) || ""; } catch {}
    if (url && isVttUrl(url)) reportVtt(url, "network");
    // Piggyback on Crunchyroll's own authorized requests to capture its bearer
    // token (see "Crunchyroll API"), so we can call the content API ourselves.
    try { captureAuth(init && init.headers); } catch {}
    try { if (input && typeof input === "object" && input.headers) captureAuth(input.headers); } catch {}

    const promise = origFetch(input, init);

    if (url) {
      promise.then((response) => {
        try {
          const ct = response.headers.get("content-type") || "";
          const cl = response.headers.get("content-length") || "";
          const finalUrl = response.url || url;

          if (isVttContentType(ct)) { reportVtt(finalUrl, "network"); return; }
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

  // Patch the PAGE's XMLHttpRequest
  const OrigXHR = pageWin.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let pendingUrl = null;

    const origOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      pendingUrl = url;
      if (isVttUrl(url)) reportVtt(url, "network");
      return origOpen.call(xhr, method, url, ...rest);
    };

    // Capture the bearer token from the app's authorized XHRs (see "Crunchyroll API").
    const origSetHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (name, value) {
      try { if (/^authorization$/i.test(name)) captureAuth([[name, value]]); } catch {}
      return origSetHeader.call(xhr, name, value);
    };

    xhr.addEventListener("load", function () {
      if (!pendingUrl) return;
      const ct = xhr.getResponseHeader && xhr.getResponseHeader("content-type") || "";
      const cl = xhr.getResponseHeader && xhr.getResponseHeader("content-length") || "";
      const finalUrl = xhr.responseURL || pendingUrl;

      if (isVttContentType(ct)) { reportVtt(finalUrl, "network"); return; }
      if (isHlsContentType(ct)) {
        const t = xhr.responseText;
        if (t) processM3U8Body(t, finalUrl);
        return;
      }
      if (shouldInspectBody(ct, cl)) {
        const t = (xhr.responseType === "" || xhr.responseType === "text")
          ? xhr.responseText
          : null;
        if (t) inspectBody(t, finalUrl);
      }
    });

    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  try { pageWin.XMLHttpRequest = PatchedXHR; } catch {}

  // Intercept blob: URLs created from VTT content (e.g. ASS→VTT conversion).
  // Patch the page's URL constructor methods.
  const origCreateObjectURL = pageWin.URL.createObjectURL.bind(pageWin.URL);
  pageWin.URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL(obj);
    try {
      if (obj && obj.size != null && obj.size < 524288 && typeof obj.text === "function") {
        obj.text().then((text) => {
          if (text && text.trimStart().startsWith("WEBVTT")) {
            blobVttStore.set(blobUrl, text);
            reportVtt(blobUrl, "blob", { isBlob: true, blobText: text });
          }
        }).catch(() => {});
      }
    } catch {}
    return blobUrl;
  };

  // Keep a reference to the original revoke so we can clean up our OWN blob URLs
  // (see saveTextAsVtt). We deliberately don't patch revokeObjectURL: the page
  // revokes its blobs normally, and we retain the text in blobVttStore anyway.
  const origRevokeObjectURL = pageWin.URL.revokeObjectURL.bind(pageWin.URL);

  // ── Crunchyroll API ─────────────────────────────────────────────────────────
  // Instead of scraping the rendered page (fragile) or clicking through the SPA
  // player (fragile), talk to the same content API the web app uses. We never
  // handle a login: we PIGGYBACK on the bearer token the app already sends with
  // its own requests (captured in the fetch/XHR patches above) and reuse it for
  // same-origin API calls. Everything here is best-effort — if the token or an
  // endpoint is unavailable, callers fall back to the page-scraping path. Verbose
  // logging (`[VTT CR-API]`) makes a real Crunchyroll test session diagnosable.
  const CR = {
    token: null,            // "Bearer …" captured from the app's own requests
    metaByPath: new Map(),  // episode path → { series, season, episode, title }
  };
  const crLog = (...a) => { try { console.log("[VTT CR-API]", ...a); } catch {} };
  const isCrunchyroll = /(^|\.)crunchyroll\.com$/i.test(location.hostname);

  function captureAuth(headers) {
    if (!headers) return;
    let auth = null;
    try {
      if (typeof headers.get === "function") auth = headers.get("authorization");
      else if (Array.isArray(headers)) { for (const [k, v] of headers) if (/^authorization$/i.test(k)) auth = v; }
      else if (typeof headers === "object") { for (const k of Object.keys(headers)) if (/^authorization$/i.test(k)) auth = headers[k]; }
    } catch {}
    if (auth && /^bearer\s+\S/i.test(auth) && auth !== CR.token) {
      const first = !CR.token;
      CR.token = auth;
      crLog("captured bearer token", first ? "(first)" : "(refreshed)");
      // The first time we see a token, prime metadata for the current episode so
      // the panel shows a proper filename without the user starting a season run.
      if (first) refreshCrMeta();
    }
  }

  function crEpisodeIdFromUrl(u) {
    try { const m = new URL(u || location.href, location.href).pathname.match(/\/watch\/([^/?#]+)/i); return m ? m[1] : null; }
    catch { return null; }
  }

  function crPathKey(u) {
    try { return new URL(u || location.href, location.href).pathname.toLowerCase().replace(/\/+$/, ""); }
    catch { return (u || location.href).toLowerCase(); }
  }

  async function crApi(path) {
    if (!CR.token) throw new Error("no-token");
    const url = path.startsWith("http") ? path : "https://www.crunchyroll.com" + path;
    const resp = await fetch(url, {
      headers: { authorization: CR.token },
      credentials: "include",
    });
    if (!resp.ok) throw new Error("http-" + resp.status);
    return resp.json();
  }

  // Normalize one API episode record into our metadata shape.
  function crToMeta(rec) {
    const em = rec.episode_metadata || rec;
    const series  = (em.series_title || "").trim();
    const season  = parseInt(em.season_number, 10) || 1;
    const episode = parseInt(em.episode_number != null ? em.episode_number : em.sequence_number, 10) || 1;
    const title   = (rec.title || em.title || "").trim();
    if (!series) return null;
    return { series, season, episode, title: title || `Episode ${String(episode).padStart(2, "0")}` };
  }

  // Fetch clean metadata for one episode id via /content/v2/cms/objects/{id}.
  async function crGetEpisode(id) {
    const j = await crApi(`/content/v2/cms/objects/${id}?ratings=false&locale=en-US`);
    const rec = j && j.data && j.data[0];
    if (!rec) return null;
    const meta = crToMeta(rec);
    return meta && { ...meta, id, seasonId: (rec.episode_metadata || {}).season_id };
  }

  // Fetch the ORDERED episode list for a season → the deterministic season queue.
  async function crSeasonEpisodes(seasonId) {
    const j = await crApi(`/content/v2/cms/seasons/${seasonId}/episodes?locale=en-US`);
    const rows = (j && j.data) || [];
    return rows.map((e) => {
      const meta = crToMeta(e) || {};
      // Capture the episode number even for rows that lack series_title (meta null),
      // so ordering/labels survive; buildCrSeasonPlan fills series/season from `cur`.
      const episode = meta.episode || parseInt(e.episode_number != null ? e.episode_number : e.sequence_number, 10) || null;
      return {
        id: e.id,
        slug: e.slug_title || "",
        url: `https://www.crunchyroll.com/watch/${e.id}/${e.slug_title || ""}`,
        series: meta.series || "", season: meta.season || null, episode, title: meta.title || "",
      };
    }).filter((e) => e.id);
  }

  // Populate CR.metaByPath for the CURRENT episode so buildFilename can use it.
  // Safe to call anytime; no-ops without a token or outside a /watch/ page.
  async function refreshCrMeta() {
    const id = crEpisodeIdFromUrl();
    if (!isCrunchyroll || !id || !CR.token) return null;
    try {
      const ep = await crGetEpisode(id);
      if (ep) {
        CR.metaByPath.set(crPathKey(), { series: ep.series, season: ep.season, episode: ep.episode, title: ep.title });
        crLog("metadata", `${ep.series} S${ep.season}E${ep.episode} — ${ep.title}`);
        if (isTopFrame) updateUI();
        return ep;
      }
    } catch (e) { crLog("refreshCrMeta failed:", e.message || e); }
    return null;
  }

  // ── DOM scanning ───────────────────────────────────────────────────────────

  // ── Episode metadata & filename formatting ─────────────────────────────────

  function pathsMatch(a, b) {
    try { return new URL(a, location.href).pathname === new URL(b, location.href).pathname; }
    catch { return false; }
  }

  // Strip any leading noise from a raw episode title string so only the actual
  // episode name remains.  Handles two kinds of prefix:
  //   • Series name prefix  → "Chainsaw Man – Dog & Chainsaw" → "Dog & Chainsaw"
  //   • Episode number prefix → "E1 – Title", "Season 1 E1 – Title" → "Title"
  function cleanEpisodeTitle(raw, series) {
    if (!raw) return "";
    let t = raw.trim();

    // "DAN DA DAN Season 2 (English Dub) | E23 - Hey, it's a Kaiju"
    // The title lives after the pipe + episode marker.
    const pipeM = t.match(/\|\s*Ep?\.?\s*\d+\s*[-–]\s*(.+)$/i);
    if (pipeM) return pipeM[1].trim();

    // Strip series-name prefix (e.g. "Chainsaw Man – Dog & Chainsaw" → "Dog & Chainsaw")
    if (series) {
      const esc = series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp(`^${esc}\\s*[-–:,]\\s*`, "i"), "").trim();
    }
    // Iteratively strip season/episode number prefixes
    let prev;
    do {
      prev = t;
      t = t
        .replace(/^Season\s+\d+(?:\s+Part\s+\d+)?\s*[-–:|]?\s*/i, "")
        .replace(/^Part\s+\d+\s*[-–:|]?\s*/i, "")
        .replace(/^S\d+\s*E\d+\s*[-–:|]\s*/i, "")
        .replace(/^Ep?\.?\s*\d+\s*[-–:|]\s*/i, "")
        .trim();
    } while (t !== prev && t.length > 0);
    return t || raw.trim();
  }

  // Strip streaming/release qualifiers that Crunchyroll appends to series names
  // so they don't bleed into the filename.
  // e.g. "DAN DA DAN (English Dub)" → "DAN DA DAN"
  //      "Chainsaw Man Season 2 (Uncensored)" → "Chainsaw Man"
  function cleanSeriesName(s) {
    return (s || "")
      .replace(/\s*\(\s*(?:English\s+)?(?:Dub(?:bed)?|Sub(?:titled)?|Uncensored|Censored|Audio)\s*\)/gi, "")
      .replace(/\s*\bSeason\s+\d+\b.*/i, "")
      .trim();
  }

  // FALLBACK ONLY (see getEpisodeMetadata source 4). Parse a human-readable
  // og:title / document.title string into episode metadata. This is fragile by
  // nature — Crunchyroll uses several title layouts and adds new ones — so it runs
  // only after the structured sources fail. Covers the formats seen so far:
  //   "Watch Series Season 2 Episode 5 – Title | Crunchyroll"
  //   "Watch Series Episode 5 – Title | Crunchyroll"
  //   "Watch Series – E5 – Title | Crunchyroll"   (short format)
  //   "Watch Series - S1E5 – Title | Crunchyroll"
  //   "DAN DA DAN Season 2 (English Dub) | E23 - Title"   (pipe format)
  function parseTitleString(raw) {
    const base = raw.replace(/^Watch\s+/i, "").trim();

    // "DAN DA DAN Season 2 (English Dub) | E23 - Hey, it's a Kaiju"
    // Must be checked BEFORE the generic pipe-strip below eats the episode info.
    let m = base.match(/^(.+?)\s*\|\s*Ep?\.?\s*(\d+)\s*[-–]\s*(.+?)(?:\s*\|.*)?$/i);
    if (m) {
      const seriesFull = m[1].trim();
      const seasonM    = seriesFull.match(/\bSeason\s+(\d+)\b/i);
      const series     = cleanSeriesName(seriesFull);
      const title      = m[3].trim();
      if (series && title && title.toLowerCase() !== series.toLowerCase()) {
        return { series, season: seasonM ? +seasonM[1] : 1, episode: +m[2], title };
      }
    }

    // Strip site suffix, "Watch" prefix, and noise for remaining patterns
    const s = base
      .replace(/\s*\|\s*[^|]+$/, "")              // drop "| Crunchyroll"
      .replace(/\s*-\s*Watch\s+on\s+\S+\s*$/i, "") // drop "- Watch on Crunchyroll"
      .replace(/\s+Online\s*$/i, "")
      .trim();
    if (!s) return null;

    // "Series Season 2 Episode 5 – Title"
    m = s.match(/^(.+?)\s+Season\s+(\d+)\s+Episode\s+(\d+)\s*[-–:]\s*(.+)$/i);
    if (m) return { series: m[1].trim(), season: +m[2], episode: +m[3], title: m[4].trim() };

    // "Series Episode 5 – Title"
    m = s.match(/^(.+?)\s+Episode\s+(\d+)\s*[-–:]\s*(.+)$/i);
    if (m) return { series: m[1].trim(), season: 1, episode: +m[2], title: m[3].trim() };

    // "Series – E5 – Title"  or  "Series - Ep5 - Title"
    m = s.match(/^(.+?)\s*[-–]\s*Ep?\.?\s*(\d+)\s*[-–:]\s*(.+)$/i);
    if (m) return { series: m[1].trim(), season: 1, episode: +m[2], title: m[3].trim() };

    // "Series - S1E5 – Title"
    m = s.match(/^(.+?)\s*[-–]\s*S(\d+)E(\d+)\s*[-–:]\s*(.+)$/i);
    if (m) return { series: m[1].trim(), season: +m[2], episode: +m[3], title: m[4].trim() };

    return null;
  }

  // Extract episode metadata for the current page, most reliable source first.
  //
  // DESIGN PRINCIPLE — prefer STRUCTURED data over parsing human-readable text.
  // Crunchyroll embeds the answer as JSON-LD (machine-readable series/season/
  // episode/title); the URL slug is likewise machine-generated. Those are stable.
  // Parsing og:title / document.title strings is fragile — every new show's title
  // format has historically broken it — so those parsers are the LAST resort here,
  // not the first. Do not reorder them earlier without reading ARCHITECTURE.md;
  // that ordering is the fix for the recurring filename bugs, not an accident.
  function getEpisodeMetadata() {
    if (metaCache && metaCacheUrl !== location.href) { metaCache = null; metaCacheUrl = null; }
    if (metaCache) return metaCache;

    const here = location.href;
    const differsFromSeries = (title, series) =>
      !!title && title.trim().toLowerCase() !== series.trim().toLowerCase();
    const remember = (meta) => { metaCache = meta; metaCacheUrl = here; return meta; };

    // ── Source 0 (authoritative): Crunchyroll API metadata ────────────────────
    // Populated by refreshCrMeta() from the content API. When present it's the
    // ground truth (never scraped), so it beats every page-derived source below.
    const apiMeta = CR.metaByPath.get(crPathKey(here));
    if (apiMeta && apiMeta.series) return remember({ ...apiMeta });

    // ── Source 1 (structured): JSON-LD TVEpisode ──────────────────────────────
    // Gives series / season / episode directly. When its own title field is
    // usable we're done; otherwise keep the numbers as `ldBase` for sources 2–4.
    let ldBase = null; // { series, season, episode } when the title was unusable
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const root = JSON.parse(el.textContent);
        for (const node of [].concat(root?.["@graph"] || root)) {
          if (!node || !/TVEpisode|Episode/i.test(node["@type"] || "")) continue;
          const series = (node.partOfSeries?.name || node.partOfTVSeries?.name || "").trim();
          if (!series) continue;
          const ldUrl = (node.url || "").trim();
          if (ldUrl && !pathsMatch(ldUrl, here)) continue; // belongs to another episode
          const episode = parseInt(node.episodeNumber, 10) || 1;
          const season  = parseInt(node.partOfSeason?.seasonNumber, 10) || 1;
          const title   = cleanEpisodeTitle((node.name || "").trim(), series);
          if (differsFromSeries(title, series)) return remember({ series, season, episode, title });
          if (!ldBase) ldBase = { series, season, episode }; // title bad, numbers still good
        }
      } catch {}
    }

    // ── Source 1b (structured): JSON-LD VideoObject ───────────────────────────
    // A second JSON-LD block whose "name" is the clean episode title (no series
    // prefix, no ep#) — rescues cases where TVEpisode.name duplicated the series.
    if (ldBase) {
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const root = JSON.parse(el.textContent);
          if (root["@type"] === "VideoObject" && root.name) {
            const title = root.name.trim();
            if (differsFromSeries(title, ldBase.series)) return remember({ ...ldBase, title });
          }
        } catch {}
      }
    }

    // ── Source 2 (structured): URL slug for the title ─────────────────────────
    // The slug in /watch/<id>/<slug> is machine-generated and stable. Normalize to
    // lowercase alphanumeric so "DAN DA DAN" == "dan-da-dan" (i.e. it's not just
    // the series name repeated).
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const slugM = location.pathname.match(/\/watch\/[^/]+\/([^/?#]+)/i);
    if (slugM) {
      const slug = slugM[1];
      const series = ldBase?.series || cleanSeriesName(
        (document.querySelector('meta[property="og:title"]')?.content || document.title || "")
          .replace(/\s*\|\s*[^|]+$/, "").replace(/^Watch\s+/i, "").replace(/\s*[-–].*$/, "").trim()
      );
      if (series && norm(slug) !== norm(series)) {
        const title = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        if (differsFromSeries(title, series)) {
          return remember({ series, season: ldBase?.season || 1,
                            episode: ldBase?.episode || 1, title });
        }
      }
    }

    // ── Source 3 (semi-structured): on-screen episode heading ─────────────────
    // The title is rendered as "E1 – That's How Love Starts…". Anchor the search
    // to the JSON-LD episode number so we don't grab a sidebar entry for a
    // different episode.
    if (ldBase) {
      try {
        const pageText = document.body?.innerText || "";
        const n = ldBase.episode;
        for (const pat of [
          new RegExp(`(?:^|\\n)\\s*E0*${n}\\s*[-–]\\s*(.{3,100})(?=\\r?\\n|$)`, "im"),
          new RegExp(`(?:^|\\n)\\s*Episode\\s+0*${n}\\s*[-–:]\\s*(.{3,100})(?=\\r?\\n|$)`, "im"),
        ]) {
          const m = pageText.match(pat);
          if (m && differsFromSeries(m[1].trim(), ldBase.series)) {
            return remember({ ...ldBase, title: m[1].trim() });
          }
        }
      } catch {}
    }

    // ── Source 4 (fragile, LAST RESORT): parse human-readable title strings ────
    // Only reached when every structured source above came up empty. These
    // regexes are the historical source of the recurring naming bugs — keep them
    // last so a structured answer always wins.
    for (const raw of [
      document.querySelector('meta[property="og:title"]')?.content || "",
      document.querySelector('meta[name="twitter:title"]')?.content || "",
      document.title,
    ]) {
      const m = parseTitleString(raw);
      if (m && differsFromSeries(m.title, m.series)) return remember(m);
    }
    const desc = (document.querySelector('meta[name="description"]')?.content || "").trim();
    for (const pat of [
      /Watch\s+(.+?)\s+Episode\s+(\d+)[,\s–\-]+(.+?)\s+on\s+Crunchyroll/i,
      /Watch\s+(.+?)\s*[-–]\s*Ep?\.?\s*(\d+)\s*[-–:]\s*(.+?)\s+on\s+Crunchyroll/i,
    ]) {
      const m = desc.match(pat);
      if (m && differsFromSeries(m[3], m[1])) {
        return remember({ series: m[1].trim(), season: 1, episode: +m[2], title: m[3].trim() });
      }
    }

    console.debug(
      "[VTT Downloader] metadata extraction failed\n",
      " og:title:", document.querySelector('meta[property="og:title"]')?.content, "\n",
      " doc title:", document.title, "\n",
      " description:", (document.querySelector('meta[name="description"]')?.content || "").slice(0, 200),
      "\n ldBase:", ldBase,
    );
    return null;
  }

  function sanitizeName(str) {
    return (str || "").replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  }

  // Build the download filename strictly following the target format:
  //   Chainsaw Man_S01E01_DOG & CHAINSAW - English [CC].vtt
  function buildFilename(entry) {
    const meta = getEpisodeMetadata();
    const lang = sanitizeName(entry.hlsLabel || entry.trackLabel || "English [CC]");

    if (meta) {
      const series  = sanitizeName(meta.series);
      const season  = String(meta.season  || 1).padStart(2, "0");
      const episode = String(meta.episode || 1).padStart(2, "0");
      const title   = sanitizeName(meta.title);
      return `${series}_S${season}E${episode}_${title} - ${lang}.vtt`;
    }

    // Last resort: raw server filename + language label
    const base = (entry.filename || "subtitles").replace(/\.vtt$/i, "");
    return `${sanitizeName(base)} - ${lang}.vtt`;
  }

  function scanDOM() {
    document.querySelectorAll("track[src]").forEach((el) => {
      const url = el.src || el.getAttribute("src");
      const trackLabel = el.label || el.getAttribute("label") || "";
      const trackLang  = el.srclang || el.getAttribute("srclang") || "";
      const trackKind  = el.kind || el.getAttribute("kind") || "";
      // Only allow English [CC] — match label, or "captions" kind + English srclang
      const labelMatch = isEnglishCC(`${trackLabel} ${trackLang}`);
      const kindMatch  = trackKind === "captions" && /^en(?:g|us|gb|glish|[-_])?/i.test(trackLang);
      if (!labelMatch && !kindMatch) return;
      if (url && isVttUrl(url)) reportVtt(url, "track", { trackLabel: trackLabel || "English [CC]" });
    });
    document.querySelectorAll("source[src]").forEach((el) => {
      const url = el.src || el.getAttribute("src");
      if (url && isVttUrl(url)) reportVtt(url, "track");
    });
    document.querySelectorAll("a[href]").forEach((el) => {
      const url = el.getAttribute("href");
      if (url && isVttUrl(url)) reportVtt(url, "link");
    });
    document.querySelectorAll("script:not([src])").forEach((el) => {
      const matches = (el.textContent || "").match(/https?:\/\/[^\s"'<>]+\.vtt[^\s"'<>]*/gi) || [];
      for (const raw of matches) {
        reportVtt(raw.replace(/[,;)\]}>]+$/, ""), "script");
      }
    });
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
    .vdp-tag.done { background: #14321f !important; color: #4ade80 !important; margin-right: 4px !important; }
    .vdp-clearlink { cursor: pointer !important; text-decoration: underline !important; color: #a5b4fc !important; }
    .vdp-clearlink:hover { color: #c7d2fe !important; }

    .vdp-btn { all: initial !important; border: 1px solid #2563eb !important; color: #2563eb !important; border-radius: 5px !important; padding: 4px 9px !important; font-size: 10px !important; font-weight: 600 !important; cursor: pointer !important; white-space: nowrap !important; flex-shrink: 0 !important; font-family: inherit !important; transition: background 0.1s !important; }
    .vdp-btn:hover { background: #2563eb !important; color: #fff !important; }
    .vdp-btn.done { border-color: #22c55e !important; color: #22c55e !important; }
    .vdp-btn.busy { border-color: #f59e0b !important; color: #f59e0b !important; cursor: default !important; }
    .vdp-btn.err  { border-color: #ef4444 !important; color: #ef4444 !important; }

    .vdp-dl-season { all: initial !important; background: transparent !important; border: 1px solid #a855f7 !important; color: #a855f7 !important; border-radius: 6px !important; padding: 4px 9px !important; font-size: 11px !important; font-weight: 600 !important; cursor: pointer !important; font-family: inherit !important; margin-right: 6px !important; transition: background 0.1s !important; }
    .vdp-dl-season:hover:not(:disabled) { background: #a855f7 !important; color: #fff !important; }
    .vdp-dl-season:disabled { opacity: 0.4 !important; cursor: default !important; }
    .vdp-dl-season.active { background: #a855f7 !important; color: #fff !important; }

    .vdp-banner { padding: 7px 14px !important; background: #1e1b4b !important; border-bottom: 1px solid #4338ca !important; font-size: 11px !important; color: #c7d2fe !important; display: none !important; }
    .vdp-banner.visible { display: block !important; }
    .vdp-banner b { color: #fff !important; }
    .vdp-banner.success { background: #052e16 !important; border-bottom-color: #16a34a !important; color: #bbf7d0 !important; font-weight: 600 !important; }
    .vdp-banner.success b { color: #fff !important; }
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
        <div>
          <button class="vdp-dl-season" id="vtt-dl-season" disabled title="Download every episode in this season automatically">Season ▶</button>
          <button class="vdp-dl-all" id="vtt-dl-all" disabled>Download All</button>
        </div>
      </div>
      <div class="vdp-banner" id="vtt-dl-banner"></div>
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

    document.getElementById("vtt-dl-season").addEventListener("click", toggleSeasonDownload);

    // Delegated: the "clear history" link is re-rendered on each updateUI().
    panel.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.id === "vtt-dl-clear") {
        const n = downloadedEpisodes.size;
        if (confirm(`Forget the record of ${n} already-downloaded episode${n !== 1 ? "s" : ""}?\n\nThey can then be downloaded again.`)) {
          clearHistory();
        }
      }
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
    if (countEl) {
      const base = count > 0 ? `${count} VTT file${count !== 1 ? "s" : ""} found` : "No VTT files yet";
      const hist = downloadedEpisodes.size;
      countEl.innerHTML = base + (hist
        ? ` · <span id="vtt-dl-clear" class="vdp-clearlink" title="Forget the record of episodes already downloaded">history: ${hist} ✕</span>`
        : "");
    }
    if (dlAll)   dlAll.disabled = count === 0;
    const dlSeason = document.getElementById("vtt-dl-season");
    if (dlSeason) {
      dlSeason.disabled = count === 0 && !seasonActive;
      dlSeason.classList.toggle("active", seasonActive);
      dlSeason.textContent = seasonActive ? "Stop ⏹" : "Season ▶";
    }

    const list = document.getElementById("vtt-dl-list");
    if (!list) return;
    list.innerHTML = "";

    if (count === 0) {
      list.innerHTML = `<div class="vdp-empty"><div class="vdp-empty-icon">🔍</div><div>Watching for VTT files.<br>Play the video and enable captions to trigger loading.</div></div>`;
      return;
    }

    for (const entry of foundVtts.values()) {
      const { url, source, isHls, isBlob } = entry;
      const displayName = buildFilename(entry);
      const done = isDownloaded(entry);
      const item = document.createElement("div");
      item.className = "vdp-item";

      const tagClass = isHls ? "hls" : isBlob ? "blob" : "";
      const tagLabel = isHls ? "HLS" : isBlob ? "Blob" : sourceLabel(source);
      const host = isBlob ? "in-page" : hostnameFromUrl(url);

      const info = document.createElement("div");
      info.className = "vdp-info";
      info.innerHTML = `
        <div class="vdp-name" title="${url}">${displayName}</div>
        <div class="vdp-src"><span class="vdp-tag ${tagClass}">${tagLabel}</span>${done ? '<span class="vdp-tag done">✓ downloaded</span>' : ""}${host}</div>
      `;

      const btn = document.createElement("button");
      btn.className = "vdp-btn" + (done ? " done" : "");
      btn.textContent = done ? "Re-download" : "Download";
      btn.addEventListener("click", () => triggerItemDownload(entry, btn));

      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    }
  }

  // ── Download logic ─────────────────────────────────────────────────────────

  function triggerItemDownload(entry, btn) {
    // Build the formatted filename at click time so page metadata is fully loaded
    const filename = buildFilename(entry);
    const onDone = () => markDownloaded(entry);
    if (entry.isHls) {
      downloadHls({ ...entry, filename }, btn, onDone);
    } else if (entry.isBlob) {
      downloadBlobVtt({ ...entry, filename }, btn, onDone);
    } else {
      downloadDirect(entry.url, filename, btn, onDone);
    }
  }

  // Cross-origin URLs make browsers ignore the anchor `download` attribute,
  // so we fetch the VTT body and re-save it as a same-origin blob — that way
  // our chosen filename is actually honored.
  async function downloadDirect(url, filename, btn, onDone) {
    if (btn) { btn.textContent = "⏳ Fetching…"; btn.classList.add("busy"); }

    // 1. Try regular fetch (works if the page already has CORS access)
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (resp.status === 429) throw new Error("Rate limited (429) — wait a moment before continuing");
      if (resp.ok) {
        const text = await resp.text();
        saveTextAsVtt(text, filename, btn, onDone);
        return;
      }
    } catch (e) {
      if (e.message && e.message.includes("429")) throw e; // propagate to season loop
    }

    // 2. Try GM_xmlhttpRequest — privileged context bypasses CORS
    if (typeof GM_xmlhttpRequest !== "undefined") {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 300 && resp.responseText) {
            saveTextAsVtt(resp.responseText, filename, btn, onDone);
          } else {
            tryGmDownload(url, filename, btn, onDone);
          }
        },
        onerror: () => tryGmDownload(url, filename, btn, onDone),
      });
      return;
    }

    // 3. Last resort
    tryGmDownload(url, filename, btn, onDone);
  }

  function tryGmDownload(url, filename, btn, onDone) {
    if (typeof GM_download !== "undefined") {
      GM_download({
        url,
        name: filename,
        onload: () => { if (btn) { btn.textContent = "✓ Saved"; btn.classList.remove("busy"); btn.classList.add("done"); } if (onDone) onDone(); },
        onerror: () => fallbackDownload(url, filename, btn, onDone),
      });
    } else {
      fallbackDownload(url, filename, btn, onDone);
    }
  }

  function downloadBlobVtt(entry, btn, onDone) {
    const text = entry.blobText || blobVttStore.get(entry.url);
    if (!text) { if (btn) { btn.textContent = "✗ Expired"; btn.classList.add("err"); } return; }
    saveTextAsVtt(text, entry.filename, btn, onDone);
  }

  async function downloadHls(entry, btn, onDone) {
    if (btn) { btn.textContent = "⏳ Fetching…"; btn.classList.add("busy"); }
    try {
      let segments = entry.hlsSegments;

      // If we only have the playlist URL, fetch it first
      if (!segments) {
        const resp = await fetch(entry.url);
        const text = await resp.text();
        const lines = text.split(/\r?\n/);
        segments = lines
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => resolveUrl(l, entry.url));
      }

      if (segments.length === 0) {
        // Maybe the URL itself is a plain VTT file
        const resp = await fetch(entry.url);
        const text = await resp.text();
        if (text.trimStart().startsWith("WEBVTT")) {
          saveTextAsVtt(text, entry.filename, btn, onDone);
          return;
        }
        throw new Error("No segments found");
      }

      // Fetch all segments
      const parts = [];
      for (let i = 0; i < segments.length; i++) {
        if (btn) btn.textContent = `⏳ ${i + 1}/${segments.length}`;
        const r = await fetch(segments[i]);
        parts.push(await r.text());
      }

      // Merge: keep header from first segment, strip it from rest
      const merged = parts.map((seg, i) => {
        const s = seg.trim();
        if (i === 0) return s;
        // Remove WEBVTT header line and optional X-TIMESTAMP-MAP line
        return s.replace(/^WEBVTT[^\r\n]*[\r\n]+(X-TIMESTAMP-MAP[^\r\n]*[\r\n]+)?[\r\n]*/i, "");
      }).join("\n\n");

      saveTextAsVtt(merged, entry.filename, btn, onDone);
    } catch (e) {
      console.error("[VTT Downloader] HLS merge failed:", e);
      if (btn) { btn.textContent = "✗ Failed"; btn.classList.remove("busy"); btn.classList.add("err"); }
    }
  }

  function saveTextAsVtt(text, filename, btn, onDone) {
    const blob = new Blob([text], { type: "text/vtt" });
    const url = origCreateObjectURL(blob);
    fallbackDownload(url, filename);
    setTimeout(() => origRevokeObjectURL(url), 5000);
    if (btn) { btn.textContent = "✓ Saved"; btn.classList.remove("busy"); btn.classList.add("done"); }
    if (onDone) onDone();
  }

  function fallbackDownload(url, filename, btn, onDone) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.cssText = "display:none!important";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (btn) { btn.textContent = "✓ Saved"; btn.classList.remove("busy"); btn.classList.add("done"); }
    if (onDone) onDone();
  }

  // ── Season auto-download ───────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setBanner(html, type) {
    const b = document.getElementById("vtt-dl-banner");
    if (!b) return;
    if (!html) { b.classList.remove("visible", "success"); b.innerHTML = ""; return; }
    b.innerHTML = html;
    b.classList.add("visible");
    b.classList.toggle("success", type === "success");
  }

  // Pick the "best" VTT entry: prefer English [CC], then English, then any HLS, then first.
  function pickPreferredEntry(entries, preferLabel) {
    if (entries.length === 0) return null;
    const lc = (preferLabel || "").toLowerCase();
    if (preferLabel) {
      const exact = entries.find((e) => (e.hlsLabel || e.trackLabel || "").toLowerCase() === lc);
      if (exact) return exact;
      const partial = entries.find((e) => (e.hlsLabel || e.trackLabel || "").toLowerCase().includes(lc));
      if (partial) return partial;
    }
    return (
      entries.find((e) => /english.*\[cc\]/i.test(e.hlsLabel || e.trackLabel || "")) ||
      entries.find((e) => /english/i.test(e.hlsLabel || e.trackLabel || "")) ||
      entries.find((e) => e.isHls) ||
      entries[0]
    );
  }

  // Does this element look like a "previous episode" control? We must never click
  // one — it navigates backward, which the loop then mistakes for end-of-season.
  function looksLikePrevious(el) {
    if (!el) return false;
    const s = [
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("data-testid"),
      el.getAttribute && el.getAttribute("data-t"),
      el.getAttribute && el.getAttribute("title"),
      el.className && el.className.toString(),
    ].filter(Boolean).join(" ").toLowerCase();
    return /\bprev\b|previous|\bback\b/.test(s);
  }

  // Find Crunchyroll's "next episode" control, never a "previous" one.
  // (Confirmed markup: <button data-testid="next-episode-button" aria-label=
  // "Next Episode"> in the player, plus an <a>"Next Episode" card link.)
  function findNextEpisodeTarget() {
    // Most reliable: the player's dedicated Next Episode button. Return it even
    // when it looks "hidden" (offsetParent null while the controls overlay is
    // collapsed) — it's still the correct control to click.
    const strong = [
      'button[data-testid="next-episode-button"]',
      '[data-testid="next-episode-button"]',
      'button[aria-label="Next Episode" i]',
      'a[aria-label^="Next Episode" i]',
      '[data-testid="skip-to-next-episode-button"]',
    ];
    for (const sel of strong) {
      for (const el of document.querySelectorAll(sel)) {
        if (!looksLikePrevious(el)) return el;
      }
    }
    // The "Next Episode" card link — its visible text is exactly "Next Episode"
    // (the sibling "Previous Episode" card is excluded by the exact match).
    for (const a of document.querySelectorAll('a[href*="/watch/"]')) {
      if ((a.textContent || "").trim().toLowerCase() === "next episode" && !looksLikePrevious(a)) return a;
    }
    // Broader fallbacks (require visibility, still excluding previous).
    const selectors = [
      '[data-t="next-episode-button"]',
      '[class*="next-episode" i] a',
      '[class*="next-episode" i] button',
      'button[aria-label*="Next" i][aria-label*="episode" i]',
      'a[aria-label*="Next" i][aria-label*="episode" i]',
      '[data-t="up-next"] a',
      '.up-next-section a',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (looksLikePrevious(el)) continue;
        if (el.offsetParent !== null || el.tagName === "A") return el;
      }
    }
    return null;
  }

  // Find the episode-list link for a SPECIFIC episode number. Clicking a numbered
  // link is deterministic — we can't accidentally overshoot to N+2 — which is why
  // it's preferred over the generic "Next" button for advancing.
  // Matches "E12", "S1E12", "S1 E12", "Episode 12", "EP 12" — not "E120"/"E121".
  function findEpisodeLinkByNumber(n) {
    if (!n || n < 1) return null;
    const rxs = [
      new RegExp(`(^|[^A-Za-z])E\\s*0*${n}([^0-9]|$)`, "i"),
      new RegExp(`\\bEpisode\\s+0*${n}([^0-9]|$)`, "i"),
      new RegExp(`\\bEp\\.?\\s*0*${n}([^0-9]|$)`, "i"),
    ];
    const here = location.href;
    for (const a of document.querySelectorAll('a[href*="/watch/"]')) {
      const href = a.getAttribute("href");
      if (!href) continue;
      try { if (new URL(href, here).href === here) continue; } catch {}
      const text = (a.getAttribute("aria-label") || a.textContent || "").trim();
      if (text && rxs.some((rx) => rx.test(text))) return a;
    }
    return null;
  }

  // Activate an element with a SINGLE native click(). Crunchyroll's Next button
  // and episode links are ordinary buttons/anchors that respond to click(), and
  // firing extra pointer/mouse events on top risked a second activation that
  // advanced two episodes (skipping one). Keep it to exactly one click.
  function dispatchRealClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
    try { el.click(); } catch {}
  }

  // Expand Crunchyroll's episode list so every numbered episode link is present.
  function expandEpisodeList() {
    try {
      const btn = document.querySelector('[data-t="see-more-episodes-btn"], button.see-all-button');
      if (btn && btn.offsetParent !== null) btn.click();
    } catch {}
  }

  // Pause the player so it can't auto-advance to the next episode while we're
  // busy downloading — which would make us skip an episode.
  function pauseVideo() {
    try {
      const v = document.querySelector("video");
      if (v && !v.paused && typeof v.pause === "function") v.pause();
    } catch {}
  }

  // Crunchyroll resumes playback where you left off. If that's near the end, the
  // episode can finish (and auto-advance to the next one) during our download —
  // skipping an episode. Seek back to the start so the end is ~24 min away.
  function seekToStart() {
    try {
      const v = document.querySelector("video");
      if (v && typeof v.currentTime === "number" && v.currentTime > 30) v.currentTime = 0;
    } catch {}
  }

  // Advance to the next episode and get its subtitles ready. To avoid ever
  // skipping, we click the SPECIFIC "episode N+1" link (deterministic) rather
  // than the generic Next button, falling back to the Next button only when the
  // numbered link can't be found (e.g. metadata unavailable). Stops when there's
  // no further episode or it loops back to one already done.
  // Returns { entries } on success, "end" when there's no further episode, or
  // null if it couldn't recover.
  async function reachNextEpisode(oldUrl, currentEp, visitedUrls) {
    const target = (typeof currentEp === "number" && currentEp >= 1) ? currentEp + 1 : null;

    // ── Step 1: navigate to a NEW url (only a click that fails to navigate is
    // "stuck" and worth a nudge — a slow-loading page is not). ──
    for (let round = 0; round < 5 && !seasonStop && location.href === oldUrl; round++) {
      pauseVideo(); // don't let it auto-advance out from under us

      // Prefer the specific numbered episode link so we can't overshoot to N+2.
      let el = null;
      if (target != null) {
        el = findEpisodeLinkByNumber(target);
        if (!el) { expandEpisodeList(); await sleep(500); el = findEpisodeLinkByNumber(target); }
      }
      if (!el) el = findNextEpisodeTarget(); // fallback: player's Next button

      if (el) {
        dispatchRealClick(el);
        await waitForUrlChange(oldUrl, 8000);
      } else if (round >= 1) {
        // No numbered next link and no Next control after a nudge → last episode.
        return "end";
      }
      if (location.href === oldUrl && round < 4 && !seasonStop) {
        setBanner(`↩︎ Next episode didn't load — nudging player (back → forward)… (try ${round + 1})`);
        await historyNudge();
      }
    }
    if (seasonStop) return null;
    if (location.href === oldUrl) return null; // never managed to navigate

    // ── Step 2: we're on a new page. Stop if it's one we've already done. ──
    if (visitedUrls.has(location.href)) return "end";

    // ── Step 3: wait PATIENTLY for its subtitles, then pause so the player
    // can't auto-advance during the download. Nudge once only as a last resort. ──
    await tryAutoplay();
    seekToStart(); // keep the end far away so it can't auto-advance mid-wait
    let entries = await waitForVttEntries(22000);
    if ((!entries || !entries.length) && !seasonStop) {
      setBanner(`↩︎ Subtitles slow to load — nudging player (back → forward)…`);
      await historyNudge();
      await tryAutoplay();
      entries = await waitForVttEntries(22000);
    }
    pauseVideo();
    if (entries && entries.length) {
      visitedUrls.add(location.href);
      return { entries };
    }
    return null;
  }

  // Re-trigger Crunchyroll's SPA loader by stepping back then forward — the
  // automated version of the manual "browser back, then forward" trick that
  // unsticks a half-loaded next episode. Returns to the same URL when done.
  async function historyNudge() {
    if (history.length <= 1) return; // nothing to step back to
    const target = location.href;
    try {
      history.back();
      await sleep(1600);
      if (seasonStop) return;
      history.forward();
      await sleep(1600);
      // If forward didn't restore the episode, click a same-page link back to it
      // (soft nav — never a full reload, which would kill this loop).
      if (location.href !== target && !seasonStop) {
        const link = [...document.querySelectorAll('a[href]')]
          .find((a) => { try { return new URL(a.getAttribute("href"), location.href).href === target; } catch { return false; } });
        if (link) { dispatchRealClick(link); await sleep(1600); }
      }
    } catch {}
  }

  async function waitForUrlChange(oldUrl, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (location.href !== oldUrl) return true;
      await sleep(300);
    }
    return false;
  }

  // Wait for at least one VTT to appear (metadata is checked separately).
  async function waitForVttEntries(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (seasonStop) return null;
      if (foundVtts.size > 0) {
        await sleep(800); // grace period for additional tracks
        return [...foundVtts.values()];
      }
      await sleep(500);
    }
    return foundVtts.size > 0 ? [...foundVtts.values()] : null;
  }

  // Wait for episode metadata to become available on the current page.
  // Polls until JSON-LD or page-title data appears; the URL-slug fallback in
  // getEpisodeMetadata() means this almost always returns something.
  async function waitForMetadata(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (seasonStop) return null;
      if (metaCache && metaCacheUrl !== location.href) {
        metaCache = null;
        metaCacheUrl = null;
      }
      const m = getEpisodeMetadata();
      if (m) return m;
      await sleep(400);
    }
    return getEpisodeMetadata();
  }

  // Signature of an episode's metadata — used to tell one episode's tags apart
  // from another's (for filename freshness after an SPA navigation).
  function metaSig(m) {
    return m ? `${m.series}|${m.season}|${m.episode}|${m.title}` : null;
  }

  // Wait for metadata that belongs to the CURRENT episode, not the previous one.
  // Right after an SPA navigation the page can still expose the prior episode's
  // og:title / JSON-LD for a moment; building a filename from that names the file
  // after the wrong episode. Poll (re-parsing each time) until the signature
  // differs from `prevSig`, or time out.
  async function waitForFreshMetadata(prevSig, timeoutMs = 12000) {
    const start = Date.now();
    let m = getEpisodeMetadata();
    while (Date.now() - start < timeoutMs) {
      if (seasonStop) break;
      metaCache = null; metaCacheUrl = null; // force a fresh parse of the live DOM
      m = getEpisodeMetadata();
      const sig = metaSig(m);
      if (sig && sig !== prevSig) return m;
      await sleep(500);
    }
    return m;
  }

  async function tryAutoplay() {
    // If autoplay is blocked, click the play button so the player loads subtitles.
    const playSelectors = [
      'button[aria-label*="Play" i][aria-label*="video" i]',
      'button[data-t="play-button"]',
      'button[aria-label="Play"]',
      '.vjs-big-play-button',
      'button.player-play-button',
    ];
    for (const sel of playSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null && !el.disabled) {
        try { el.click(); return true; } catch {}
      }
    }
    return false;
  }

  // Wait for the current download to feasibly finish before navigating away.
  async function downloadAndWait(entry) {
    await waitForMetadata(15000);
    const filename = buildFilename(entry);
    const fakeBtn = { textContent: "", classList: { add: () => {}, remove: () => {} } };
    const onDone = () => markDownloaded(entry);
    if (entry.isHls)       await downloadHls({ ...entry, filename }, fakeBtn, onDone);
    else if (entry.isBlob) downloadBlobVtt({ ...entry, filename }, fakeBtn, onDone);
    else                   await downloadDirect(entry.url, filename, fakeBtn, onDone);
    await sleep(1500);
  }

  // Find the episode-list anchor that links to a SPECIFIC episode id. Clicking it
  // is a soft (SPA) navigation to a KNOWN-correct URL — deterministic, unlike the
  // old "which button is Next?" heuristics.
  function findWatchLinkById(id) {
    if (!id) return null;
    for (const a of document.querySelectorAll(`a[href*="/watch/${id}"]`)) {
      if (!looksLikePrevious(a)) return a;
    }
    return null;
  }

  // Navigate to a specific episode from the API plan. Prefer its exact id-link;
  // expand the list if needed; fall back to a numbered link. Confirms we actually
  // landed on the intended episode. Returns false if it couldn't get there
  // (the caller stops cleanly rather than guessing).
  async function navigateToEpisode(ep) {
    const oldUrl = location.href;
    pauseVideo();
    let link = findWatchLinkById(ep.id);
    if (!link) { expandEpisodeList(); await sleep(600); link = findWatchLinkById(ep.id); }
    if (!link) link = findEpisodeLinkByNumber(ep.episode);
    if (!link) { crLog("no in-page link for episode", ep.episode, ep.id); return false; }
    crLog("navigating →", `S${ep.season}E${ep.episode}`, ep.id);
    dispatchRealClick(link);
    let changed = await waitForUrlChange(oldUrl, 8000);
    if (!changed && !seasonStop) { await historyNudge(); changed = location.href !== oldUrl; }
    if (crEpisodeIdFromUrl(location.href) === ep.id) return true;
    crLog("navigation landed on unexpected page:", location.href);
    return crPathKey(location.href) === crPathKey(ep.url);
  }

  // Build the deterministic season queue from the API: the ordered episode list
  // plus where the current episode sits in it. Returns null (→ fall back to the
  // page-scraping loop) if the token or any endpoint is unavailable.
  async function buildCrSeasonPlan() {
    if (!isCrunchyroll) return null;
    for (let i = 0; i < 16 && !CR.token && !seasonStop; i++) await sleep(500); // wait for a token
    if (!CR.token) { crLog("no bearer token captured — cannot use API path"); return null; }
    const id = crEpisodeIdFromUrl();
    if (!id) return null;
    try {
      const cur = await crGetEpisode(id);
      if (!cur || !cur.seasonId) { crLog("no season id for", id); return null; }
      const episodes = await crSeasonEpisodes(cur.seasonId);
      if (!episodes.length) { crLog("empty season episode list"); return null; }
      // Fill any gaps from the authoritative current episode so every filename is complete.
      for (const e of episodes) {
        if (!e.series) e.series = cur.series;
        if (!e.season) e.season = cur.season;
        if (!e.episode) e.episode = 1;
        if (!e.title) e.title = `Episode ${String(e.episode).padStart(2, "0")}`;
      }
      let index = episodes.findIndex((e) => e.id === id);
      if (index < 0) index = episodes.findIndex((e) => e.episode === cur.episode);
      if (index < 0) index = 0;
      for (const e of episodes) {
        CR.metaByPath.set(crPathKey(e.url), { series: e.series, season: e.season, episode: e.episode, title: e.title });
      }
      // Always label the starting page from the episode we actually fetched.
      CR.metaByPath.set(crPathKey(), { series: cur.series, season: cur.season, episode: cur.episode, title: cur.title });
      crLog(`season plan: ${episodes.length} episodes, starting at #${index + 1} (${cur.series} S${cur.season})`);
      return { episodes, index };
    } catch (e) { crLog("buildCrSeasonPlan failed:", e.message || e); return null; }
  }

  // Run the season using the API plan: for each episode in order, open its known
  // page, grab the subtitles, download with the API's clean filename. No "next
  // episode" guessing, no stale-metadata races, and end-of-season is simply the
  // end of the list.
  async function runSeasonViaApi(plan, preferLabel) {
    const eps = plan.episodes;
    const total = eps.length - plan.index;
    let skipped = 0;
    const pad = (n) => String(n).padStart(2, "0");
    const summary = () => `Downloaded ${seasonCount}${skipped ? `, skipped ${skipped}` : ""}.`;

    for (let i = plan.index; i < eps.length && !seasonStop; i++) {
      const ep = eps[i];
      const epTitle = `${ep.series} S${pad(ep.season)}E${pad(ep.episode)}`;

      if (i !== plan.index) {
        setBanner(`🔎 Opening <b>${epTitle}</b>…`);
        if (!(await navigateToEpisode(ep))) {
          setBanner(`⚠️ Couldn't open ${epTitle}. ${summary()}`);
          break;
        }
        await sleep(1200); // let the SPA settle + the URL-change handler clear old state
        // Drop the previous episode's detections so we never grab its subtitle.
        foundVtts.clear(); blobVttStore.clear(); hlsSegmentUrls.clear();
        metaCache = null; metaCacheUrl = null;
        if (isTopFrame) updateUI();
      }
      if (seasonStop) break;

      // The API name is authoritative for THIS page — key it to the live path.
      CR.metaByPath.set(crPathKey(location.href), { series: ep.series, season: ep.season, episode: ep.episode, title: ep.title });

      await tryAutoplay();
      seekToStart();
      let entries = await waitForVttEntries(22000);
      if ((!entries || !entries.length) && !seasonStop) {
        setBanner(`↩︎ Subtitles slow for ${epTitle} — nudging…`);
        await historyNudge(); await tryAutoplay();
        entries = await waitForVttEntries(22000);
      }
      pauseVideo();
      if (seasonStop) break;
      if (!entries || !entries.length) {
        crLog("no subtitles found for", epTitle);
        setBanner(`⚠️ No subtitles found for ${epTitle} — skipping.`);
        skipped++; await sleep(800);
        continue;
      }

      const entry = pickPreferredEntry(entries, preferLabel);
      if (isDownloaded(entry)) {
        skipped++;
        setBanner(`⏭ Already downloaded <b>${epTitle}</b> — skipping.`);
        await sleep(700);
        continue;
      }

      setBanner(`⏳ Downloading <b>${epTitle}</b> (${i - plan.index + 1}/${total})…`);
      try {
        await downloadAndWait(entry);
        seasonCount++;
      } catch (e) {
        const msg = e.message || String(e);
        if (msg.includes("429") || /rate limit/i.test(msg)) {
          setBanner(`🚫 Rate limited after ${seasonCount} download${seasonCount !== 1 ? "s" : ""}. Try again later.`);
          break;
        }
        setBanner(`⚠️ ${msg}`);
        await sleep(2000);
      }
      if (seasonStop) break;
      setBanner(`✅ Saved ${epTitle}. Pausing before next…`);
      await sleep(2000 + Math.random() * 2000);
    }

    if (!seasonStop) setBanner(`✅ Season complete. ${summary()}`, "success");
  }

  async function toggleSeasonDownload() {
    if (seasonActive) {
      seasonStop = true;
      setBanner("⏹ Stopping after current download…");
      return;
    }

    const initial = pickPreferredEntry([...foundVtts.values()]);
    if (!initial) {
      setBanner("⚠️ No VTT files detected yet. Play the video first.");
      setTimeout(() => setBanner(""), 4000);
      return;
    }

    const preferLabel = initial.hlsLabel || initial.trackLabel || "";
    seasonActive = true;
    seasonStop = false;
    seasonCount = 0;
    updateUI();

    // Track every URL we've downloaded so we stop if the "next" link cycles back.
    const visitedUrls = new Set([location.href]);

    // Ensure the player is running so Crunchyroll renders JSON-LD and updates
    // document.title before we try to read episode metadata for episode 1, then
    // pause so it can't auto-advance while we download.
    await tryAutoplay();
    await sleep(1500);
    seekToStart();
    pauseVideo();

    // Preferred path: drive the season from Crunchyroll's content API (ordered
    // episode list + authoritative metadata). Falls back to the page-scraping
    // loop below when the API isn't reachable (no token, non-Crunchyroll, etc.).
    const plan = await buildCrSeasonPlan();
    if (plan && !seasonStop) {
      try { await runSeasonViaApi(plan, preferLabel); }
      catch (e) { crLog("runSeasonViaApi crashed:", e.message || e); setBanner(`⚠️ ${e.message || e}`); }
      finally {
        seasonActive = false; seasonStop = false; updateUI();
        setTimeout(() => { if (!seasonActive) setBanner(""); }, 20000);
      }
      return;
    }
    if (seasonStop) { seasonActive = false; updateUI(); return; }
    crLog("using page-navigation fallback");

    let next = initial;
    let skipped = 0;
    let prevSig = null; // metadata signature of the previous episode (freshness)
    const summary = () =>
      `Downloaded ${seasonCount}${skipped ? `, skipped ${skipped} already-saved` : ""}.`;

    while (next && !seasonStop) {
      // Wait for metadata that belongs to THIS episode (not the previous one's
      // stale tags) before we name/identify it, so filenames match.
      const meta = await waitForFreshMetadata(prevSig, 12000);
      prevSig = metaSig(meta);
      const epTitle = meta
        ? `${meta.series} S${String(meta.season).padStart(2, "0")}E${String(meta.episode).padStart(2, "0")}`
        : `Episode ${seasonCount + skipped + 1}`;

      if (isDownloaded(next)) {
        // Already grabbed on an earlier run — skip re-downloading it.
        skipped++;
        setBanner(`⏭ Already downloaded <b>${epTitle}</b> — skipping.`);
        await sleep(900);
      } else {
        setBanner(`⏳ Downloading <b>${epTitle}</b> (${preferLabel || "default track"})…`);
        try {
          await downloadAndWait(next);
          seasonCount++;
        } catch (e) {
          const msg = e.message || String(e);
          setBanner(`⚠️ ${msg}`);
          if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
            setBanner(`🚫 Rate limited by server after ${seasonCount} download${seasonCount !== 1 ? "s" : ""}. Try again later.`);
            break;
          }
          await sleep(2000);
        }
        if (seasonStop) break;
        setBanner(`✅ Saved ${epTitle}. Pausing before next episode…`);
        // Brief jittered pause — keeps request cadence human-paced and
        // reduces any chance of triggering Crunchyroll's rate limiter.
        await sleep(2000 + Math.random() * 2000);
      }

      if (seasonStop) break;

      setBanner(`🔎 Loading next episode…`);

      // Reach the next episode by clicking the specific "episode N+1" link so we
      // can't overshoot; nudge only if a click fails to navigate.
      const oldUrl = location.href;
      const curEp = meta && typeof meta.episode === "number" ? meta.episode : null;
      const result = await reachNextEpisode(oldUrl, curEp, visitedUrls);
      if (seasonStop) break;
      if (result === "end") {
        setBanner(`✅ Season complete — no more episodes. ${summary()}`, "success");
        break;
      }
      if (!result || !result.entries) {
        setBanner(`⚠️ Stopped — couldn't reach the next episode after several tries. ${summary()}`);
        break;
      }

      next = pickPreferredEntry(result.entries, preferLabel);
    }

    seasonActive = false;
    seasonStop = false;
    updateUI();
    // Leave the final banner up long enough to be noticed, but don't wipe a new
    // run if the user starts one.
    setTimeout(() => { if (!seasonActive) setBanner(""); }, 20000);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function init() {
    if (isTopFrame) {
      buildUI();

      // Listen for VTT detections from iframed players (Crunchyroll's vilos, etc.)
      window.addEventListener("message", (e) => {
        const d = e.data;
        if (!d || !d.__vtt_downloader || d.type !== "vtt_found") return;
        if (addVtt(d.url, d.source, d.extra || {})) updateUI();
      });
    }

    scanDOM();

    const observer = new MutationObserver(() => scanDOM());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (isTopFrame) {
      let lastUrl = location.href;
      setInterval(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          foundVtts.clear();
          blobVttStore.clear();
          hlsSegmentUrls.clear();
          metaCache = null;
          metaCacheUrl = null;
          setTimeout(scanDOM, 600);
          refreshCrMeta(); // fetch clean API metadata for the new episode (no-op without a token)
          updateUI();
        }
      }, 1000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
