# Road View

A WebView app for the **Even Realities G2** smart glasses that streams live WSDOT highway camera feeds directly to the display.

## Screenshots

### Main Menu

Tap to start, then scroll to select Favorites or Browse.

![Main Menu](./screenshots/main-menu.png)

### Browse Flow

Select a highway from the paginated list, scroll through cameras, and tap to view.

| Highway List | Camera Detail |
| :---: | :---: |
| ![Highway List](./screenshots/road-list.png) | ![Camera Detail](./screenshots/road-detail.png) |

### Camera View

Single image (200x100) or full image view (2x2 tiled, 400x200). Scroll to change cameras, tap to refresh.

| Standard View | Full Image View |
| :---: | :---: |
| ![Standard View](./screenshots/small-view.png) | ![Full Image View](./screenshots/large-view-1.png) |

![Full Image View — alternate angle](./screenshots/large-view-2.png)

>Note: Images taken from simulator, images are easier to see on hardware.

### Favorites / Quad View

Select favorite cameras in the WebView, then view 4 at a time on the glasses. Scroll to page through them.

![Quad View](./screenshots/favorites-view.png)

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

To sideload for dev: open the Even App on your phone, tap the QR scan button, and scan the code printed by `npm run qr`.

---

## Packaging for Even Hub

```bash
npm run build
evenhub pack app.json dist -o roadview.ehpk
```

Key `app.json` fields:

| Field | Value |
| --- | --- |
| `package_id` | `com.natealmanza.roadview` |
| `entrypoint` | `index.html` |
| `permissions` | Network whitelist for all camera image origins |

---

## Features

### Menu

The splash/menu screen uses a shared 3-container layout:

| ID | Role |
| --- | --- |
| 1 | Invisible full-screen event capture |
| 2 | Logo image |
| 3 | Visible text (non-event-capture) |

On boot the text reads "tap to start". After cameras load, the text updates in-place to a selectable menu — no page rebuild, no image re-send. Scroll toggles between **Quad View** and **Browse**, tap confirms.

### Browse

Select a highway from a paginated list, scroll through its cameras, and tap to view a snapshot.

**Highway List** — SDK list container (`containerTotalNum: 1`, sole container on the page). Paginated with 18 items per page plus Next/Prev navigation labels. Hard SDK limit of 20 items per list.

**Camera Browse** — Text-based view showing highway, camera index, title, and ID. Scroll navigates cameras via `textContainerUpgrade` (no page rebuild). Tap fetches the image. Double-tap goes back.

**Camera View** — Fetched image centered on the 576x288 canvas. Scroll moves between cameras with a 1-second debounce. Tap refreshes (bypasses cache). Double-tap returns to browse.

### Quad View

Displays up to 4 favorite camera images simultaneously in a 2x2 tiled layout. Favorites are selected via checkboxes in the WebView and persisted across sessions via `bridge.setLocalStorage`.

Uses `containerTotalNum: 5` — one event-capture text container plus four 200x100 image containers. Scroll pages through favorites (4 per page). Tap refreshes. Double-tap returns to menu.

### Full Image View

A toggle in the setup card that switches camera view from a single 200x100 image to a 2x2 grid of four tiles covering 400x200. The source image is fetched once and sliced into four sub-canvases, each encoded as PNG independently.

Slower than single view — tiles arrive one by one. Toggling mid-session is handled safely; switching modes triggers a page layout rebuild on the next image load.

---

## Navigation Map

```text
Splash ("tap to start")
  └─ tap ─→ Menu ("> Quad View" / "Browse")
              ├─ tap "Browse" ─→ Highway List
              │                    └─ select ─→ Camera Browse
              │                                   └─ tap ─→ Camera View
              │                                   ←── double-tap ──┘
              │                    ←── double-tap ──┘
              ├─ tap "Quad View" ─→ Quad View
              │                    ←── double-tap ──┘
              ←── double-tap (from any sub-view) ──┘
```

All backward navigation is double-tap. Forward navigation is single tap or list selection.

---

## Container Layouts

Each view rebuilds the page with a different container configuration:

| View | Total | ID 1 | ID 2 | ID 3 | ID 4 | ID 5 |
| --- | --- | --- | --- | --- | --- | --- |
| Splash / Menu | 3 | Event capture | Logo image | Visible text | — | — |
| Highway List | 1 | List | — | — | — | — |
| Camera Browse | 2 | Event capture | Display text | — | — | — |
| Camera View | 2 | Event capture | Image | — | — | — |
| Full Image View | 5 | Event capture | Tile TL | Tile TR | Tile BL | Tile BR |
| Quad View | 5 | Event capture | Tile TL | Tile TR | Tile BL | Tile BR |

Container IDs must be contiguous from 1 and not exceed `containerTotalNum`.

---

## Image Pipeline

Camera images from WSDOT are JPEGs. The G2 SDK requires PNG file bytes as `number[]`:

```text
fetch(imageURL) → blob → objectURL → Image → canvas (200x100) → toBlob('image/png') → arrayBuffer → Array.from(Uint8Array) → bridge.updateImageRawData()
```

PNG compresses a 200x100 frame to ~3-8 KB. Raw RGBA (165,888 numbers) overflows the bridge.

Images are cached in-memory (`Map<string, number[]>`) keyed by URL. Tap-to-refresh bypasses the cache and updates it with the fresh copy. Tiled images use a separate cache.

---

## Dev Mode vs Production

In dev mode, the WebView sandbox blocks all external fetches. The Vite dev server proxies around this:

```text
/proxy/wsdot  → https://wsdot.wa.gov          (camera list API)
/proxy/images → https://images.wsdot.wa.gov   (camera images)
```

`api.ts` switches between proxied and direct URLs based on `import.meta.env.DEV`.

---

## Debug Panel

Collapsible log panel at the bottom of the WebView. Key prefixes:

| Prefix | Meaning |
| --- | --- |
| `[sysEvent]` | Ring press (click / double-click) |
| `[textEvent]` | Scroll event |
| `[listEvent]` | Highway list selection |
| `[fetch]` | Network request / response |
| `[cache]` | Image cache hit/miss |
| `[scroll]` | Debounce timer |
| `[quad]` | Quad view tile loading |
| `[fullView]` | Full Image View toggle |

Ring controls: **swipe** = scroll · **press** = tap · **double press** = back.
