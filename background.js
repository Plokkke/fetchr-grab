let ws = null;
let downloads = new Map();
let plugins = null;
let reconnectTimer = null;
let pendingRequests = new Map();
let pluginsWaiters = [];

const linksByTab = new Map(); // tabId -> Set<url>
const resolvedByUrl = new Map(); // url -> { fileName, size } | { error, expiresAt }
const resolvingInFlight = new Set();
const RESOLVE_ERROR_TTL_MS = 30_000;

const CRN_FLIX_PARAMS = ['crn-flix-request-id', 'tmdbid', 'imdbid'];

const TOPICS = {
  Register: 'download::register',
  Cancel: 'download::cancel',
  Remove: 'download::remove',
  Clear: 'download::clear',
  Registered: 'download::registered',
  Progress: 'download::progress',
  Suspended: 'download::suspended',
  Completed: 'download::completed',
  Failed: 'download::failed',
  Canceled: 'download::canceled',
  Removed: 'download::removed',
  List: 'download::list',
  Plugins: 'settings::plugins',
};

const EVENT_SUBSCRIPTIONS = [
  TOPICS.List,
  TOPICS.Plugins,
  TOPICS.Registered,
  TOPICS.Progress,
  TOPICS.Suspended,
  TOPICS.Completed,
  TOPICS.Failed,
  TOPICS.Canceled,
  TOPICS.Removed,
];

