let ws = null;
let downloads = new Map();
let reconnectTimer = null;
let pendingRequests = new Map();

async function getConfig() {
  const { apiUrl, apiKey } = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  return apiUrl && apiKey ? { apiUrl, apiKey } : null;
}

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
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
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
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function handleWsMessage({ event: eventType, data }) {
  if (eventType === 'download.list') {
    downloads.clear();
    for (const dl of data) {
      downloads.set(dl.id, dl);
    }
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse({ downloads: Object.fromEntries(downloads) });
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    const promise = new Promise((resolve) => {
      pendingRequests.set('download', resolve);
      wsSend({ type: 'download', url: msg.url });
      setTimeout(() => {
        if (pendingRequests.has('download')) {
          pendingRequests.delete('download');
          resolve({ error: 'Timeout waiting for download response' });
        }
      }, 10000);
    });
    promise.then(sendResponse);
    return true;
  }

  if (msg.type === 'CANCEL') {
    wsSend({ type: 'cancel', id: msg.id });
    downloads.delete(msg.id);
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'REMOVE') {
    wsSend({ type: 'remove', id: msg.id });
    downloads.delete(msg.id);
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'CLEAR_COMPLETED') {
    wsSend({ type: 'clear' });
    for (const [id, dl] of downloads) {
      if (['completed', 'failed', 'cancelled'].includes(dl.status)) downloads.delete(id);
    }
    sendResponse({ success: true });
    return true;
  }
});

initWebSocket();
chrome.storage.onChanged.addListener(() => initWebSocket());
