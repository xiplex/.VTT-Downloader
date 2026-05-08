# VTT Downloader

A browser extension for Chrome and Firefox that detects WebVTT subtitle files on any webpage and lets you download them with one click.

## Download the extension

1. Go to the repository on GitHub
2. Click the green **Code** button
3. Select **Download ZIP**
4. Unzip the downloaded file — you should see a folder containing `manifest.json`, `background.js`, `content.js`, `popup.html`, `popup.js`, and an `icons` folder
5. Keep the folder somewhere permanent (e.g. `Documents`) — Chrome and Firefox load the extension directly from this folder

## Install

### Chrome

1. Open `chrome://extensions` in your browser
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `VTT-Downloader` folder
5. The extension icon will appear in your toolbar

### Firefox

1. Open `about:debugging` in your browser
2. Click **This Firefox**
3. Click **Load Temporary Add-on…**
4. Navigate to the `VTT-Downloader` folder and select `manifest.json`
5. The extension icon will appear in your toolbar

> **Note:** Firefox temporary add-ons are removed when the browser closes. For a permanent install, the extension would need to be signed by Mozilla.

## Usage

1. Navigate to any page that contains VTT subtitle files
2. Click the **VTT** icon in your toolbar
3. The popup shows all detected VTT files on the current page
4. Click **Download** next to a file to save it, or **Download All** to grab everything at once
5. Use **↺ Rescan page** if you navigated within a single-page app and want to refresh results

## How it detects VTT files

- Network requests made by the page (e.g. video players fetching subtitles)
- `<track>` and `<source>` HTML elements
- Links (`<a href>`) pointing to `.vtt` files
- Inline script content (JSON config blobs that reference VTT URLs)
- Dynamically added content via MutationObserver

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Read the current tab's URL and send messages to it |
| `webRequest` | Intercept network requests to detect VTT file loads |
| `downloads` | Save files directly to your Downloads folder |
| `storage` | Store detected URLs per tab |
| `host_permissions: <all_urls>` | Monitor requests on any site |
