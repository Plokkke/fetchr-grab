let ws = null;
let downloads = new Map();
let reconnectTimer = null;

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
    sendSubscribe();
  };

  function sendSubscribe() {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'subscribe',
        topics: ['download.progress', 'download.completed', 'download.failed', 'download.removed']
      }));
    } else {
      setTimeout(sendSubscribe, 100);
    }
  }

  ws.onmessage = (event) => {
    try {
      const { event: eventType, data } = JSON.parse(event.data);
      handleWsEvent(eventType, data);
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

function handleWsEvent(eventType, data) {
  if (eventType === 'download.removed') {
    downloads.delete(data.id);
  } else if (downloads.has(data.id)) {
    const existing = downloads.get(data.id);
    if (eventType === 'download.progress') {
      downloads.set(data.id, { ...existing, ...data });
    } else if (eventType === 'download.completed') {
      downloads.set(data.id, { ...existing, ...data, status: 'completed' });
    } else if (eventType === 'download.failed') {
      downloads.set(data.id, { ...existing, ...data, status: 'failed' });
    }
  }

  chrome.runtime.sendMessage({ type: 'WS_EVENT', eventType, data }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse({ downloads: Object.fromEntries(downloads) });
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    handleDownload(msg.url).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'CANCEL') {
    handleCancel(msg.id).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'REMOVE') {
    downloads.delete(msg.id);
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'CLEAR_COMPLETED') {
    handleClearCompleted().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
});

async function handleDownload(url) {
  const config = await getConfig();
  if (!config) throw new Error('Not configured');

  const response = await fetch(`${config.apiUrl}/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
  const data = await response.json();
  downloads.set(data.id, data);
  return data;
}

async function handleCancel(id) {
  downloads.delete(id);

  const config = await getConfig();
  if (!config) throw new Error('Not configured');

  await fetch(`${config.apiUrl}/downloads/${id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': config.apiKey },
  }).catch(() => {});

  return { success: true };
}

async function handleClearCompleted() {
  const config = await getConfig();
  if (!config) throw new Error('Not configured');

  const response = await fetch(`${config.apiUrl}/downloads/completed`, {
    method: 'DELETE',
    headers: { 'x-api-key': config.apiKey },
  });

  if (!response.ok) throw new Error(`Clear failed: ${response.statusText}`);

  for (const [id, dl] of downloads) {
    if (['completed', 'failed', 'cancelled'].includes(dl.status)) downloads.delete(id);
  }

  return await response.json();
}

initWebSocket();
chrome.storage.onChanged.addListener(() => initWebSocket());
