const api = typeof browser !== "undefined" ? browser : chrome;

let currentTabId = null;
let currentVtts = [];

const listEl = document.getElementById("vtt-list");
const emptyEl = document.getElementById("empty-state");
const badgeEl = document.getElementById("count-badge");
const scanStatusEl = document.getElementById("scan-status");
const footerStatusEl = document.getElementById("footer-status");
const btnDownloadAll = document.getElementById("btn-download-all");
const btnRescan = document.getElementById("btn-rescan");

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/");
    const name = parts[parts.length - 1];
    if (name && name.toLowerCase().includes(".vtt")) return decodeURIComponent(name);
  } catch {}
  return "subtitles.vtt";
}

function sourceLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function renderList(vtts) {
  currentVtts = vtts;

  // Remove existing items (keep empty state)
  listEl.querySelectorAll(".vtt-item").forEach((el) => el.remove());

  if (vtts.length === 0) {
    emptyEl.style.display = "flex";
    emptyEl.querySelector("p").textContent =
      "No VTT files detected on this page.";
    emptyEl.querySelector(".icon").textContent = "📭";
    badgeEl.classList.remove("visible");
    scanStatusEl.textContent = "No VTT files found";
    btnDownloadAll.disabled = true;
    return;
  }

  emptyEl.style.display = "none";
  badgeEl.textContent = vtts.length;
  badgeEl.classList.add("visible");
  scanStatusEl.textContent = `${vtts.length} VTT file${vtts.length !== 1 ? "s" : ""} found`;
  btnDownloadAll.disabled = false;

  for (const url of vtts) {
    const item = document.createElement("div");
    item.className = "vtt-item";
    item.dataset.url = url;

    const info = document.createElement("div");
    info.className = "vtt-info";

    const name = document.createElement("div");
    name.className = "vtt-name";
    name.textContent = filenameFromUrl(url);
    name.title = url;

    const src = document.createElement("div");
    src.className = "vtt-source";

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "VTT";

    src.appendChild(tag);
    src.appendChild(document.createTextNode(sourceLabel(url)));

    info.appendChild(name);
    info.appendChild(src);

    const btn = document.createElement("button");
    btn.className = "btn-download";
    btn.textContent = "Download";
    btn.addEventListener("click", () => downloadVtt(url, btn));

    item.appendChild(info);
    item.appendChild(btn);
    listEl.appendChild(item);
  }
}

function downloadVtt(url, btn) {
  const filename = filenameFromUrl(url);

  // Use chrome.downloads if available, otherwise fallback to anchor trick
  if (api.downloads) {
    api.downloads.download({ url, filename, saveAs: false }, () => {
      if (api.runtime.lastError) {
        fallbackDownload(url, filename);
        return;
      }
      if (btn) {
        btn.textContent = "✓ Saved";
        btn.classList.add("downloaded");
      }
      footerStatusEl.textContent = `Downloaded ${filename}`;
    });
  } else {
    fallbackDownload(url, filename);
    if (btn) {
      btn.textContent = "✓ Saved";
      btn.classList.add("downloaded");
    }
  }
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

function downloadAll() {
  currentVtts.forEach((url, i) => {
    setTimeout(() => {
      const item = listEl.querySelector(`.vtt-item[data-url="${CSS.escape(url)}"]`);
      const btn = item?.querySelector(".btn-download");
      downloadVtt(url, btn);
    }, i * 300); // stagger downloads slightly
  });
}

async function loadVtts() {
  if (currentTabId == null) return;
  scanStatusEl.innerHTML = '<span class="spinner"></span>Scanning…';

  return new Promise((resolve) => {
    api.runtime.sendMessage(
      { type: "get_vtts", tabId: currentTabId },
      (response) => {
        if (api.runtime.lastError || !response) {
          renderList([]);
          resolve();
          return;
        }
        renderList(response.urls || []);
        resolve();
      }
    );
  });
}

async function rescan() {
  if (currentTabId == null) return;
  scanStatusEl.innerHTML = '<span class="spinner"></span>Rescanning…';
  footerStatusEl.textContent = "";
  btnRescan.disabled = true;

  // Clear stored VTTs for this tab
  await new Promise((resolve) => {
    api.runtime.sendMessage(
      { type: "clear_vtts", tabId: currentTabId },
      () => resolve()
    );
  });

  // Tell content script to re-run its scan
  api.tabs.sendMessage(
    currentTabId,
    { type: "rescan" },
    () => { if (api.runtime.lastError) {} }
  );

  // Wait a moment for the scan to complete, then refresh
  setTimeout(async () => {
    await loadVtts();
    btnRescan.disabled = false;
  }, 800);
}

// Listen for background updates while popup is open
api.runtime.onMessage.addListener((message) => {
  if (message.type === "vtt_updated" && message.tabId === currentTabId) {
    loadVtts();
  }
});

btnDownloadAll.addEventListener("click", downloadAll);
btnRescan.addEventListener("click", rescan);

// Init
api.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  if (!tabs || tabs.length === 0) return;
  currentTabId = tabs[0].id;
  await loadVtts();
});
