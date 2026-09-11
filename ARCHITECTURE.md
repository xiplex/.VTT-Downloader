# Architecture & maintenance notes

Read this before changing `vtt-downloader.user.js`. It exists to stop the same
bugs from being re-fixed over and over.

## What this repo actually is

Two separate tools that share a name:

| | What it does | Files |
|---|---|---|
| **Browser extension** | Site-agnostic. Detects any `.vtt` URL (network + DOM) and downloads it with the server's raw filename. No caption filtering, no episode naming, no season logic. | `manifest.json`, `background.js`, `content.js`, `popup.*` |
| **Userscript** | The extension's detector **plus** a Crunchyroll layer: English-[CC] filtering, HLS segment merging, `Series_S01E01_Title` filenames, and a season auto-downloader. | `vtt-downloader.user.js` |

The extension and the userscript **do not share code** — the extension is a
content script + service worker (separate execution contexts, no bundler), the
userscript is one file injected by Tampermonkey. Small helpers like `isVttUrl`
are duplicated between them on purpose; unifying them would require a build step
this project deliberately doesn't have.

## Why development kept going in circles

Almost every commit after v1.16 re-fixed one of two things. Both have the same
root cause: **the Crunchyroll layer reads and drives a third party's UI, which
is a moving target.**

### 1. Metadata → filename (the fixable half)

The episode's `series / season / episode / title` used to be extracted by
parsing human-readable strings (`og:title`, `document.title`) *first*, with the
machine-readable JSON-LD only as a fallback. Every new show's title layout broke
a regex, producing a fix commit ("Fix DAN DA DAN naming", "Strip series name
prefix", "episode title duplicating series name", …).

**The fix (shipped in v1.36):** `getEpisodeMetadata()` now tries sources in order
of *how structured they are*, not how convenient they are to parse:

1. JSON-LD `TVEpisode` (structured series/season/episode + title)
2. JSON-LD `VideoObject` (clean title when `TVEpisode.name` was unusable)
3. URL slug (`/watch/<id>/<slug>` — machine-generated, stable)
4. On-screen `E<n> – Title` heading, anchored to the JSON-LD episode number
5. **Last resort:** parse `og:title` / `document.title` / description strings

**Invariant — do not reorder the string parsers (step 5) earlier.** They are last
on purpose. If a show is named wrong, the fix is almost always to make a
*structured* source (1–4) handle it, not to add another regex to step 5.

### 2. Season navigation (the fragile half)

As of v1.37 there are **two** season paths (`toggleSeasonDownload`):

1. **API path (preferred, `runSeasonViaApi`)** — see "Crunchyroll API" below.
   Uses the content API for the ordered episode list + clean metadata, so
   filenames are authoritative, "next episode" is a known URL (no guessing), and
   end-of-season is just the end of the list. This is the durable fix; it kills
   the naming, stale-metadata, and false-"last-episode" bugs.
2. **Page-scraping fallback (the original loop)** — runs only when the API path
   can't start (no bearer token captured, not on Crunchyroll, or an endpoint
   fails). It advances by *driving the player UI*: find the "Next Episode" button
   or numbered link, click it, wait for the SPA, nudge history if it stalls.

The fallback is fragile and full of hard-won invariants. **Do not revert these
without reading the commit that added them:**

- **Single native `click()` only** (`dispatchRealClick`). Firing extra
  pointer/mouse events double-activated the control and skipped an episode.
- **Prefer the numbered "episode N+1" link** over the generic Next button
  (`findEpisodeLinkByNumber`). Numbered links are deterministic — the Next
  button could overshoot.
- **Never click a "previous" control** (`looksLikePrevious`). Going backward
  looked like end-of-season to the loop.
- **Pause + seek-to-start after navigating** (`pauseVideo`, `seekToStart`).
  Otherwise the player auto-advanced during a download and skipped an episode.
- **Dedup by URL path**, not by metadata (`episodeKey`). Metadata lags a moment
  after an SPA jump; the path updates instantly.
- **Wait for *fresh* metadata** before naming a file (`waitForFreshMetadata`).
  The prior episode's tags linger briefly after navigation.

## Crunchyroll API (the real fix — implemented v1.37)

UI-driving will always be fragile, so the metadata and season navigation now
prefer Crunchyroll's own content API. See the "Crunchyroll API" section in
`vtt-downloader.user.js`.

**How the token is obtained.** We never handle a login. The fetch/XHR patches
already wrap the page's own network calls, so `captureAuth()` skims the
`Authorization: Bearer …` header off Crunchyroll's *own* authorized requests and
stashes it (`CR.token`). We then reuse it for same-origin API calls
(`crApi()`). No client secret, no `/token` grant, nothing to keep in sync with
Crunchyroll's auth flow.

**Endpoints used** (same-origin, Bearer only — no CMS signing needed):

- `GET /content/v2/cms/objects/{episodeId}?locale=en-US` → the current episode's
  `episode_metadata` (`series_title`, `season_number`, `episode_number`,
  `season_id`) and clean `title`.
- `GET /content/v2/cms/seasons/{seasonId}/episodes?locale=en-US` → the **ordered**
  episode list (each with `id`, `slug_title`, numbers, titles) → the season queue.

**How it's wired in:**

- `refreshCrMeta()` caches the current episode's metadata in `CR.metaByPath`
  (keyed by URL path). `getEpisodeMetadata()` checks that map first (Source 0,
  authoritative), so filenames are correct even when the page hasn't rendered.
- `buildCrSeasonPlan()` builds the ordered queue + current index;
  `runSeasonViaApi()` walks it, navigating to each episode's **known** URL via
  its exact id-link (`findWatchLinkById` → deterministic, no overshoot) and
  reusing the proven in-page subtitle detection + download path.

**Deliberate limits / where it can still fail (candidates for the next pass):**

- Navigation is still an in-page (SPA) click on the episode's own link. If that
  link isn't in the DOM (and expanding the list doesn't reveal it), the run
  stops cleanly rather than guessing. If testing shows this happens often, the
  planned next step is **full-page navigation with a persisted resume queue**
  (store the plan in `GM_setValue`, `location.assign` each episode, resume on
  load) — maximally reliable because every page is fully loaded.
- Subtitles are still detected in-page (needs playback), not fetched from the
  API play endpoint. The play endpoint (`cr-play-service…/v1/{id}/…/play`) would
  remove playback entirely but is cross-origin, may open a stream "session" that
  must be released, and can serve non-VTT formats — deferred until the above is
  proven.
- **Untested against live Crunchyroll** from the dev environment (its network is
  blocked there). Verbose `[VTT CR-API]` console logging exists so a real test
  session is diagnosable. If the API path no-ops, the log says why and the
  page-scraping fallback takes over.

## Testing without Crunchyroll

There's no automated test suite. Minimum before committing:

- `node --check vtt-downloader.user.js` (and the extension's `.js` files).
- The site-agnostic detector can be exercised on any page with a `<track>` or a
  `.vtt` network request. The Crunchyroll layer has to be verified by hand on a
  real watch page.
