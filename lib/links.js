// Shared link helpers used by content-detect.js and popup.js.
// Exposed on `globalThis.FetchrLinks` so both contexts (no ES modules in MV3
// classic content scripts) can access them.

(function (root) {
  const ASSET_SUBDOMAINS = ['img', 'images', 'static', 'cdn', 'assets', 'media'];
  const ASSET_EXTENSIONS = /\.(ico|png|jpe?g|gif|svg|webp|css|woff2?|ttf)$/i;

  function isLikelyDownloadLink(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const firstLabel = parsed.hostname.split('.')[0].toLowerCase();
    if (ASSET_SUBDOMAINS.includes(firstLabel)) return false;
    if (!parsed.search && ASSET_EXTENSIONS.test(parsed.pathname)) return false;
    return true;
  }

  function normalizeUrl(url) {
    const trimmed = url.trim().replace(/[\s<>"']+$/, '');
    try {
      const u = new URL(trimmed);
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch {
      return trimmed;
    }
  }

  function dedupeLinks(urls) {
    const seen = new Set();
    const out = [];
    for (const url of urls) {
      const key = normalizeUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
    return out;
  }

  root.FetchrLinks = { isLikelyDownloadLink, normalizeUrl, dedupeLinks };
})(typeof globalThis !== 'undefined' ? globalThis : self);
