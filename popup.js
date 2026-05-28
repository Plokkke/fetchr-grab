const linksEl = document.getElementById('links');
const downloadsEl = document.getElementById('downloads');
const linkCountEl = document.getElementById('link-count');
const metadataEl = document.getElementById('metadata');
const downloadAllBtn = document.getElementById('download-all');
const clearCompletedBtn = document.getElementById('clear-completed');
const manualUrlEl = document.getElementById('manual-url');
const manualAddBtn = document.getElementById('manual-add');
const manualErrorEl = document.getElementById('manual-error');

const CRN_FLIX_PARAMS = ['crn-flix-request-id', 'tmdbid', 'imdbid'];

let config = null;
let hostPatterns = [];
let detectedLinks = []; // [{ url, fileName?, size?, error? }]
let downloadsState = {};
let pageMetadata = {};
let activeMetadataKeys = new Set();
let currentTabId = null;

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  if (!stored.apiUrl || !stored.apiKey) {
    linksEl.innerHTML = '<p class="empty">Configure API URL and Key in options</p>';
    return;
  }
  config = stored;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  pageMetadata = extractPageMetadata(tab?.url);
  activeMetadataKeys = new Set(Object.keys(pageMetadata));
  renderMetadata();

  await loadPlugins();
  await loadLinks();
  await loadState();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'WS_EVENT') {
      handleWsEvent(msg.topic, msg.data);
    } else if (msg.type === 'WS_LIST') {
      downloadsState = msg.downloads ?? {};
      renderDownloads();
    } else if (msg.type === 'LINKS_UPDATED' && msg.tabId === currentTabId) {
      detectedLinks = msg.links ?? [];
      renderLinks();
    }
  });

  downloadAllBtn.addEventListener('click', downloadAll);
  clearCompletedBtn.addEventListener('click', clearCompleted);
  manualAddBtn.addEventListener('click', addManualLink);
  manualUrlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addManualLink();
  });
});

// --- Plugins & Link Detection ---

async function loadPlugins() {
  try {
    const data = await chrome.runtime.sendMessage({ type: 'GET_PLUGINS' });
    if (!data?.hosts) {
      linksEl.innerHTML = '<p class="empty">Waiting for Fetchr connection…</p>';
      return;
    }
    hostPatterns = data.hosts.map((h) => ({
      name: h.name,
      regex: new RegExp(h.urlPattern),
    }));
  } catch (e) {
    console.error('[Fetchr Grab] Failed to load plugins', e);
    linksEl.innerHTML = `<p class="empty">Failed to load plugins: ${e.message}</p>`;
  }
}

async function loadLinks() {
  if (currentTabId == null) return;
  const response = await chrome.runtime.sendMessage({ type: 'GET_LINKS', tabId: currentTabId });
  detectedLinks = response?.links ?? [];
  renderLinks();
}

function renderLinks() {
  linkCountEl.textContent = detectedLinks.length;

  if (detectedLinks.length === 0) {
    linksEl.innerHTML = '<p class="empty">No links detected on this page</p>';
    downloadAllBtn.style.display = 'none';
    return;
  }
  downloadAllBtn.style.display = detectedLinks.length > 1 ? 'block' : 'none';

  const byUrl = new Map();
  for (const link of detectedLinks) byUrl.set(link.url, link);

  // Remove items no longer present
  for (const node of [...linksEl.querySelectorAll('.link-item')]) {
    if (!byUrl.has(node.dataset.url)) node.remove();
  }
  // Clear empty placeholder
  const empty = linksEl.querySelector('.empty');
  if (empty) empty.remove();

  for (const link of detectedLinks) {
    let item = linksEl.querySelector(`.link-item[data-url="${cssEscape(link.url)}"]`);
    if (!item) {
      item = createLinkItem(link);
      linksEl.appendChild(item);
    } else {
      updateLinkItem(item, link);
    }
  }
}

function createLinkItem(link) {
  const item = document.createElement('div');
  item.className = 'link-item';
  item.dataset.url = link.url;

  const nameEl = document.createElement('span');
  nameEl.className = 'link-name';
  item.appendChild(nameEl);

  const sizeEl = document.createElement('span');
  sizeEl.className = 'link-size';
  item.appendChild(sizeEl);

  const actions = document.createElement('div');
  actions.className = 'link-actions';

  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-download';
  btn.textContent = 'Download';
  btn.onclick = () => downloadUrl(link.url, btn);

  const privateBtn = document.createElement('button');
  privateBtn.className = 'btn btn-sm btn-private';
  privateBtn.textContent = '🫥 Private';
  privateBtn.onclick = () => downloadUrl(link.url, privateBtn, { private: 'true' });

  actions.append(btn, privateBtn);
  item.appendChild(actions);

  updateLinkItem(item, link);
  return item;
}

