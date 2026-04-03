const CRN_FLIX_PARAMS = ['crn-flix-request-id', 'tmdbid', 'imdbid'];
const DARKI_HOST = 'darki.zone';

function getCarryOverParams() {
  try {
    const currentUrl = new URL(window.location.href);
    const params = {};
    for (const param of CRN_FLIX_PARAMS) {
      const value = currentUrl.searchParams.get(param);
      if (value) {
        params[param] = value;
      }
    }
    return params;
  } catch {
    return {};
  }
}

function rewriteLink(link, params) {
  try {
    const url = new URL(link.href);
    if (url.hostname !== DARKI_HOST) {
      return;
    }
    let modified = false;
    for (const [key, value] of Object.entries(params)) {
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, value);
        modified = true;
      }
    }
    if (modified) {
      link.href = url.toString();
    }
  } catch {
    // skip malformed URLs
  }
}

function rewriteAllLinks(params) {
  const links = document.querySelectorAll(`a[href*="${DARKI_HOST}"]`);
  for (const link of links) {
    rewriteLink(link, params);
  }
}

function init() {
  const params = getCarryOverParams();
  if (Object.keys(params).length === 0) {
    return;
  }

  rewriteAllLinks(params);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        const links = node.matches?.(`a[href*="${DARKI_HOST}"]`)
          ? [node, ...node.querySelectorAll(`a[href*="${DARKI_HOST}"]`)]
          : node.querySelectorAll?.(`a[href*="${DARKI_HOST}"]`) ?? [];
        for (const link of links) {
          rewriteLink(link, params);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = window.location.href;
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      const newParams = getCarryOverParams();
      if (Object.keys(newParams).length > 0) {
        rewriteAllLinks(newParams);
      }
    }
  });
  urlObserver.observe(document, { childList: true, subtree: true });
}

init();
