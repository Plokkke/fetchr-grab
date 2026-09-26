# Fetchr Grab

Chrome extension (Manifest V3) that spots file-host links on the page you are browsing and sends them to [Fetchr](../fetchr) in one click, with live progress in the popup. On CRN-Flix links it also carries the engine's correlation parameters, so a hand-launched download is still identified and filed automatically.

## What it does

- **Detects links** — a content script scans every page (and later DOM changes) for URLs matching the `urlPattern` of Fetchr's host plugins. Asset-looking URLs are ignored and duplicates collapsed.
- **Resolves them** — each detected link is resolved through `GET /downloads/resolve` so the popup shows the real file name and size before downloading.
- **Sends them to Fetchr** — per link *Download* or *🫥 Private*, *Download all*, or paste a URL by hand.
- **Tracks downloads** — status, progress, speed and ETA for everything Fetchr knows, with *Cancel*, *Remove*, *Clear completed*.
- **Edits metadata** — key/value editor on a pending link or a running download (`download::update`).

## CRN-Flix handshake

Links shown by the engine's dashboards and Discord tickets carry query params. When the active tab's URL has any of them, the popup lists them as metadata (each one can be toggled off) and attaches them to the downloads it sends:

| Param | Meaning |
|---|---|
| `crn-flix-request-id` | Planner action id — the download resolves that action |
| `crn-flix-candidate-id` | Release id — a hand launch from the dashboard, no action behind it |
| `imdbid` | Lets the post-download pipeline identify the media |

The list lives in `lib/metadata.js` (`CRN_FLIX_PARAMS`) and must match what the engine emits (`crn-flix-engine/components/api/src/services/indexer-link.ts`).

**Private** adds `private: "true"`: the engine then files the media in its private tree instead of the shared library.

## Install

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select this folder.
2. Open the extension's options and set the **Fetchr API URL** (e.g. `https://fetchr.example.org`) and the **API key** (Fetchr's `API_KEY`).

After pulling changes, hit *Reload* on the extension card; the worker re-injects the content script into open tabs.

## How it works

| File | Role |
|---|---|
| `background.js` | Service worker: Fetchr WebSocket, request/ack, link resolution, per-tab link store |
| `content-detect.js` | Page scanner (initial pass + debounced `MutationObserver`) |
| `popup.*`, `download-item.js`, `metadata-editor.js` | Popup UI |
| `options.*` | API URL / key, stored in `chrome.storage.sync` |
| `lib/links.js` | URL filtering, normalisation, dedup (shared by content script and popup) |
| `lib/metadata.js` | CRN-Flix param extraction |
| `lib/worker-state.js` | Worker state mirrored to `chrome.storage` |
| `lib/format.js` | Size / speed / ETA formatting |

**No idle connection.** The worker opens the Fetchr socket only while a popup is open (a `popup` port) or a request is waiting for its `ack`, and closes it otherwise. Chrome kills idle MV3 workers after ~30 s, so downloads, detected links and resolutions are mirrored to `chrome.storage.session` and the plugin list to `chrome.storage.local`. Don't add a keep-alive or a background reconnect loop.

The socket authenticates with `?apiKey=` since browsers cannot set headers on a WebSocket upgrade; HTTP calls use the `x-api-key` header.

No build step and no test suite: plain scripts loaded as-is.
