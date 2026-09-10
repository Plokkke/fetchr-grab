const linksEl = document.getElementById('links');
const downloadsEl = document.getElementById('downloads');
const linkCountEl = document.getElementById('link-count');
const metadataEl = document.getElementById('metadata');
const downloadAllBtn = document.getElementById('download-all');
const clearCompletedBtn = document.getElementById('clear-completed');
const manualUrlEl = document.getElementById('manual-url');
const manualAddBtn = document.getElementById('manual-add');
const manualErrorEl = document.getElementById('manual-error');

let config = null;
let hostPatterns = [];
let detectedLinks = []; // [{ url, fileName?, size?, error? }]
let downloadsState = {};
let pageMetadata = {};
let activeMetadataKeys = new Set();
let currentTabId = null;

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  // The open port tells the worker a popup is showing: it keeps the Fetchr socket up until we close.
  chrome.runtime.connect({ name: 'popup' });

  const stored = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  if (!stored.apiUrl || !stored.apiKey) {
    linksEl.innerHTML = '<p class="empty">Configure API URL and Key in options</p>';
    return;
  }
  config = stored;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  pageMetadata = extractCrnFlixParams(tab?.url).params;
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
  privateBtn.onclick = () => downloadUrl(link.url, privateBtn, { ...getActiveMetadata(), private: 'true' });

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-sm btn-edit';
  editBtn.textContent = '✎';
  editBtn.title = 'Download with custom metadata';
  editBtn.onclick = () => toggleLinkEditor(item, link.url, btn);

  actions.append(btn, privateBtn, editBtn);
  item.appendChild(actions);

  updateLinkItem(item, link);
  return item;
}

function toggleLinkEditor(item, url, downloadBtn) {
  const open = item.querySelector('.metadata-editor');
  if (open) {
    open.remove();
    return;
  }
  item.appendChild(
    createMetadataEditor(getActiveMetadata(), {
      saveLabel: 'Download',
      onCancel: () => toggleLinkEditor(item, url, downloadBtn),
      onSave: async (metadata) => {
        await downloadUrl(url, downloadBtn, metadata);
        toggleLinkEditor(item, url, downloadBtn);
      },
    }),
  );
}

function updateLinkItem(item, link) {
  const nameEl = item.querySelector('.link-name');
  const sizeEl = item.querySelector('.link-size');
  const displayName = link.fileName ?? fallbackName(link.url);
  nameEl.textContent = displayName;
  nameEl.title = link.error ? `${link.url}\n${link.error}` : link.url;
  sizeEl.textContent = link.size != null ? formatSize(link.size) : '';
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

  const hasCompleted = entries.some((d) => TERMINAL_STATUSES.includes(d.status));
  clearCompletedBtn.style.display = hasCompleted ? 'block' : 'none';

  downloadsEl.querySelector('.empty')?.remove();
  const ids = new Set(entries.map((d) => d.id));
  for (const node of [...downloadsEl.querySelectorAll('.download-item')]) {
    if (!ids.has(node.dataset.id)) node.remove();
  }
  for (const dl of entries) {
    const existing = downloadItemNode(dl.id);
    existing ? updateDownloadItem(existing, dl) : downloadsEl.appendChild(createDownloadItem(dl, downloadHandlers));
  }
}

const downloadItemNode = (id) => downloadsEl.querySelector(`.download-item[data-id="${cssEscape(id)}"]`);

const downloadHandlers = {
  onCancel: (id) => forgetDownload('CANCEL', id),
  onRemove: (id) => forgetDownload('REMOVE', id),
  onEdit: (id) => toggleMetadataEditor(id),
};

function forgetDownload(type, id) {
  chrome.runtime.sendMessage({ type, id });
  delete downloadsState[id];
  renderDownloads();
}

function toggleMetadataEditor(id) {
  const item = downloadItemNode(id);
  const open = item?.querySelector('.metadata-editor');
  if (!item || open) {
    open?.remove();
    return;
  }
  item.appendChild(
    createMetadataEditor(downloadsState[id]?.metadata ?? {}, {
      pageMetadata: getActiveMetadata(),
      onCancel: () => toggleMetadataEditor(id),
      onSave: (metadata) => saveMetadata(id, metadata),
    }),
  );
}

async function saveMetadata(id, metadata) {
  const result = await chrome.runtime.sendMessage({ type: 'UPDATE_METADATA', id, metadata });
  if (result?.error) throw new Error(result.error);
  if (downloadsState[id]) downloadsState[id] = { ...downloadsState[id], metadata };
  toggleMetadataEditor(id);
  renderDownloads();
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

async function downloadUrl(url, btn, metadata = getActiveMetadata()) {
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'DOWNLOAD', url, metadata });
    if (result.error) throw new Error(result.error);
    downloadsState[result.id] = result;
    renderDownloads();
    btn.textContent = '✓';
    btn.classList.replace('btn-download', 'btn-secondary');
    btn.classList.replace('btn-private', 'btn-secondary');
  } catch (e) {
    btn.textContent = '✗';
    btn.title = e.message;
    btn.classList.replace('btn-download', 'btn-danger');
    btn.classList.replace('btn-private', 'btn-danger');
    throw e;
  }
}

async function downloadAll() {
  const items = [...linksEl.querySelectorAll('.link-item')];
  for (const item of items) {
    const url = item.dataset.url;
    const btn = item.querySelector('.btn-download');
    if (url && btn) await downloadUrl(url, btn).catch(() => {});
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
