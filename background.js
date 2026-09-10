importScripts('lib/metadata.js', 'lib/worker-state.js');

// Connection policy: Fetchr is only contacted while a popup is open or a request is pending.
// Idle browser = no socket. State survives worker restarts through lib/worker-state.js.

const RESOLVE_ERROR_TTL_MS = 30_000;
const ACK_TIMEOUT_MS = 10_000;
const CONNECT_WAIT_MS = 5_000;
const RECONNECT_DELAY_MS = 5_000;
const POPUP_PORT = 'popup';

const TOPICS = {
  Register: 'download::register',
  Cancel: 'download::cancel',
  Remove: 'download::remove',
  Clear: 'download::clear',
  Update: 'download::update',
  Registered: 'download::registered',
  Progress: 'download::progress',
  Suspended: 'download::suspended',
  Completed: 'download::completed',
  Failed: 'download::failed',
  Canceled: 'download::canceled',
  Removed: 'download::removed',
  Updated: 'download::updated',
  List: 'download::list',
  Plugins: 'settings::plugins',
  Ack: 'ack',
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
  TOPICS.Updated,
];

let ws = null;
let reconnectTimer = null;
const pendingRequests = new Map(); // requestId -> resolve(ack)
const pluginsWaiters = [];
const popupPorts = new Set();
const resolvingInFlight = new Set();
const ready = restoreState();

async function getConfig() {
  const { apiUrl, apiKey } = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  return apiUrl && apiKey ? { apiUrl, apiKey } : null;
}

// --- WebSocket lifecycle ---

const isWsConnected = () => ws?.readyState === WebSocket.OPEN;
const connectionWanted = () => popupPorts.size > 0 || pendingRequests.size > 0 || pluginsWaiters.length > 0;

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const config = await getConfig();
  if (!config) return;

  // Chrome WebSocket doesn't support custom headers; the server accepts `?apiKey=…` too.
  const base = config.apiUrl.replace(/^http/, 'ws');
  const socket = new WebSocket(`${base}${base.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(config.apiKey)}`);
  ws = socket;

  socket.onopen = () => {
    console.log('[Fetchr Grab] WebSocket connected');
    wsSend({ topic: 'subscribe', payload: { topics: EVENT_SUBSCRIPTIONS } });
  };
  socket.onmessage = (event) => {
    try {
      handleWsMessage(JSON.parse(event.data));
    } catch (e) {
      console.warn('[Fetchr Grab] Invalid WS message', e);
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    if (!connectionWanted()) return;
    console.log('[Fetchr Grab] WebSocket disconnected, retrying in 5s');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };
  socket.onerror = () => socket.close();
}

function disconnectIfIdle() {
  if (connectionWanted() || !ws) return;
  clearTimeout(reconnectTimer);
  const socket = ws;
  ws = null;
  socket.close();
  console.log('[Fetchr Grab] WebSocket closed (idle)');
}