function extractCrnFlixMetadata(url, extraMetadata = {}) {
  const metadata = { ...extraMetadata };
  try {
    const parsed = new URL(url);
    for (const param of CRN_FLIX_PARAMS) {
      const value = parsed.searchParams.get(param);
      if (value) {
        metadata[param] = value;
        parsed.searchParams.delete(param);
      }
    }
    return { cleanUrl: parsed.toString(), metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
  } catch {
    return { cleanUrl: url, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
  }
}

async function getConfig() {
  const { apiUrl, apiKey } = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  return apiUrl && apiKey ? { apiUrl, apiKey } : null;
}

function isWsConnected() {
  return ws?.readyState === WebSocket.OPEN;
}

// --- WebSocket ---

function connectWebSocket(apiUrl, apiKey) {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  // Chrome WebSocket doesn't support custom headers; fall back to query param auth.
  // The server is expected to accept `?apiKey=…` in addition to the `x-api-key` header.
  const base = apiUrl.replace(/^http/, 'ws');
  const wsUrl = `${base}${base.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(apiKey)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[Fetchr Grab] WebSocket connected');
    wsSend({ topic: 'subscribe', payload: { topics: EVENT_SUBSCRIPTIONS } });
  };

  ws.onmessage = (event) => {
    try {
      handleWsMessage(JSON.parse(event.data));
    } catch (e) {
      console.warn('[Fetchr Grab] Invalid WS message', e);
    }
  };

  ws.onclose = () => {
    console.log('[Fetchr Grab] WebSocket disconnected, reconnecting in 5s...');
    ws = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => initWebSocket(), 5000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

async function initWebSocket() {
  const config = await getConfig();
  if (config) connectWebSocket(config.apiUrl, config.apiKey);
}

function wsSend(data) {
  if (isWsConnected()) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function handleWsMessage({ topic, payload }) {
  if (!topic) return;

  // One-shot snapshot — replace the local cache.
  if (topic === TOPICS.List) {
    downloads.clear();
    for (const dl of payload) downloads.set(dl.id, dl);
    broadcastToPopup('WS_LIST', { downloads: Object.fromEntries(downloads) });
    return;
  }

  if (topic === TOPICS.Plugins) {
    plugins = payload;
    for (const resolve of pluginsWaiters) resolve(plugins);
    pluginsWaiters = [];
    broadcastToPopup('WS_PLUGINS', { plugins: payload });
    broadcastToTabs('PLUGINS_READY', { hosts: payload?.hosts ?? [] });
    return;
  }

  // New item — resolve any pending register, add to cache.
  if (topic === TOPICS.Registered) {
    downloads.set(payload.id, payload);
    const resolve = pendingRequests.get('register');
    if (resolve) {
      resolve(payload);
      pendingRequests.delete('register');
    }
    broadcastToPopup('WS_EVENT', { topic, data: payload });
    return;
  }

  // Terminal removal
  if (topic === TOPICS.Canceled || topic === TOPICS.Removed) {
    downloads.delete(payload.id);
    broadcastToPopup('WS_EVENT', { topic, data: payload });
    return;
  }

  // In-flight updates
  if (topic === TOPICS.Progress || topic === TOPICS.Suspended) {
    const prev = downloads.get(payload.id);
    if (prev) downloads.set(payload.id, { ...prev, ...payload });
  } else if (topic === TOPICS.Completed) {
    const prev = downloads.get(payload.id);
    if (prev) downloads.set(payload.id, { ...prev, ...payload, status: 'completed' });
  } else if (topic === TOPICS.Failed) {
    const prev = downloads.get(payload.id);
    if (prev) downloads.set(payload.id, { ...prev, ...payload, status: 'failed' });
  }

  broadcastToPopup('WS_EVENT', { topic, data: payload });
}

function broadcastToPopup(type, extra) {
  chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});
}

async function broadcastToTabs(type, extra) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type, ...extra }).catch(() => {});
    }
  } catch {
    // ignore
  }
}

// --- Link tracking ---

function tabLinkSet(tabId) {
  let set = linksByTab.get(tabId);
  if (!set) {
    set = new Set();
    linksByTab.set(tabId, set);
  }
  return set;
}

function buildLinkPayload(tabId) {
  const set = linksByTab.get(tabId);
  if (!set) return [];
  return [...set].map((url) => {
    const entry = resolvedByUrl.get(url);
    if (!entry) return { url };
    if ('error' in entry) return { url, error: entry.error };
    return { url, fileName: entry.fileName, size: entry.size };
  });
}

function broadcastLinks(tabId) {
  broadcastToPopup('LINKS_UPDATED', { tabId, links: buildLinkPayload(tabId) });
}

function tabsContainingUrl(url) {
  const out = [];
  for (const [tabId, set] of linksByTab) {
    if (set.has(url)) out.push(tabId);
  }
  return out;
}

async function resolveLink(url) {
  if (resolvingInFlight.has(url)) return;
  const cached = resolvedByUrl.get(url);
  if (cached) {
    if ('error' in cached && cached.expiresAt > Date.now()) return;
    if (!('error' in cached)) return;
  }
  resolvingInFlight.add(url);
  try {
    const config = await getConfig();
    if (!config) {
      resolvedByUrl.set(url, { error: 'No API config', expiresAt: Date.now() + RESOLVE_ERROR_TTL_MS });
      return;
    }
    const response = await fetch(
      `${config.apiUrl}/downloads/resolve?url=${encodeURIComponent(url)}`,
      { headers: { 'x-api-key': config.apiKey } },
    );
    if (!response.ok) {
      resolvedByUrl.set(url, {
        error: `HTTP ${response.status}`,
        expiresAt: Date.now() + RESOLVE_ERROR_TTL_MS,
      });
      return;
    }
    const info = await response.json();
    resolvedByUrl.set(url, { fileName: info.fileName, size: info.size });
  } catch (e) {
    resolvedByUrl.set(url, {
      error: e.message ?? 'resolve failed',
      expiresAt: Date.now() + RESOLVE_ERROR_TTL_MS,
    });
  } finally {
    resolvingInFlight.delete(url);
    for (const tabId of tabsContainingUrl(url)) broadcastLinks(tabId);
  }
}

function ingestLinks(tabId, urls) {
  const set = tabLinkSet(tabId);
  let changed = false;
  for (const url of urls) {
    if (set.has(url)) continue;
    set.add(url);
    changed = true;
    void resolveLink(url);
  }
  if (changed) broadcastLinks(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  linksByTab.delete(tabId);
});

if (chrome.webNavigation) {
  const purge = (details) => {
    if (details.frameId !== 0) return;
    linksByTab.delete(details.tabId);
    broadcastLinks(details.tabId);
  };
  chrome.webNavigation.onCommitted.addListener(purge);
  chrome.webNavigation.onHistoryStateUpdated.addListener(purge);
}

// --- Popup message handler ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse({ downloads: Object.fromEntries(downloads), connected: isWsConnected() });
    return true;
  }

  if (msg.type === 'GET_PLUGINS') {
    if (plugins) {
      sendResponse(plugins);
    } else {
      pluginsWaiters.push(sendResponse);
      setTimeout(() => {
        const idx = pluginsWaiters.indexOf(sendResponse);
        if (idx !== -1) {
          pluginsWaiters.splice(idx, 1);
          sendResponse({ hosts: [], archives: [] });
        }
      }, 5000);
    }
    return true;
  }

  if (msg.type === 'GET_PATTERNS') {
    sendResponse({ hosts: plugins?.hosts ?? [] });
    return true;
  }

  if (msg.type === 'LINKS_DETECTED') {
    const tabId = sender?.tab?.id ?? msg.tabId;
    if (tabId != null && Array.isArray(msg.urls)) ingestLinks(tabId, msg.urls);
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'GET_LINKS') {
    const tabId = msg.tabId;
    sendResponse({ tabId, links: tabId != null ? buildLinkPayload(tabId) : [] });
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    if (!isWsConnected()) {
      sendResponse({ error: 'Not connected to fetchr' });
      return true;
    }
    const { cleanUrl, metadata } = extractCrnFlixMetadata(msg.url, msg.metadata);
    wsSend({ topic: TOPICS.Register, payload: { url: cleanUrl, ...(metadata ? { metadata } : {}) } });

    const promise = new Promise((resolve) => {
      pendingRequests.set('register', resolve);
      setTimeout(() => {
        if (pendingRequests.has('register')) {
          pendingRequests.delete('register');
          resolve({ error: 'Timeout waiting for register response' });
        }
      }, 10000);
    });
    promise.then(sendResponse);
    return true;
  }

  if (msg.type === 'CANCEL') {
    downloads.delete(msg.id);
    wsSend({ topic: TOPICS.Cancel, payload: { id: msg.id } });
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'REMOVE') {
    downloads.delete(msg.id);
    wsSend({ topic: TOPICS.Remove, payload: { id: msg.id } });
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'CLEAR_COMPLETED') {
    for (const [id, dl] of downloads) {
      if (['completed', 'failed', 'cancelled', 'canceled'].includes(dl.status)) downloads.delete(id);
    }
    wsSend({ topic: TOPICS.Clear, payload: {} });
    sendResponse({ success: true });
    return true;
  }
});

initWebSocket();
chrome.storage.onChanged.addListener(() => initWebSocket());
