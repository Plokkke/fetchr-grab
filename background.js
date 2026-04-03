let ws = null;
let downloads = new Map();
let reconnectTimer = null;
let pendingRequests = new Map();

const CRN_FLIX_PARAMS = ['crn-flix-request-id', 'tmdbid', 'imdbid'];

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

function connectWebSocket(apiUrl) {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const wsUrl = apiUrl.replace(/^http/, 'ws');
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[Fetchr Grab] WebSocket connected');
    wsSend({
      type: 'subscribe',
      topics: ['download.progress', 'download.completed', 'download.failed', 'download.removed'],
    });
    wsSend({ type: 'list' });
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
  if (config) connectWebSocket(config.apiUrl);
}

function wsSend(data) {
  if (isWsConnected()) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function handleWsMessage({ event: eventType, data }) {
  if (eventType === 'download.list') {
    downloads.clear();
    for (const dl of data) downloads.set(dl.id, dl);
    broadcastToPopup('WS_LIST', { downloads: Object.fromEntries(downloads) });
    return;
  }

  if (eventType === 'download.started') {
    downloads.set(data.id, data);
    const resolve = pendingRequests.get('download');
    if (resolve) {
      resolve(data);
      pendingRequests.delete('download');
    }
    broadcastToPopup('WS_EVENT', { eventType, data });
    return;
  }

  if (eventType === 'error') {
    const resolve = pendingRequests.get('download');
    if (resolve) {
      resolve({ error: data.message });
      pendingRequests.delete('download');
    }
    return;
  }

  if (eventType === 'download.removed') {
    downloads.delete(data.id);
  } else if (eventType === 'download.progress') {
    if (!downloads.has(data.id)) return;
    downloads.set(data.id, { ...downloads.get(data.id), ...data });
  } else if (eventType === 'download.completed') {
    if (downloads.has(data.id)) {
      downloads.set(data.id, { ...downloads.get(data.id), ...data, status: 'completed' });
    }
  } else if (eventType === 'download.failed') {
    if (downloads.has(data.id)) {
      downloads.set(data.id, { ...downloads.get(data.id), ...data, status: 'failed' });
    }
  }

  broadcastToPopup('WS_EVENT', { eventType, data });
}

function broadcastToPopup(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

// --- REST fallback ---

async function restRequest(method, path, body) {
  const config = await getConfig();
  if (!config) throw new Error('Not configured');

  const options = {
    method,
    headers: { 'x-api-key': config.apiKey },
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${config.apiUrl}${path}`, options);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.statusText}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    if (isWsConnected()) {
      sendResponse({ downloads: Object.fromEntries(downloads) });
    } else {
      restRequest('GET', '/downloads')
        .then((list) => {
          downloads.clear();
          for (const dl of list) downloads.set(dl.id, dl);
          sendResponse({ downloads: Object.fromEntries(downloads) });
        })
        .catch(() => sendResponse({ downloads: {} }));
    }
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    const { cleanUrl, metadata } = extractCrnFlixMetadata(msg.url, msg.metadata);

    if (isWsConnected()) {
      wsSend({ type: 'download', url: cleanUrl, metadata });
      const promise = new Promise((resolve) => {
        pendingRequests.set('download', resolve);
        setTimeout(() => {
          if (pendingRequests.has('download')) {
            pendingRequests.delete('download');
            resolve({ error: 'Timeout waiting for download response' });
          }
        }, 10000);
      });
      promise.then(sendResponse);
    } else {
      restRequest('POST', '/downloads', { url: cleanUrl, metadata })
        .then((data) => {
          downloads.set(data.id, data);
          sendResponse(data);
        })
        .catch((e) => sendResponse({ error: e.message }));
    }
    return true;
  }

  if (msg.type === 'CANCEL') {
    downloads.delete(msg.id);
    if (isWsConnected()) {
      wsSend({ type: 'cancel', id: msg.id });
    } else {
      restRequest('DELETE', `/downloads/${msg.id}`).catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'REMOVE') {
    downloads.delete(msg.id);
    if (isWsConnected()) {
      wsSend({ type: 'remove', id: msg.id });
    } else {
      restRequest('DELETE', `/downloads/${msg.id}`).catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'CLEAR_COMPLETED') {
    for (const [id, dl] of downloads) {
      if (['completed', 'failed', 'cancelled'].includes(dl.status)) downloads.delete(id);
    }
    if (isWsConnected()) {
      wsSend({ type: 'clear' });
    } else {
      restRequest('DELETE', '/downloads/completed').catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }
});

initWebSocket();
chrome.storage.onChanged.addListener(() => initWebSocket());
