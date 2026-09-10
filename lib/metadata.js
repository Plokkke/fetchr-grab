// CRN-Flix carries its context to the extension as query params on indexer links.
// The engine emits exactly these keys (see crn-flix-engine indexer-link.ts).
const CRN_FLIX_PARAMS = ['crn-flix-request-id', 'crn-flix-candidate-id', 'imdbid'];

// Splits a URL into the download URL and the CRN-Flix params it carried.
function extractCrnFlixParams(url) {
  const params = {};
  if (!url) return { cleanUrl: url, params };
  try {
    const parsed = new URL(url);
    for (const key of CRN_FLIX_PARAMS) {
      const value = parsed.searchParams.get(key);
      if (!value) continue;
      params[key] = value;
      parsed.searchParams.delete(key);
    }
    return { cleanUrl: parsed.toString(), params };
  } catch {
    return { cleanUrl: url, params };
  }
}
