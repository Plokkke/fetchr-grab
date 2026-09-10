// Service-worker state that must survive Chrome killing the worker (~30s idle).
// Everything lives in memory for speed and is mirrored to chrome.storage:
//   - session: downloads cache, detected links per tab, resolved link infos
//   - local:   Fetchr plugin list (stable, needed by content scripts at page load)

const SESSION_KEY = 'workerState';
const PLUGINS_KEY = 'plugins';
const PERSIST_DEBOUNCE_MS = 200;

const state = {
  downloads: new Map(), // id -> DownloadingInfos
  linksByTab: new Map(), // tabId -> Set<url>
  resolvedByUrl: new Map(), // url -> { fileName, size } | { error, expiresAt }
  plugins: null,
};

let persistTimer = null;

function serializeState() {
  return {
    downloads: [...state.downloads.entries()],
    linksByTab: [...state.linksByTab.entries()].map(([tabId, urls]) => [tabId, [...urls]]),
    resolvedByUrl: [...state.resolvedByUrl.entries()],
  };
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await chrome.storage.session.set({ [SESSION_KEY]: serializeState() });
    } catch (e) {
      console.warn('[Fetchr Grab] Persist failed', e);
    }
  }, PERSIST_DEBOUNCE_MS);
}

async function restoreState() {
  try {
    const [{ [SESSION_KEY]: session }, { [PLUGINS_KEY]: plugins }] = await Promise.all([
      chrome.storage.session.get(SESSION_KEY),
      chrome.storage.local.get(PLUGINS_KEY),
    ]);
    if (session) {
      state.downloads = new Map(session.downloads ?? []);
      state.linksByTab = new Map((session.linksByTab ?? []).map(([tabId, urls]) => [tabId, new Set(urls)]));
      state.resolvedByUrl = new Map(session.resolvedByUrl ?? []);
    }
    state.plugins = plugins ?? null;
  } catch (e) {
    console.warn('[Fetchr Grab] Restore failed', e);
  }
}

function setPlugins(plugins) {
  state.plugins = plugins;
  chrome.storage.local.set({ [PLUGINS_KEY]: plugins }).catch(() => {});
}
