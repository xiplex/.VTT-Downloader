# VTT Downloader

A browser extension (Chrome/Firefox) and Tampermonkey userscript that detects WebVTT subtitle files on any webpage and lets you download them with one click.

---

## Option 1 — Browser Extension (Chrome & Firefox)

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

### Step 2: Load in Firefox

1. Open `about:debugging` in your browser
2. Click **This Firefox**
3. Click **Load Temporary Add-on…**
4. Open the unzipped `VTT-Downloader` folder and select `manifest.json`
5. The **VTT** icon will appear in your toolbar

> **Firefox note:** Temporary add-ons are removed when the browser closes. Repeat Step 2 each time, or look into self-signing the extension for a permanent install.

---

## Option 2 — Tampermonkey Userscript

Works in any browser that supports Tampermonkey (Chrome, Firefox, Edge, Safari). No unzipping needed — just paste one file.

### Step 1: Install Tampermonkey

Install the Tampermonkey extension for your browser from [tampermonkey.net](https://www.tampermonkey.net) if you don't already have it.

### Step 2: Install the userscript

1. Go to the repository on GitHub and open `vtt-downloader.user.js`
2. Click the **Raw** button to view the plain file
3. Tampermonkey will automatically detect the userscript and show an install prompt — click **Install**

Alternatively, install manually:
1. Click the Tampermonkey icon in your toolbar → **Create a new script**
2. Delete any placeholder code in the editor
3. Copy the entire contents of `vtt-downloader.user.js` and paste it in
4. Press **Ctrl+S** (or **Cmd+S**) to save

### Step 3: Use it

Navigate to any page with VTT files. A floating **VTT** button will appear in the bottom-right corner of the page. Click it to open the download panel.

---

## Using the extension / userscript

1. Navigate to any page that contains VTT subtitle files
2. Click the **VTT** toolbar icon (extension) or the floating **VTT** button (Tampermonkey)
3. The panel lists all detected VTT files on the current page
4. Click **Download** next to any file, or **Download All** to grab everything at once
5. Use **↺ Rescan page** (extension only) if you navigated within a single-page app and want to refresh results

---

## How it detects VTT files

| Method | Extension | Tampermonkey |
|---|---|---|
| `<track>` and `<source>` elements | Yes | Yes |
| `<a href>` links to `.vtt` files | Yes | Yes |
| Inline `<script>` content (JSON config blobs) | Yes | Yes |
| Network requests (fetch / XHR) | Yes (webRequest API) | Yes (patches fetch & XHR) |
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
