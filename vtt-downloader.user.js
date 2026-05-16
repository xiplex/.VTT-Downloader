// ==UserScript==
// @name         VTT Downloader
// @namespace    https://github.com/xiplex/.vtt-downloader
// @version      1.20.0
// @description  Detects WebVTT subtitle files on any page and shows a floating download panel
// @author       xiplex
// @match        *://*/*
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

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
    const isEnglish = /\benglish\b|\beng\b|\b(?:en|en-us|en-gb)\b/.test(l);
    const hasCC = /\[\s*cc\s*\]|\(\s*cc\s*\)|\bcc\b|closed[\s-]*caption|\bsdh\b/.test(l);
    return isEnglish && hasCC;
  }

  // URL-only hint check for cases where no label is available.
  function urlSuggestsEnglishCC(url) {
    if (!url) return false;
    try {
      const u = new URL(url, location.href);
      const path = (u.pathname + " " + u.search).toLowerCase();
      const isEnglish = /(^|[^a-z])(en|eng|english|en[-_]us|en[-_]gb)([^a-z]|$)/.test(path);
      const hasCC = /(^|[^a-z])(cc|caption|captions|sdh)([^a-z]|$)/.test(path);
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

  const origRevokeObjectURL = pageWin.URL.revokeObjectURL.bind(pageWin.URL);
  // Don't actually overwrite — let the page revoke normally; we keep the text
  // in blobVttStore independent of the URL's lifecycle.
  void origRevokeObjectURL;

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

  // Parse an og:title or document.title string into episode metadata.
  // Covers the main formats Crunchyroll uses:
  //   "Watch Series Season 2 Episode 5 – Title | Crunchyroll"
  //   "Watch Series Episode 5 – Title | Crunchyroll"
  //   "Watch Series – E5 – Title | Crunchyroll"   (short format)
  //   "Watch Series - S1E5 – Title | Crunchyroll"
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

  function getEpisodeMetadata() {
    if (metaCache && metaCacheUrl !== location.href) { metaCache = null; metaCacheUrl = null; }
    if (metaCache) return metaCache;

    const here = location.href;
    const notSameAsSeries = (title, series) =>
      !!title && title.trim().toLowerCase() !== series.trim().toLowerCase();

    // ── Source 1: og:title / twitter:title / document.title ───────────────────
    for (const raw of [
      document.querySelector('meta[property="og:title"]')?.content || "",
      document.querySelector('meta[name="twitter:title"]')?.content || "",
      document.title,
    ]) {
      const m = parseTitleString(raw);
      if (m && notSameAsSeries(m.title, m.series)) {
        metaCache = m; metaCacheUrl = here; return m;
      }
    }

    // ── Source 2: meta[name="description"] ────────────────────────────────────
    const desc = (document.querySelector('meta[name="description"]')?.content || "").trim();
    for (const pat of [
      /Watch\s+(.+?)\s+Episode\s+(\d+)[,\s–\-]+(.+?)\s+on\s+Crunchyroll/i,
      /Watch\s+(.+?)\s*[-–]\s*Ep?\.?\s*(\d+)\s*[-–:]\s*(.+?)\s+on\s+Crunchyroll/i,
    ]) {
      const m = desc.match(pat);
      if (m && notSameAsSeries(m[3], m[1])) {
        const meta = { series: m[1].trim(), season: 1, episode: +m[2], title: m[3].trim() };
        metaCache = meta; metaCacheUrl = here; return meta;
      }
    }

    // ── Source 3: JSON-LD — collect ep data even when title equals series name ─
    let jsonLDBase = null; // { series, season, episode } — used by sources 4 & 5
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const root = JSON.parse(el.textContent);
        for (const node of [].concat(root?.["@graph"] || root)) {
          if (!/TVEpisode|Episode/i.test(node["@type"] || "")) continue;
          const series = (node.partOfSeries?.name || node.partOfTVSeries?.name || "").trim();
          if (!series) continue;
          const ldUrl = (node.url || "").trim();
          if (ldUrl && !pathsMatch(ldUrl, here)) continue;
          const episode = parseInt(node.episodeNumber, 10) || 1;
          const season  = parseInt(node.partOfSeason?.seasonNumber, 10) || 1;
          // Try cleaned title — return immediately if it's genuinely different
          const rawTitle = (node.name || "").trim();
          if (rawTitle) {
            const title = cleanEpisodeTitle(rawTitle, series);
            if (notSameAsSeries(title, series)) {
              const meta = { series, season, episode, title };
              metaCache = meta; metaCacheUrl = here; return meta;
            }
          }
          // Title was bad but ep# / series are still useful
          if (!jsonLDBase) jsonLDBase = { series, season, episode };
        }
      } catch {}
    }

    // ── Source 3b: VideoObject JSON-LD ────────────────────────────────────────
    // Crunchyroll includes a second JSON-LD block typed "VideoObject" whose
    // "name" field contains the clean episode title (no series prefix, no ep#).
    if (jsonLDBase) {
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const root = JSON.parse(el.textContent);
          if (root["@type"] === "VideoObject" && root.name) {
            const title = root.name.trim();
            if (notSameAsSeries(title, jsonLDBase.series)) {
              const meta = { ...jsonLDBase, title };
              metaCache = meta; metaCacheUrl = here; return meta;
            }
          }
        } catch {}
      }
    }

    // ── Source 4: innerText scan using the ep# we got from JSON-LD ────────────
    // The episode title is visible on screen as "E1 – That's How Love Starts…"
    // document.body.innerText gives us every rendered line, so we search for the
    // specific episode number to avoid matching sidebar entries for other episodes.
    if (jsonLDBase) {
      try {
        const pageText = document.body?.innerText || "";
        const n = jsonLDBase.episode;
        for (const pat of [
          new RegExp(`(?:^|\\n)\\s*E0*${n}\\s*[-–]\\s*(.{3,100})(?=\\r?\\n|$)`, "im"),
          new RegExp(`(?:^|\\n)\\s*Episode\\s+0*${n}\\s*[-–:]\\s*(.{3,100})(?=\\r?\\n|$)`, "im"),
        ]) {
          const m = pageText.match(pat);
          if (!m) continue;
          const title = m[1].trim();
          if (notSameAsSeries(title, jsonLDBase.series)) {
            const meta = { ...jsonLDBase, title };
            metaCache = meta; metaCacheUrl = here; return meta;
          }
        }
      } catch {}
    }

    // ── Source 5: URL slug with normalized series-name comparison ──────────────
    // Normalize to lowercase alphanumeric so "DAN DA DAN" == "dan-da-dan".
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const slugM = location.pathname.match(/\/watch\/[^/]+\/([^/?#]+)/i);
    if (slugM) {
      const slug = slugM[1];
      const series = jsonLDBase?.series || cleanSeriesName(
        (document.querySelector('meta[property="og:title"]')?.content || document.title || "")
          .replace(/\s*\|\s*[^|]+$/, "").replace(/^Watch\s+/i, "").replace(/\s*[-–].*$/, "").trim()
      );
      if (series && norm(slug) !== norm(series)) {
        const title = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        if (notSameAsSeries(title, series)) {
          const meta = { series, season: jsonLDBase?.season || 1,
                         episode: jsonLDBase?.episode || 1, title };
          metaCache = meta; metaCacheUrl = here; return meta;
        }
      }
    }

    console.debug(
      "[VTT Downloader] metadata extraction failed\n",
      " og:title:", document.querySelector('meta[property="og:title"]')?.content, "\n",
      " doc title:", document.title, "\n",
      " description:", (document.querySelector('meta[name="description"]')?.content || "").slice(0, 200),
      "\n jsonLDBase:", jsonLDBase,
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
      const kindMatch  = trackKind === "captions" && /^en\b/i.test(trackLang);
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
      const item = document.createElement("div");
      item.className = "vdp-item";

      const tagClass = isHls ? "hls" : isBlob ? "blob" : "";
      const tagLabel = isHls ? "HLS" : isBlob ? "Blob" : sourceLabel(source);
      const host = isBlob ? "in-page" : hostnameFromUrl(url);

      const info = document.createElement("div");
      info.className = "vdp-info";
      info.innerHTML = `
        <div class="vdp-name" title="${url}">${displayName}</div>
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
    // Build the formatted filename at click time so page metadata is fully loaded
    const filename = buildFilename(entry);
    if (entry.isHls) {
      downloadHls({ ...entry, filename }, btn);
    } else if (entry.isBlob) {
      downloadBlobVtt({ ...entry, filename }, btn);
    } else {
      downloadDirect(entry.url, filename, btn);
    }
  }

  // Cross-origin URLs make browsers ignore the anchor `download` attribute,
  // so we fetch the VTT body and re-save it as a same-origin blob — that way
  // our chosen filename is actually honored.
  async function downloadDirect(url, filename, btn) {
    if (btn) { btn.textContent = "⏳ Fetching…"; btn.classList.add("busy"); }

    // 1. Try regular fetch (works if the page already has CORS access)
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (resp.status === 429) throw new Error("Rate limited (429) — wait a moment before continuing");
      if (resp.ok) {
        const text = await resp.text();
        saveTextAsVtt(text, filename, btn);
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
            saveTextAsVtt(resp.responseText, filename, btn);
          } else {
            tryGmDownload(url, filename, btn);
          }
        },
        onerror: () => tryGmDownload(url, filename, btn),
      });
      return;
    }

    // 3. Last resort
    tryGmDownload(url, filename, btn);
  }

  function tryGmDownload(url, filename, btn) {
    if (typeof GM_download !== "undefined") {
      GM_download({
        url,
        name: filename,
        onload: () => { if (btn) { btn.textContent = "✓ Saved"; btn.classList.remove("busy"); btn.classList.add("done"); } },
        onerror: () => fallbackDownload(url, filename, btn),
      });
    } else {
      fallbackDownload(url, filename, btn);
    }
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
          saveTextAsVtt(text, entry.filename, btn);
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

  function fallbackDownload(url, filename, btn) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.cssText = "display:none!important";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (btn) { btn.textContent = "✓ Saved"; btn.classList.remove("busy"); btn.classList.add("done"); }
  }

  // ── Season auto-download ───────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setBanner(html) {
    const b = document.getElementById("vtt-dl-banner");
    if (!b) return;
    if (!html) { b.classList.remove("visible"); b.innerHTML = ""; return; }
    b.innerHTML = html;
    b.classList.add("visible");
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

  // Try a list of selectors / strategies to find Crunchyroll's "next episode" trigger.
  function findNextEpisodeTarget() {
    const selectors = [
      '[data-t="next-episode-button"]',
      '[data-testid="next-episode-button"]',
      '[data-testid="next-episode"]',
      'button[aria-label*="Next Episode" i]',
      'a[aria-label*="Next Episode" i]',
      'button[aria-label*="Next" i][aria-label*="episode" i]',
      'a[aria-label*="Next" i][aria-label*="episode" i]',
      '[class*="next-episode" i] a',
      '[class*="next-episode" i] button',
      '[class*="NextEpisode" i] a',
      '[class*="NextEpisode" i] button',
      '.up-next-section a',
      '[data-t="up-next"] a',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && (el.offsetParent !== null || el.tagName === "A")) return el;
    }

    // Fallback: find the currently-playing episode card and grab the next sibling's link.
    const currentSelectors = [
      '[data-t="current-episode"]',
      '[aria-current="true"]',
      '[aria-current="page"]',
      '.current-episode',
      '.is-current',
    ];
    for (const sel of currentSelectors) {
      const cur = document.querySelector(sel);
      if (!cur) continue;
      const sib = cur.nextElementSibling;
      if (sib) {
        const link = sib.matches("a") ? sib : sib.querySelector("a[href*='/watch/']");
        if (link) return link;
      }
    }

    return null;
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
    if (entry.isHls)       await downloadHls({ ...entry, filename }, fakeBtn);
    else if (entry.isBlob) downloadBlobVtt({ ...entry, filename }, fakeBtn);
    else                   await downloadDirect(entry.url, filename, fakeBtn);
    await sleep(1500);
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
    // document.title before we try to read episode metadata for episode 1.
    await tryAutoplay();
    await sleep(1500);

    let next = initial;

    while (next && !seasonStop) {
      seasonCount++;
      const meta = getEpisodeMetadata();
      const epTitle = meta ? `${meta.series} S${String(meta.season).padStart(2, "0")}E${String(meta.episode).padStart(2, "0")}` : `Episode ${seasonCount}`;
      setBanner(`⏳ Downloading <b>${epTitle}</b> (${preferLabel || "default track"})…`);

      try {
        await downloadAndWait(next);
      } catch (e) {
        const msg = e.message || String(e);
        setBanner(`⚠️ ${msg}`);
        if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
          setBanner(`🚫 Rate limited by server after ${seasonCount} episode${seasonCount !== 1 ? "s" : ""}. Try again later.`);
          break;
        }
        await sleep(2000);
      }

      if (seasonStop) break;

      setBanner(`✅ Saved ${epTitle}. Pausing before next episode…`);

      // Brief jittered pause — keeps request cadence human-paced and
      // reduces any chance of triggering Crunchyroll's rate limiter.
      await sleep(2000 + Math.random() * 2000);
      if (seasonStop) break;

      setBanner(`✅ Saved ${epTitle}. Looking for next episode…`);

      const target = findNextEpisodeTarget();
      if (!target) {
        setBanner(`🏁 Done — no next-episode link found. Downloaded ${seasonCount} episode${seasonCount !== 1 ? "s" : ""}.`);
        break;
      }

      const oldUrl = location.href;
      try { target.click(); } catch {}

      const navigated = await waitForUrlChange(oldUrl, 15000);
      if (!navigated) {
        setBanner(`🏁 Navigation didn't happen — stopping. Downloaded ${seasonCount} episode${seasonCount !== 1 ? "s" : ""}.`);
        break;
      }

      // Stop if we've already downloaded this URL — means the playlist cycled back.
      if (visitedUrls.has(location.href)) {
        setBanner(`🏁 Reached end of season. Downloaded ${seasonCount} episode${seasonCount !== 1 ? "s" : ""}.`);
        break;
      }
      visitedUrls.add(location.href);

      // Give the page a moment to clear state
      await sleep(2500);
      if (seasonStop) break;

      // Try autoplay if needed
      await tryAutoplay();

      setBanner(`⏳ Waiting for episode ${seasonCount + 1} subtitles to load…`);
      const newEntries = await waitForVttEntries(45000);
      if (!newEntries || newEntries.length === 0) {
        setBanner(`🏁 Timed out waiting for subtitles on the next episode. Downloaded ${seasonCount} episode${seasonCount !== 1 ? "s" : ""}.`);
        break;
      }

      next = pickPreferredEntry(newEntries, preferLabel);
    }

    seasonActive = false;
    seasonStop = false;
    updateUI();
    setTimeout(() => {
      const banner = document.getElementById("vtt-dl-banner");
      if (banner && !seasonActive) setTimeout(() => setBanner(""), 8000);
    }, 100);
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
