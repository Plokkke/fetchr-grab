const linksEl = document.getElementById('links');
const downloadsEl = document.getElementById('downloads');
const linkCountEl = document.getElementById('link-count');
const metadataEl = document.getElementById('metadata');
const downloadAllBtn = document.getElementById('download-all');
const clearCompletedBtn = document.getElementById('clear-completed');

const CRN_FLIX_PARAMS = ['crn-flix-request-id', 'tmdbid', 'imdbid'];

let config = null;
let hostPatterns = [];
let detectedLinks = [];
let downloadsState = {};
let pageMetadata = {};

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  if (!stored.apiUrl || !stored.apiKey) {
    linksEl.innerHTML = '<p class="empty">Configure API URL and Key in options</p>';
    return;
  }
  config = stored;

  await loadPlugins();
  await scanPage();
  await loadState();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'WS_EVENT') {
      handleWsEvent(msg.eventType, msg.data);
    } else if (msg.type === 'WS_LIST') {
      downloadsState = msg.downloads ?? {};
      renderDownloads();
    }
  });

  downloadAllBtn.addEventListener('click', downloadAll);
  clearCompletedBtn.addEventListener('click', clearCompleted);
});

// --- Plugins & Link Detection ---

async function loadPlugins() {
  try {
    const response = await fetch(`${config.apiUrl}/downloads/plugins`, {
      headers: { 'x-api-key': config.apiKey },
    });
    const data = await response.json();
    hostPatterns = data.hosts.map((h) => ({
      name: h.name,
      regex: new RegExp(h.urlPattern),
    }));
  } catch (e) {
    console.error('[Fetchr Grab] Failed to load plugins', e);
    linksEl.innerHTML = `<p class="empty">Failed to connect to Fetchr: ${e.message}</p>`;
  }
}

async function scanPage() {
  if (hostPatterns.length === 0) {
    linksEl.innerHTML = '<p class="empty">No host plugins loaded</p>';
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  pageMetadata = extractPageMetadata(tab.url);
  renderMetadata();

  const patterns = hostPatterns.map((p) => p.regex.source);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (patternsArr) => {
      const regexes = patternsArr.map((p) => new RegExp(p));
      const allLinks = [...document.querySelectorAll('a[href]')].map((a) => a.href);
      const matched = allLinks.filter((href) => regexes.some((r) => r.test(href)));
      return [...new Set(matched)];
    },
    args: [patterns],
  });

  detectedLinks = result?.result ?? [];
  linkCountEl.textContent = detectedLinks.length;
  if (detectedLinks.length === 0) {
    linksEl.innerHTML = '<p class="empty">No links detected on this page</p>';
    downloadAllBtn.style.display = 'none';
    return;
  }

  downloadAllBtn.style.display = detectedLinks.length > 1 ? 'block' : 'none';
  await renderLinks();
}

async function renderLinks() {
  linksEl.innerHTML = '';
  for (const url of detectedLinks) {
    const item = document.createElement('div');
    item.className = 'link-item';

    const nameEl = document.createElement('span');
    nameEl.className = 'link-name';
    nameEl.textContent = extractFileName(url);
    nameEl.title = url;

    const actions = document.createElement('div');
    actions.className = 'link-actions';

    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-download';
    btn.textContent = 'Download';
    btn.onclick = () => downloadUrl(url, btn);

    const privateBtn = document.createElement('button');
    privateBtn.className = 'btn btn-sm btn-private';
    privateBtn.textContent = '\uD83E\uDEE5 Private';
    privateBtn.onclick = () => downloadUrl(url, privateBtn, { private: 'true' });

    actions.append(btn, privateBtn);
    item.append(nameEl, actions);
    linksEl.appendChild(item);
  }

  // Fetch file infos in background for display
  for (const url of detectedLinks) {
    fetchFileInfo(url);
  }
}

