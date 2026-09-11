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

The season loop advances by *driving the player UI*: find the "Next Episode"
button or the numbered episode link, click it, wait for the SPA to load, nudge
history if it stalls. That is why it keeps breaking on layout changes, and why
the loop is full of hard-won invariants. **Do not revert these without reading
the commit that added them:**

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

## The real fix for the navigation churn (recommended, not yet done)

UI-driving will always be fragile. The durable fix is to stop scraping the
rendered page and use Crunchyroll's own content API, which the web app already
calls:

- `GET /content/v2/cms/seasons/{season_id}/episodes` returns the **ordered**
  episode list with clean `title`, `episode_number`, `season_number`, and
  `series_title`, plus each episode's watch URL/id.

With that list, the season loop becomes "for each episode in order, navigate to
its known URL and grab the subtitles" — no button-clicking, no history nudging,
no stall detection, and metadata comes straight from JSON (killing most of
`getEpisodeMetadata` too).

**Why it isn't done yet / the tradeoffs:**

- The API needs a bearer token that the page holds (typically reachable via the
  `/token` endpoint or an in-page store). Lifting it reliably is its own
  maintenance surface, and it can change.
- It couldn't be validated from the development environment (Crunchyroll is
  auth-gated and JS-rendered), so shipping it blind would risk breaking the one
  navigation path that currently works.

Recommended approach when picking this up: implement the API path *behind* the
existing UI-driving loop as a fallback, verify it live on a couple of seasons,
then make it primary and delete the heuristics it replaces.

## Testing without Crunchyroll

There's no automated test suite. Minimum before committing:

- `node --check vtt-downloader.user.js` (and the extension's `.js` files).
- The site-agnostic detector can be exercised on any page with a `<track>` or a
  `.vtt` network request. The Crunchyroll layer has to be verified by hand on a
  real watch page.