function updateLinkItem(item, link) {
  const nameEl = item.querySelector('.link-name');
  const sizeEl = item.querySelector('.link-size');
  const displayName = link.fileName ?? fallbackName(link.url);
  nameEl.textContent = displayName;
  nameEl.title = link.error ? `${link.url}\n${link.error}` : link.url;
  sizeEl.textContent = link.size != null ? formatSize(link.size) : '';
}

function fallbackName(url) {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).pop() || u.host;
  } catch {
    return url;
  }
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return value.replace(/(["\\])/g, '\\$1');
}

// --- Downloads ---

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  downloadsState = response?.downloads ?? {};
  renderDownloads();
}

function handleWsEvent(topic, data) {
  if (!data?.id) return;

  if (topic === 'download::removed' || topic === 'download::canceled') {
    delete downloadsState[data.id];
    renderDownloads();
    return;
  }

  if (topic === 'download::registered') {
    downloadsState[data.id] = data;
    renderDownloads();
    return;
  }

  if (!downloadsState[data.id]) return;
  downloadsState[data.id] = { ...downloadsState[data.id], ...data };
  if (topic === 'download::completed') downloadsState[data.id].status = 'completed';
  if (topic === 'download::failed') downloadsState[data.id].status = 'failed';
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
    removeBtn.textContent = '✕';
    removeBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'REMOVE', id: dl.id });
      delete downloadsState[dl.id];
      renderDownloads();
    };
    header.appendChild(removeBtn);
  } else if (['downloading', 'queued', 'resolving', 'suspended'].includes(dl.status)) {
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
  if (['downloading', 'extracting', 'resolving', 'queued', 'suspended'].includes(dl.status)) {
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
    } else if (dl.status === 'suspended') {
      fill.classList.add('suspended');
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
  } else if (dl.status === 'suspended') {
    const label = document.createElement('span');
    const sizeStr = dl.size ? ` — ${formatSize(dl.size)}` : '';
    label.textContent = `Waiting for download slot${sizeStr}`;
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

function addManualLink() {
  manualErrorEl.style.display = 'none';
  const raw = manualUrlEl.value.trim();
  if (!raw) return;

  try {
    new URL(raw);
  } catch {
    showManualError('Invalid URL');
    return;
  }

  if (detectedLinks.some((l) => l.url === raw)) {
    showManualError('Link already in the list');
    return;
  }

  manualUrlEl.value = '';
  // Route through background so the link is cached, resolved, and persists.
  chrome.runtime.sendMessage({ type: 'LINKS_DETECTED', urls: [raw], tabId: currentTabId }).catch(() => {});
}

function showManualError(msg) {
  manualErrorEl.textContent = msg;
  manualErrorEl.style.display = 'block';
}

// --- Actions ---

async function downloadUrl(url, btn, metadata = {}) {
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD',
      url,
      metadata: { ...getActiveMetadata(), ...metadata },
    });
    if (result.error) throw new Error(result.error);
    downloadsState[result.id] = result;
    renderDownloads();
    btn.textContent = '✓';
    btn.classList.replace('btn-download', 'btn-secondary');
    btn.classList.replace('btn-private', 'btn-secondary');
  } catch (e) {
    btn.textContent = '✗';
    btn.classList.replace('btn-download', 'btn-danger');
    btn.classList.replace('btn-private', 'btn-danger');
  }
}

async function downloadAll() {
  const items = [...linksEl.querySelectorAll('.link-item')];
  for (const item of items) {
    const url = item.dataset.url;
    const btn = item.querySelector('.btn-download');
    if (url && btn) await downloadUrl(url, btn);
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
  if (!tabUrl) return metadata;
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

  metadataEl.style.display = 'flex';
  metadataEl.innerHTML = '';
  for (const [key, value] of entries) {
    const label = document.createElement('label');
    label.className = 'metadata-tag';
    if (!activeMetadataKeys.has(key)) label.classList.add('disabled');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = activeMetadataKeys.has(key);
    checkbox.dataset.key = key;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) activeMetadataKeys.add(key);
      else activeMetadataKeys.delete(key);
      label.classList.toggle('disabled', !checkbox.checked);
    });

    const text = document.createElement('span');
    text.textContent = `${key}: ${value}`;

    label.append(checkbox, text);
    metadataEl.appendChild(label);
  }
}

function getActiveMetadata() {
  const out = {};
  for (const key of activeMetadataKeys) {
    if (pageMetadata[key] != null) out[key] = pageMetadata[key];
  }
  return out;
}

// --- Formatters ---

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
