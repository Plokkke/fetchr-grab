// Watches the page for download links matching the fetchr host plugins and
// reports new URLs to the background service worker. Survives popup
// close/reopen and catches links injected after initial load.
//
// The initial pass scans the whole document; afterwards only the DOM subtrees
// touched by mutations are scanned, in one debounced batch.

(function () {
  const SEND_DEBOUNCE_MS = 300;
  const SCAN_DEBOUNCE_MS = 300;
  const MAX_HAYSTACK = 500_000;

  let patterns = [];
  let anchorRegexes = [];
  let globalRegexes = [];
  const sent = new Set();

  let pendingTimer = null;
  const pendingBatch = new Set();

  let scanTimer = null;
  let fullScanPending = false;
  const dirtyRoots = new Set();

  let observer = null;
  let orphaned = false;

  // After an extension reload this script is orphaned: its chrome.runtime is gone and
  // sendMessage throws synchronously. Stop everything; the worker re-injects a fresh copy.
  function teardown() {
    orphaned = true;
    observer?.disconnect();
    observer = null;
    clearTimeout(pendingTimer);
    clearTimeout(scanTimer);
    pendingTimer = null;
    scanTimer = null;
  }

  async function send(message) {
    try {
      if (!chrome.runtime?.id) throw new Error('Extension context invalidated');
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      if (/context invalidated/i.test(e?.message ?? '')) teardown();
      return undefined;
    }
  }

  function compilePatterns(hosts) {
    patterns = hosts.map((h) => h.urlPattern);
    anchorRegexes = patterns.map((p) => new RegExp(p));
    globalRegexes = patterns.map((p) => new RegExp(p, 'g'));
  }

  function matches(url) {
    return anchorRegexes.some((r) => r.test(url));
  }

  function collectFrom(root) {
    if (anchorRegexes.length === 0 || !root) return [];
    const out = [];

    const anchors = [...root.querySelectorAll('a[href]')];
    if (root.matches?.('a[href]')) anchors.push(root);
    for (const a of anchors) {
      if (matches(a.href)) out.push(a.href);
    }

    const haystacks = [root.innerText ?? '', root.innerHTML ?? ''];
    for (const text of haystacks) {
      if (!text) continue;
      const slice = text.length > MAX_HAYSTACK ? text.slice(0, MAX_HAYSTACK) : text;
      for (const r of globalRegexes) {
        r.lastIndex = 0;
        const found = slice.match(r);
        if (found) for (const m of found) out.push(m);
      }
    }

    return out;
  }

  function queue(urls) {
    let added = false;
    for (const raw of urls) {
      const url = FetchrLinks.normalizeUrl(raw);
      if (sent.has(url)) continue;
      if (!FetchrLinks.isLikelyDownloadLink(url)) continue;
      sent.add(url);
      pendingBatch.add(url);
      added = true;
    }
    if (added) scheduleFlush();
  }

  function scheduleFlush() {
    if (pendingTimer) return;
    pendingTimer = setTimeout(flush, SEND_DEBOUNCE_MS);
  }

  function flush() {
    pendingTimer = null;
    if (pendingBatch.size === 0) return;
    const urls = [...pendingBatch];
    pendingBatch.clear();
    void send({ type: 'LINKS_DETECTED', urls });
  }

  function scheduleScan({ full = false } = {}) {
    if (orphaned) return;
    if (full) fullScanPending = true;
    if (scanTimer) return;
    scanTimer = setTimeout(runScan, SCAN_DEBOUNCE_MS);
  }

  function runScan() {
    scanTimer = null;
    if (fullScanPending) {
      fullScanPending = false;
      dirtyRoots.clear();
      queue(collectFrom(document.documentElement));
      return;
    }
    const roots = [...dirtyRoots];
    dirtyRoots.clear();
    for (const root of roots) {
      if (root.isConnected) queue(collectFrom(root));
    }
  }

  function markDirty(node) {
    const root = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (root) dirtyRoots.add(root);
  }

  async function loadPatterns() {
    const response = await send({ type: 'GET_PATTERNS' });
    const hosts = response?.hosts ?? [];
    if (hosts.length === 0) return false;
    compilePatterns(hosts);
    return true;
  }

  function startObserver() {
    if (orphaned) return;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') markDirty(mutation.target);
        for (const node of mutation.addedNodes) markDirty(node);
      }
      if (dirtyRoots.size > 0) scheduleScan();
    });
    const root = document.body ?? document.documentElement;
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'PLUGINS_READY' && Array.isArray(msg.hosts)) {
      compilePatterns(msg.hosts);
      sent.clear();
      scheduleScan({ full: true });
    }
  });

  (async function init() {
    const ready = await loadPatterns();
    startObserver();
    if (ready) scheduleScan({ full: true });
  })();
})();