async function fetchFileInfo(url) {
  try {
    const response = await fetch(`${config.apiUrl}/infos?url=${encodeURIComponent(url)}`, {
      headers: { 'x-api-key': config.apiKey },
    });
    if (!response.ok) return;
    const info = await response.json();

    const items = linksEl.querySelectorAll('.link-item');
    for (const item of items) {
      const nameEl = item.querySelector('.link-name');
      if (nameEl.textContent === extractFileName(url) && info.fileName) {
        nameEl.textContent = info.fileName;
        nameEl.title = info.fileName;
        if (info.size) {
          let sizeEl = item.querySelector('.link-size');
          if (!sizeEl) {
            sizeEl = document.createElement('span');
            sizeEl.className = 'link-size';
            item.insertBefore(sizeEl, item.querySelector('.btn'));
          }
          sizeEl.textContent = formatSize(info.size);
        }
      }
    }
  } catch (e) {
    // silent fail for info fetch
  }
}

// --- Downloads ---

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  downloadsState = response?.downloads ?? {};
  renderDownloads();
}

function handleWsEvent(eventType, data) {
  if (!data?.id) return;

  if (eventType === 'download.removed') {
    delete downloadsState[data.id];
    renderDownloads();
    return;
  }

  if (eventType === 'download.started') {
    downloadsState[data.id] = data;
    renderDownloads();
    return;
  }

  if (!downloadsState[data.id]) return;
  downloadsState[data.id] = { ...downloadsState[data.id], ...data };
  if (eventType === 'download.completed') downloadsState[data.id].status = 'completed';
  if (eventType === 'download.failed') downloadsState[data.id].status = 'failed';
  renderDownloads();
}

function renderDownloads() {
  const entries = Object.values(downloadsState);
  if (entries.length === 0) {
    downloadsEl.innerHTML = '<p class="empty">No downloads</p>';
    clearCompletedBtn.style.display = 'none';
    return;
  }

  const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
  const hasCompleted = entries.some((d) => TERMINAL_STATUSES.includes(d.status));
  clearCompletedBtn.style.display = hasCompleted ? 'block' : 'none';

  downloadsEl.innerHTML = '';
  for (const dl of entries) {
    downloadsEl.appendChild(createDownloadItem(dl));
  }
}

function createDownloadItem(dl) {
  const item = document.createElement('div');
  item.className = 'download-item';

  // Header: name + status + action button
  const header = document.createElement('div');
  header.className = 'download-header';

  const name = document.createElement('span');
  name.className = 'download-name';
  name.textContent = dl.fileName || 'Resolving...';
  name.title = dl.fileName || '';

  const status = document.createElement('span');
  status.className = `download-status status-${dl.status}`;
  status.textContent = dl.status;

  header.append(name, status);

  // Action button
  const terminalStatuses = ['completed', 'failed', 'cancelled'];
  if (terminalStatuses.includes(dl.status)) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-sm btn-remove';
    removeBtn.textContent = '\u2715';
    removeBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'REMOVE', id: dl.id });
      delete downloadsState[dl.id];
      renderDownloads();
    };
    header.appendChild(removeBtn);
  } else if (dl.status === 'downloading' || dl.status === 'queued' || dl.status === 'resolving') {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-sm btn-danger';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'CANCEL', id: dl.id });
      delete downloadsState[dl.id];
      renderDownloads();
    };
    header.appendChild(cancelBtn);
  }

  item.appendChild(header);

  // Progress bar
  if (['downloading', 'extracting', 'resolving', 'queued'].includes(dl.status)) {
    const bar = document.createElement('div');
    bar.className = 'progress-bar';

    const fill = document.createElement('div');
    fill.className = 'progress-fill';

    if (dl.status === 'extracting' && dl.progress == null) {
      fill.classList.add('indeterminate', 'extracting');
    } else if (dl.status === 'extracting') {
      fill.classList.add('extracting');
      fill.style.width = `${(dl.progress ?? 0) * 100}%`;
    } else if (dl.status === 'downloading') {
      fill.classList.add('downloading');
      fill.style.width = `${(dl.progress ?? 0) * 100}%`;
    } else {
      fill.classList.add('indeterminate', 'downloading');
    }

    bar.appendChild(fill);
    item.appendChild(bar);
  }

  if (dl.status === 'completed') {
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = 'progress-fill completed';
    bar.appendChild(fill);
    item.appendChild(bar);
  }

  // Details: speed + ETA or error
  const details = document.createElement('div');
  details.className = 'download-details';

  if (dl.status === 'downloading') {
    const speedEl = document.createElement('span');
    speedEl.className = 'download-speed';
    speedEl.textContent = dl.speed ? formatSpeed(dl.speed) : '';

    const etaEl = document.createElement('span');
    etaEl.className = 'download-eta';
    etaEl.textContent = dl.eta ? `ETA ${formatEta(dl.eta)}` : '';

    const pctEl = document.createElement('span');
    pctEl.textContent = dl.progress != null ? `${Math.round(dl.progress * 100)}%` : '';

    details.append(pctEl, speedEl, etaEl);
  } else if (dl.status === 'extracting') {
    const label = document.createElement('span');
    label.textContent = dl.progress != null ? `Extracting ${Math.round(dl.progress * 100)}%` : 'Extracting...';
    details.appendChild(label);
  } else if (dl.status === 'failed' && dl.error) {
    const errorEl = document.createElement('span');
    errorEl.className = 'download-error';
    errorEl.textContent = dl.error;
    details.appendChild(errorEl);
  }

  if (details.children.length > 0) item.appendChild(details);
  return item;
}