function waitForConnection() {
  if (isWsConnected()) return Promise.resolve(true);
  void connect();
  const deadline = Date.now() + CONNECT_WAIT_MS;
  return new Promise((resolve) => {
    const tick = () => {
      if (isWsConnected()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function wsSend(data) {
  if (!isWsConnected()) return false;
  ws.send(JSON.stringify(data));
  return true;
}

// Sends a scoped event with a requestId and resolves with Fetchr's `ack` payload.
async function wsRequest(topic, payload) {
  const requestId = crypto.randomUUID();
  const ack = await new Promise((resolve) => {
    const timer = setTimeout(() => settleAck({ requestId, ok: false, error: 'Timeout waiting for fetchr' }), ACK_TIMEOUT_MS);
    pendingRequests.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    waitForConnection().then((connected) => {
      if (connected) wsSend({ topic, payload, requestId });
      else settleAck({ requestId, ok: false, error: 'Not connected to fetchr' });
    });
  });
  disconnectIfIdle();
  return ack;
}

function settleAck(ack) {
  const resolve = pendingRequests.get(ack?.requestId);
  if (!resolve) return;
  pendingRequests.delete(ack.requestId);
  resolve(ack);
}

// --- Inbound events ---

function handleWsMessage({ topic, payload }) {
  if (!topic) return;

  if (topic === TOPICS.Ack) return settleAck(payload);

  if (topic === TOPICS.List) {
    state.downloads = new Map(payload.map((dl) => [dl.id, dl]));
    schedulePersist();
    broadcastToPopup('WS_LIST', { downloads: Object.fromEntries(state.downloads) });
    return;
  }

  if (topic === TOPICS.Plugins) {
    setPlugins(payload);
    for (const resolve of pluginsWaiters.splice(0)) resolve(payload);
    broadcastToPopup('WS_PLUGINS', { plugins: payload });
    broadcastToTabs('PLUGINS_READY', { hosts: payload?.hosts ?? [] });
    disconnectIfIdle();
    return;
  }

  if (topic === TOPICS.Registered) {
    state.downloads.set(payload.id, payload);
  } else if (topic === TOPICS.Canceled || topic === TOPICS.Removed) {
    state.downloads.delete(payload.id);
  } else {
    const prev = state.downloads.get(payload.id);
    if (prev) {
      const patch = { ...prev, ...payload };
      if (topic === TOPICS.Completed) patch.status = 'completed';
      if (topic === TOPICS.Failed) patch.status = 'failed';
      state.downloads.set(payload.id, patch);
    }
  }
  schedulePersist();
  broadcastToPopup('WS_EVENT', { topic, data: payload });
}

function broadcastToPopup(type, extra) {
  chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});
}

async function broadcastToTabs(type, extra) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type, ...extra }).catch(() => {});
    }
  } catch {
    // ignore
  }
}

// Plugins come from the persisted cache; only a cold install opens a socket for them.
function getPlugins() {
  if (state.plugins) return Promise.resolve(state.plugins);
  return new Promise((resolve) => {
    pluginsWaiters.push(resolve);
    void connect();
    setTimeout(() => {
      const idx = pluginsWaiters.indexOf(resolve);
      if (idx === -1) return;
      pluginsWaiters.splice(idx, 1);
      resolve({ hosts: [], archives: [] });
      disconnectIfIdle();
    }, CONNECT_WAIT_MS);
  });
}

// --- Link tracking ---

function tabLinkSet(tabId) {
  let set = state.linksByTab.get(tabId);
  if (!set) {
    set = new Set();
    state.linksByTab.set(tabId, set);
  }
  return set;
}

function buildLinkPayload(tabId) {
  const set = state.linksByTab.get(tabId);
  if (!set) return [];
  return [...set].map((url) => {
    const entry = state.resolvedByUrl.get(url);
    if (!entry) return { url };
    if ('error' in entry) return { url, error: entry.error };
    return { url, fileName: entry.fileName, size: entry.size };
  });
}

function broadcastLinks(tabId) {
  broadcastToPopup('LINKS_UPDATED', { tabId, links: buildLinkPayload(tabId) });
}

function tabsContainingUrl(url) {
  return [...state.linksByTab].filter(([, set]) => set.has(url)).map(([tabId]) => tabId);
}

function cacheResolveError(url, error) {
  state.resolvedByUrl.set(url, { error, expiresAt: Date.now() + RESOLVE_ERROR_TTL_MS });
}

