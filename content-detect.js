// Watches the page for download links matching the fetchr host plugins and
// reports new URLs to the background service worker. Survives popup
// close/reopen and catches links injected after initial load.

(function () {
  const SEND_DEBOUNCE_MS = 300;
  const MAX_HAYSTACK = 500_000;

  let patterns = [];
  let anchorRegexes = [];
  let globalRegexes = [];
  const sent = new Set();

  let pendingTimer = null;
  const pendingBatch = new Set();

  function compilePatterns(hosts) {
    patterns = hosts.map((h) => h.urlPattern);
    anchorRegexes = patterns.map((p) => new RegExp(p));
    globalRegexes = patterns.map((p) => new RegExp(p, 'g'));
  }

  function matches(url) {
    return anchorRegexes.some((r) => r.test(url));
  }

  function collectFromDom() {
    if (anchorRegexes.length === 0) return [];
    const out = [];

    for (const a of document.querySelectorAll('a[href]')) {
      const url = a.href;
      if (matches(url)) out.push(url);
    }

    const haystacks = [
      document.body?.innerText ?? '',
      document.documentElement?.innerHTML ?? '',
    ];
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
    chrome.runtime.sendMessage({ type: 'LINKS_DETECTED', urls }).catch(() => {});
  }

  function scan() {
    queue(collectFromDom());
  }

  async function loadPatterns() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_PATTERNS' });
      const hosts = response?.hosts ?? [];
      if (hosts.length === 0) return false;
      compilePatterns(hosts);
      return true;
    } catch {
      return false;
    }
  }

  function startObserver() {
    const observer = new MutationObserver(() => scan());
    const root = document.body ?? document.documentElement;
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'PLUGINS_READY' && Array.isArray(msg.hosts)) {
      compilePatterns(msg.hosts);
      sent.clear();
      scan();
    }
  });

  (async function init() {
    const ready = await loadPatterns();
    startObserver();
    if (ready) scan();
  })();
})();
