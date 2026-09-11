# VTT Downloader

Detect WebVTT subtitle files on a web page and download them with one click.
This repo ships **two tools** that share the name but differ in what they do —
pick the one that fits.

| | Browser extension | Tampermonkey userscript |
|---|---|---|
| Detect `.vtt` via `<track>` / `<source>` / `<a>` / inline scripts | ✅ | ✅ |
| Detect `.vtt` via network requests (fetch / XHR) | ✅ | ✅ |
| Works on any website | ✅ | ✅ |
| Filenames | server's raw filename | server's raw filename |
| **Crunchyroll: English [CC] filtering** | ❌ | ✅ |
| **Crunchyroll: `Series_S01E01_Title` filenames** | ❌ | ✅ |
| **Crunchyroll: merge HLS subtitle segments into one file** | ❌ | ✅ |
| **Crunchyroll: auto-download a whole season** | ❌ | ✅ |

**In short:** the extension is a general-purpose "grab the VTT off this page"
tool. The userscript is that *plus* a Crunchyroll layer that names files by
episode and can walk an entire season on its own. If you're on Crunchyroll, use
the userscript.

---

## Option 1 — Browser Extension (Chrome & Firefox)

A simple, general-purpose VTT detector for any site.

### Step 1: Download the files

1. Go to the repository on GitHub
2. Click the green **Code** button → **Download ZIP**
3. Find the downloaded ZIP file (usually in your Downloads folder) and **unzip it** — you must unzip it, the browser cannot load a ZIP directly
4. Move the unzipped folder somewhere permanent like `Documents/VTT-Downloader` — the browser will load the extension directly from this folder, so don't delete it

### Step 2: Load in Chrome

1. Open `chrome://extensions` in your browser
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the unzipped `VTT-Downloader` folder
5. The **VTT** icon will appear in your toolbar

### Step 2 (alt): Load in Firefox

1. Open `about:debugging` in your browser
2. Click **This Firefox**
3. Click **Load Temporary Add-on…**
4. Open the unzipped `VTT-Downloader` folder and select `manifest.json`
5. The **VTT** icon will appear in your toolbar

> **Firefox note:** Temporary add-ons are removed when the browser closes. Repeat this step each time, or look into self-signing the extension for a permanent install.

---

## Option 2 — Tampermonkey Userscript (recommended for Crunchyroll)

Works in any browser that supports Tampermonkey (Chrome, Firefox, Edge, Safari).
No unzipping needed — just paste one file.

### Step 1: Install Tampermonkey

Install the Tampermonkey extension for your browser from [tampermonkey.net](https://www.tampermonkey.net) if you don't already have it.

### Step 2: Install the userscript

1. Go to the repository on GitHub and open `vtt-downloader.user.js`
2. Click the **Raw** button to view the plain file
3. Tampermonkey will detect the userscript and show an install prompt — click **Install**

Alternatively, install manually:
1. Click the Tampermonkey icon in your toolbar → **Create a new script**
2. Delete any placeholder code in the editor
3. Copy the entire contents of `vtt-downloader.user.js` and paste it in
4. Press **Ctrl+S** (or **Cmd+S**) to save

### Step 3: Use it

Navigate to any page with VTT files. A floating **VTT** button appears in the
bottom-right corner. Click it to open the download panel.

---

## Using either tool

1. Navigate to a page that contains VTT subtitle files
2. Open the panel — the **VTT** toolbar icon (extension) or the floating **VTT** button (userscript)
3. The panel lists the detected VTT files
4. Click **Download** next to a file, or **Download All**
5. **↺ Rescan page** (extension) refreshes results after in-app navigation

## Crunchyroll extras (userscript only)

On a Crunchyroll watch page the userscript adds:

- **English [CC] only.** Non-English and non-caption tracks are filtered out of the panel.
- **Episode-aware filenames.** Downloads are named `Series_S01E01_Title - English [CC].vtt` using the page's episode metadata instead of an opaque server filename.
- **HLS merging.** When captions are served as HLS segments, they're stitched back into a single `.vtt`.
- **Season ▶.** Auto-downloads every episode in the season: grab subtitles, advance to the next episode, repeat. It remembers what it has already downloaded (across reloads) and skips duplicates. Click **Stop ⏹** to end early; the **history ✕** link forgets the record so you can re-download.

> The Crunchyroll features work by reading the page and driving its player, so
> they can break when Crunchyroll changes its site. See
> [`ARCHITECTURE.md`](ARCHITECTURE.md) if you're maintaining this.

---

## How it detects VTT files

| Method | Extension | Userscript |
|---|---|---|
| `<track>` and `<source>` elements | Yes | Yes |
| `<a href>` links to `.vtt` files | Yes | Yes |
| Inline `<script>` content (JSON config blobs) | Yes | Yes |
| Network requests (fetch / XHR) | Yes (webRequest API) | Yes (patches fetch & XHR) |
| Blob URLs created from VTT text | No | Yes |
| HLS subtitle playlists | No | Yes |
| Dynamically added content | Yes (MutationObserver) | Yes (MutationObserver) |

---

## Permissions (extension only)

| Permission | Reason |
|---|---|
| `activeTab` | Read the current tab and communicate with it |
| `webRequest` | Intercept network requests to detect VTT file loads |
| `downloads` | Save files directly to your Downloads folder |
| `storage` | Store detected URLs per tab |
| `host_permissions: <all_urls>` | Monitor requests on any site |

---

## Contributing / maintaining

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first. It explains why the two tools
exist, which parts are fragile and why, and the invariants in the Crunchyroll
layer that must not be reverted. There's no build step and no automated tests;
at minimum run `node --check` on any file you change.