// Plain HTTP: no socket needed to resolve a link.
async function resolveLink(url) {
  if (resolvingInFlight.has(url)) return;
  const cached = state.resolvedByUrl.get(url);
  if (cached && (!('error' in cached) || cached.expiresAt > Date.now())) return;
  resolvingInFlight.add(url);
  try {
    const config = await getConfig();
    if (!config) return cacheResolveError(url, 'No API config');
    const response = await fetch(`${config.apiUrl}/downloads/resolve?url=${encodeURIComponent(url)}`, {
      headers: { 'x-api-key': config.apiKey },
    });
    if (!response.ok) return cacheResolveError(url, `HTTP ${response.status}`);
    const info = await response.json();
    state.resolvedByUrl.set(url, { fileName: info.fileName, size: info.size });
  } catch (e) {
    cacheResolveError(url, e.message ?? 'resolve failed');
  } finally {
    resolvingInFlight.delete(url);
    schedulePersist();
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
  if (changed) {
    schedulePersist();
    broadcastLinks(tabId);
  }
}

function forgetTab(tabId) {
  if (state.linksByTab.delete(tabId)) schedulePersist();
}

chrome.tabs.onRemoved.addListener(forgetTab);

if (chrome.webNavigation) {
  const purge = (details) => {
    if (details.frameId !== 0) return;
    forgetTab(details.tabId);
    broadcastLinks(details.tabId);
  };
  chrome.webNavigation.onCommitted.addListener(purge);
  chrome.webNavigation.onHistoryStateUpdated.addListener(purge);
}

// --- Content scripts ---

// Tabs open before an install/update keep the previous (now orphaned) content scripts:
// inject the current ones so link detection keeps working without a page reload.
chrome.runtime.onInstalled.addListener(async () => {
  const scripts = chrome.runtime.getManifest().content_scripts ?? [];
  const files = scripts.flatMap((s) => s.js ?? []);
  if (files.length === 0) return;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id == null) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, files }).catch(() => {});
  }
});

// --- Popup presence drives the connection ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT) return;
  popupPorts.add(port);
  void ready.then(connect);
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
    disconnectIfIdle();
  });
});

// --- Message handlers ---

const handlers = {
  GET_STATE: () => ({ downloads: Object.fromEntries(state.downloads), connected: isWsConnected() }),
  GET_PLUGINS: () => getPlugins(),
  GET_PATTERNS: async () => ({ hosts: (await getPlugins())?.hosts ?? [] }),
  GET_LINKS: ({ tabId }) => ({ tabId, links: tabId != null ? buildLinkPayload(tabId) : [] }),
  LINKS_DETECTED: (msg, sender) => {
    const tabId = sender?.tab?.id ?? msg.tabId;
    if (tabId != null && Array.isArray(msg.urls)) ingestLinks(tabId, msg.urls);
    return { success: true };
  },
  DOWNLOAD: async (msg) => {
    const { cleanUrl, params } = extractCrnFlixParams(msg.url);
    const metadata = { ...msg.metadata, ...params };
    const payload = { url: cleanUrl, ...(Object.keys(metadata).length > 0 ? { metadata } : {}) };
    const ack = await wsRequest(TOPICS.Register, payload);
    if (!ack.ok) return { error: ack.error };
    state.downloads.set(ack.data.id, ack.data);
    schedulePersist();
    return ack.data;
  },
  UPDATE_METADATA: async ({ id, metadata }) => {
    const ack = await wsRequest(TOPICS.Update, { id, metadata });
    if (!ack.ok) return { error: ack.error };
    state.downloads.set(ack.data.id, ack.data);
    schedulePersist();
    return { success: true };
  },
  CANCEL: async ({ id }) => {
    state.downloads.delete(id);
    schedulePersist();
    const ack = await wsRequest(TOPICS.Cancel, { id });
    return ack.ok ? { success: true } : { error: ack.error };
  },
  REMOVE: async ({ id }) => {
    state.downloads.delete(id);
    schedulePersist();
    const ack = await wsRequest(TOPICS.Remove, { id });
    return ack.ok ? { success: true } : { error: ack.error };
  },
  CLEAR_COMPLETED: async () => {
    for (const [id, dl] of state.downloads) {
      if (['completed', 'failed'].includes(dl.status)) state.downloads.delete(id);
    }
    schedulePersist();
    const ack = await wsRequest(TOPICS.Clear, {});
    return ack.ok ? { success: true } : { error: ack.error };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  ready
    .then(() => handler(msg, sender))
    .then(sendResponse, (e) => sendResponse({ error: e?.message ?? String(e) }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  ws?.close();
  ws = null;
  if (connectionWanted()) void connect();
});