// --- Actions ---

async function downloadUrl(url, btn, metadata = {}) {
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'DOWNLOAD', url, metadata: { ...pageMetadata, ...metadata } });
    if (result.error) throw new Error(result.error);
    downloadsState[result.id] = result;
    renderDownloads();
    btn.textContent = '\u2713';
    btn.classList.replace('btn-download', 'btn-secondary');
    btn.classList.replace('btn-private', 'btn-secondary');
  } catch (e) {
    btn.textContent = '\u2717';
    btn.classList.replace('btn-download', 'btn-danger');
    btn.classList.replace('btn-private', 'btn-danger');
  }
}

async function downloadAll() {
  const buttons = linksEl.querySelectorAll('.btn-download');
  for (let i = 0; i < detectedLinks.length; i++) {
    if (buttons[i]) await downloadUrl(detectedLinks[i], buttons[i]);
  }
}

async function clearCompleted() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_COMPLETED' });
  for (const [id, dl] of Object.entries(downloadsState)) {
    if (dl.status === 'completed' || dl.status === 'failed') delete downloadsState[id];
  }
  renderDownloads();
}

// --- Metadata ---

function extractPageMetadata(tabUrl) {
  const metadata = {};
  try {
    const url = new URL(tabUrl);
    for (const param of CRN_FLIX_PARAMS) {
      const value = url.searchParams.get(param);
      if (value) {
        metadata[param] = value;
      }
    }
  } catch {
    // not a valid URL
  }
  return metadata;
}

function renderMetadata() {
  if (!metadataEl) return;

  const entries = Object.entries(pageMetadata);
  if (entries.length === 0) {
    metadataEl.style.display = 'none';
    return;
  }

  metadataEl.style.display = 'block';
  metadataEl.innerHTML = '';
  for (const [key, value] of entries) {
    const tag = document.createElement('span');
    tag.className = 'metadata-tag';
    tag.textContent = `${key}: ${value}`;
    metadataEl.appendChild(tag);
  }
}

// --- Formatters ---

function extractFileName(url) {
  const match = url.match(/\?([^&]+)/);
  return match ? match[1] : url.split('/').pop() || url;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatEta(seconds) {
  if (seconds < 60) return '< 1m';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
