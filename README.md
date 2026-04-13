# Road View

A WebView app for the Even Realities G2 smart glasses that streams live WSDOT highway camera feeds directly to the display. Users browse cameras by highway, scroll through a list of cameras, and tap to fetch and view the latest snapshot.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Packaging for Even Hub](#packaging-for-even-hub)
- [Project Structure](#project-structure)
- [Architecture Overview](#architecture-overview)
- [Views and Navigation](#views-and-navigation)
- [SDK Quirks and Gotchas](#sdk-quirks-and-gotchas)
- [Image Pipeline](#image-pipeline)
- [Full Image View](#full-image-view)
- [Event System](#event-system)
- [Caching Strategy](#caching-strategy)
- [Dev Mode vs Production](#dev-mode-vs-production)
- [Adding New Camera Sources](#adding-new-camera-sources)
- [Debug Panel](#debug-panel)

---

## Getting Started

**Prerequisites:** Node.js, the Even Hub CLI, and a WSDOT API access code (free at [wsdot.wa.gov/traffic/api](https://wsdot.wa.gov/traffic/api/)).

```bash
npm install

# Dev mode — hot reload via QR code on the glasses
npm run dev        # start Vite dev server on 0.0.0.0:5173
npm run qr         # generate QR code to sideload onto glasses

# Production build
npm run build      # output to dist/
```

To sideload for dev: open the Even App on your phone, tap the QR scan button, and scan the code printed by `npm run qr`. The glasses will load the page from your local dev server.

For a production release, see [Packaging for Even Hub](#packaging-for-even-hub) below.

---

## Packaging for Even Hub

To submit a build for testing on the Even Hub platform:

```bash
npm run build
evenhub pack app.json dist -o roadview.ehpk
```

This produces a `roadview.ehpk` file ready for upload. Key `app.json` fields validated during packing:

| Field | Value | Notes |
| --- | --- | --- |
| `package_id` | `com.natealmanza.roadview` | Reverse-domain, lowercase letters/numbers only |
| `edition` | `202601` | Current Even Hub edition |
| `entrypoint` | `index.html` | Must exist in `dist/` after build |
| `min_sdk_version` | `0.0.9` | Matches `@evenrealities/even_hub_sdk` dependency |
| `supported_languages` | `["en"]` | Required by spec |
| `permissions` | network whitelist | All camera image origins must be listed |

See the [Even Hub packaging reference](https://hub.evenrealities.com/docs/reference/packaging) for the full spec.

---

## Project Structure

```text
Road-View/
├── .gitignore         # Excludes node_modules, dist, .ehpk, OS files
├── app.json           # Even App manifest — network whitelist, package ID, entrypoint
├── vite.config.js     # Dev server + proxy rules for network bypass
├── index.html         # Setup UI (access code input, buttons, debug panel)
├── src/
│   ├── main.ts        # App state machine and event routing
│   ├── api.ts         # WSDOT API fetch + image download pipeline + caching
│   ├── glasses.ts     # Even SDK bridge, page builders, event listener
│   ├── debug.ts       # In-app debug log panel
│   ├── types.ts       # Shared types, state shape, container IDs, constants
│   └── vite-env.d.ts  # Triple-slash reference for import.meta.env types
└── docs/
    ├── ROADMAP.md           # Design spec, state descriptions, planned features
    ├── IMAGE-RENDERING.md   # What image formats work / fail on G2 hardware
    └── EVEN-HUB.md          # Even Hub SDK reference notes
```

---

## Architecture Overview

The app is a standard Vite + TypeScript WebView. The Even Realities G2 glasses render this page inside a restricted WebView. All interaction with the glasses hardware goes through the **Even App Bridge** — a JS ↔ native SDK provided by `@evenrealities/even_hub_sdk`.

```text
index.html (setup UI)
    │
    └── main.ts  ←  state machine
         ├── api.ts       fetch WSDOT cameras / images
         ├── glasses.ts   SDK bridge, page rendering, event listener
         └── debug.ts     log() helper
```

State is a plain discriminated union (`AppState` in `types.ts`). Every glasses event flows through `handleGlassesEvent()` in `main.ts`, which reads the current state and transitions accordingly.

---

## Views and Navigation

There are three views rendered on the glasses display. The WebView UI itself is only used for initial setup.

### 1. Highway List (`highway-list`)

A paginated SDK list container showing all highways that have active cameras (e.g. `I-5`, `SR-99`). Uses `ListContainerProperty` with `isEventCapture: 1`.

- **Select an item** — enter Camera Browse for that highway
- **Next / Prev Page** items appear automatically when there are more highways than `LIST_PAGE_SIZE` (18)
- Pagination labels: `→ Next Page` / `← Prev Page`

List containers have a hard SDK limit of **20 items**. With `LIST_PAGE_SIZE = 18`, worst case is `PREV(1) + 18 + NEXT(1) = 20`.

Pagination navigation uses **position-based detection** in addition to string matching: if the first item is selected and `hasPrev` is true, it is always the prev button regardless of the resolved string. This avoids issues with Unicode arrow characters being stripped or mangled by the SDK.

### 2. Camera Browse (`camera-browse`)

A text-based view showing the selected highway, camera position (`Camera N / Total`), camera title, and camera ID. Uses two `TextContainerProperty` containers:

- **ID 1** — invisible full-screen event capture layer (`isEventCapture: 1`)
- **ID 2** — visible display text

| Input | Action |
| --- | --- |
| Scroll up/down | Navigate to prev/next camera (updates text via `textContainerUpgrade`) |
| Single tap | Fetch image → enter Camera View |
| Double tap | Back to Highway List |

`textContainerUpgrade` is used for scroll navigation because it updates only the text content without rebuilding the entire page layout — much faster than a full `rebuildPageContainer`.

### 3. Camera View (`camera-view`)

Shows the fetched camera image centered on the 576×288 canvas. Uses two containers:

- **ID 1** — invisible full-screen text event capture layer
- **ID 2** — image container (`ImageContainerProperty`)

Image containers have no event capture capability, so the text container behind it handles all input.

| Input | Action |
| --- | --- |
| Scroll up/down | Move to prev/next camera; fetch image after 1 s debounce |
| Single tap | Force-refresh current camera (bypasses cache) |
| Double tap | Back to Camera Browse |

Scroll debounce (`scheduleImageFetch`) waits 1 second after the last scroll event before hitting the network, so rapid scrolling doesn't fire a request per frame.

---

## SDK Quirks and Gotchas

### Page initialization

`createStartUpPageContainer` can only be called **once per glasses session**. If called again (e.g. after a page reload), it returns code `1`. The `setPage()` helper in `glasses.ts` tracks a `_initialized` flag to fall through to `rebuildPageContainer` on all subsequent calls.

### Container IDs

Container IDs must be contiguous starting from 1 and must not exceed `containerTotalNum`. The image container **must be ID 2** (not 3) when `containerTotalNum = 2`.

```typescript
// types.ts
export const CONTAINER = {
  EVENT_TEXT: 1,   // always present
  DISPLAY_TEXT: 2, // camera browse only
  IMAGE: 2,        // camera view only — shares ID with DISPLAY_TEXT, never coexist
}
```

### Click events arrive as `sysEvent`, not `textEvent`

Scroll events (`SCROLL_TOP_EVENT`, `SCROLL_BOTTOM_EVENT`) arrive in the `textEvent` field. However, single tap and double-tap from the G2 ring arrive in `sysEvent`:

```text
Single tap:   { jsonData: {},            sysEvent: {} }
Double tap:   { jsonData: {eventType:3}, sysEvent: {eventType:3} }
```

`CLICK_EVENT = 0` is falsy in JavaScript, so it is omitted from the serialized JSON entirely. The event handler in `glasses.ts` defaults to `CLICK_EVENT` when the field is absent from `sysEvent`.

### Manual double-tap detection

`DOUBLE_CLICK_EVENT` (value `3`) may not always fire reliably from the hardware ring. Road View implements a fallback: two `CLICK_EVENT`s within 500 ms are promoted to `double-click`. If the hardware does send `DOUBLE_CLICK_EVENT`, it is handled directly and the manual timer is reset.

### List item name is often empty

The `currentSelectItemName` field from `listEvent` frequently arrives as an empty string. The event handler reconstructs the same `pageItems` array that was used to build the list and uses `currentSelectItemIndex` for lookup instead.

---

## Image Pipeline

Camera images from WSDOT (and third-party cameras in their API) are JPEGs served from external origins. The G2 SDK requires images as `number[]` — specifically PNG file bytes passed as a plain JS array.

```text
fetch(imageURL)
  → Response.blob()
  → URL.createObjectURL(blob)
  → new Image() loaded from objectURL
  → draw onto canvas
  → canvas.toBlob('image/png')
  → blob.arrayBuffer()
  → Array.from(new Uint8Array(arrayBuffer))  ← sent to the SDK
  → bridge.updateImageRawData({ containerID, containerName, imageData })
```

**Why PNG via canvas?** The glasses display is 4-bit grayscale. PNG compresses a 200×100 frame to ~3–8 KB (~5,000–8,000 numbers), which fits within the JS-to-native bridge message limit. Raw RGBA (`165,888` numbers) overflows the bridge and produces corrupt output.

**Why `toBlob` instead of `toDataURL`?** The SDK cannot parse `data:image/png;base64,…` strings. It requires raw file bytes as a `number[]`.

### Serial send queue

The glasses cannot handle concurrent `updateImageRawData` calls. All sends are serialized through a promise chain:

```typescript
let _sendQueue = Promise.resolve()

function enqueueImageSend(fn: () => Promise<void>): void {
  _sendQueue = _sendQueue.then(fn).catch((err) => log(`Image send error: ${err}`))
}
```

---

## Full Image View

The **Full Image View** toggle (in the setup card) switches camera view from a single centered 200×100 image to a 2×2 grid of four 200×100 tiles, covering a 400×200 area centered on the 576×288 display.

> **Warning:** Full Image View is slower and may cause screen tearing. Each tile is sent as a separate `updateImageRawData` call through the serial image queue — the display updates tile-by-tile as they arrive, not atomically.

### How tiling works

The source image is fetched once and drawn at 400×200 on an off-screen canvas. Four 200×100 sub-canvases each copy their region and encode independently as PNG:

```text
Source image → 400×200 canvas
  ├── drawImage(src,   0,   0, 200, 100) → tile 0 (TL) → PNG number[]
  ├── drawImage(src, 200,   0, 200, 100) → tile 1 (TR) → PNG number[]
  ├── drawImage(src,   0, 100, 200, 100) → tile 2 (BL) → PNG number[]
  └── drawImage(src, 200, 100, 200, 100) → tile 3 (BR) → PNG number[]
```

### Container layout

Full-view mode uses `containerTotalNum: 5` — one event-capture text container plus four image containers:

| ID | Name | Position | Role |
| --- | --- | --- | --- |
| 1 | `evt` | (0, 0) | Full-screen event capture |
| 2 | `cam-tl` | (88, 44) | Top-left tile |
| 3 | `cam-tr` | (288, 44) | Top-right tile |
| 4 | `cam-bl` | (88, 144) | Bottom-left tile |
| 5 | `cam-br` | (288, 144) | Bottom-right tile |

`xStart = (576 − 400) / 2 = 88`, `yStart = (288 − 200) / 2 = 44`

### Caching

Tiled images use a separate in-memory cache (`tiledImageCache`) keyed by image URL, independent of the single-image cache. Tap-to-refresh calls `fetchCameraImageTiledFresh`, which bypasses the cache and updates it with the new tiles.

### Toggling at runtime

The `fullView` flag in `main.ts` is read at the moment each image is fetched — changing the toggle takes effect on the next camera tap or scroll-debounce fire. Switching modes does not rebuild the current page; the new layout is applied on the next navigation into camera view.

---

## Event System

All hardware input from the G2 ring flows through `bridge.onEvenHubEvent()`. The listener in `glasses.ts` dispatches a normalized event object to a handler in `main.ts`:

```typescript
type GlassesEvent =
  | { type: 'list-select'; itemName: string; itemIndex: number }
  | { type: 'click' | 'double-click' | 'scroll-up' | 'scroll-down' }
```

Routing table:

| SDK event field | `eventType` | Dispatched as |
| --- | --- | --- |
| `listEvent` | — | `list-select` |
| `textEvent` | 1 | `scroll-up` |
| `textEvent` | 2 | `scroll-down` |
| `sysEvent` | 0 or absent | `click` (or `double-click` if within 500 ms of prior click) |
| `sysEvent` | 3 | `double-click` |

`IMU_DATA_REPORT` events are filtered out silently.

---

## Caching Strategy

Initial camera fetch (~600+ cameras) is expensive. Two layers of caching minimize API calls:

### Camera metadata — persisted across restarts

On first load, `fetchAllCameras()` fetches and parses the full camera list, then stores it in `bridge.setLocalStorage('cameras', JSON.stringify(cameras))`. The access code is also persisted. On boot, both are restored from storage. Pressing "Load Cameras" with the same code skips the network fetch entirely.

### Camera images — in-memory only

Images are cached in a `Map<string, number[]>` keyed by image URL. Cache hits skip the fetch, canvas, and encode steps entirely. The cache is not persisted (image byte arrays are too large for localStorage).

Tap-to-refresh in camera view uses `fetchCameraImageFresh()`, which bypasses the cache and updates it with the fresh copy so subsequent scroll-backs use the new version.

---

## Dev Mode vs Production

The Even App loads the WebView without evaluating `app.json` during dev/QR sideloading. This means the network whitelist is not active, but **all external `fetch()` calls are blocked by the WebView sandbox anyway**.

The Vite dev server works around this with proxy rules:

```javascript
// vite.config.js
'/proxy/wsdot'  → https://wsdot.wa.gov          (camera list API)
'/proxy/images' → https://images.wsdot.wa.gov   (WSDOT-hosted images)
```

`api.ts` uses `import.meta.env.DEV` to switch between proxied paths (dev) and direct URLs (production). `toImageURL()` rewrites image URLs stored in `CameraEntry` at fetch time.

**Third-party image hosts** (non-WSDOT cameras) are not proxied in dev. In a production build, they are fetched directly and must be listed in `app.json`'s whitelist.

---

## Adding New Camera Sources

If you add a new camera data source with images served from a domain not already in `app.json`:

1. Find all unique origins in the new data set:

    ```bash
    node -e "
    const data = JSON.parse(require('fs').readFileSync('your-data.json','utf8'));
    const origins = new Set(data.map(c => new URL(c.ImageURL).origin));
    console.log([...origins].map(o => '\"' + o + '\"').join(','));
    "
    ```

2. Add the origins to `app.json` under `permissions[0].whitelist`.

3. If dev-mode testing is needed for those origins, add a corresponding proxy entry in `vite.config.js`.

---

## Debug Panel

The in-app debug panel (bottom of the WebView) shows timestamped log entries from `log()` in `debug.ts`. It is collapsed by default; click the header to expand. The most recent entry is highlighted green.

Key log prefixes:

| Prefix | Meaning |
| --- | --- |
| `[sysEvent]` | Resolved event type from ring press (click / double-click) |
| `[textEvent]` | Scroll event from text container |
| `[listEvent]` | Highway selection from list container |
| `[fetch]` | Outbound network request + response status |
| `[cache]` | Image cache hit/miss (single and tiled) |
| `[scroll]` | Debounce timer start/fire |
| `[tap]` | Tap-to-refresh in camera view |
| `[fullView]` | Full Image View toggle state change |
| `[input]` | Ring controls hint (printed on boot) |
| `Boot warning` | Non-fatal error during initialization |

Ring controls: **swipe** = scroll up/down · **press** = single tap · **double press** = double-tap (back).
