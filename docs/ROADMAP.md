# Road View — WSDOT Camera Viewer for Even Realities G2

## Overview

A WebView app for the G2 glasses that lets users browse WSDOT highway camera feeds.
Users select a camera by highway, then view live images on their glasses.

---

## API

### Get access code

User visits: [wsdot.wa.gov/traffic/api](https://wsdot.wa.gov/traffic/api/)

Stored in `bridge.setLocalStorage('accessCode', code)` — persists across launches.

### Fetch all cameras

```text
GET https://wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode={ACCESSCODE}
```

Response fields used: `CameraID`, `Title`, `ImageURL`, `IsActive`, `CameraLocation.RoadName`

Camera data stored as:

```typescript
type CameraEntry = { cameraID: number; title: string; imageURL: string }
type CameraStore = Record<string, CameraEntry[]>  // key = RoadName
```

Stored in `bridge.setLocalStorage('cameras', JSON.stringify(store))`.

> Note: `ImageURL` is returned directly in the bulk camera response — no per-camera API call needed.

---

## Hardware Limits (SDK)

| Constraint | Value |
| --- | --- |
| Canvas size | 576 x 288 px |
| Image container max | 200 x 100 px |
| Image format | PNG bytes as `number[]` (via `canvas.toBlob`) |
| List container max items | 20 (SDK hard limit) |
| List item name max length | 64 characters |
| `containerTotalNum` | 1-12 |
| `textObject` max | 8 items |
| `createStartUpPageContainer` | Once per glasses session; use `rebuildPageContainer` after |
| Concurrent image sends | Not allowed — must use serial queue |

---

## Navigation States

```text
[Setup — WebView]
      | submit access code
[Highway List — Glasses]
      | select highway
[Camera Browse — Glasses]
      | tap to select camera
[Camera View — Glasses]
```

---

## State Descriptions

### Setup (WebView)

- Form: access code input + link to [wsdot.wa.gov/traffic/api](https://wsdot.wa.gov/traffic/api/)
- Pre-fills from `bridge.getLocalStorage('accessCode')` if saved
- On submit: fetch all cameras, group by RoadName, save to localStorage
- Calls `createStartUpPageContainer` then transitions to Highway List

### Highway List (Glasses)

- Container: `ListContainer` (isEventCapture=1, full-screen)
- Items: up to 18 highway names per page
- Pagination items: `"-> Next Page"` (last slot if more pages follow), `"<- Prev Page"` (first slot on page 2+)
- `listEvent.currentSelectItemName`:
  - `"-> Next Page"` — increment page, rebuild list
  - `"<- Prev Page"` — decrement page, rebuild list
  - Any highway name — transition to Camera Browse for that highway

### Camera Browse (Glasses)

- Containers:
  - `TextContainer` ID=1 (isEventCapture=1, full-screen, invisible — event catcher)
  - `TextContainer` ID=2 (visible, shows highway / camera index / title / camera ID)
- JS tracks `cameraIndex` in state
- `SCROLL_TOP_EVENT` — `cameraIndex--`, clamp to 0, `textContainerUpgrade` ID=2
- `SCROLL_BOTTOM_EVENT` — `cameraIndex++`, clamp to total-1, `textContainerUpgrade` ID=2
- `sysEvent` click (single) — fetch image, transition to Camera View
- `sysEvent` double-click — transition back to Highway List

### Camera View (Glasses)

- Standard mode: `TextContainer` ID=1 (event capture) + `ImageContainer` ID=2 (200x100, centered)
- Full-view mode: `TextContainer` ID=1 + four `ImageContainer`s ID=2-5 (2x2 tiled, 400x200 centered)
- On enter: enqueue image fetch + send
- `SCROLL_TOP_EVENT` — `cameraIndex--`, clamp, debounce 1s, then fetch + send
- `SCROLL_BOTTOM_EVENT` — `cameraIndex++`, clamp, debounce 1s, then fetch + send
- `sysEvent` click (single) — re-fetch current camera image (bypass cache), enqueue send
- `sysEvent` double-click — transition back to Camera Browse
- **Fallback**: if image fetch fails, `textContainerUpgrade` ID=1 with `"No image available\n${title}"`

> **Future iteration**: on image unavailable, auto-skip to the next camera with an available image rather than showing an error.

---

## Event Routing

Scroll events arrive via `textEvent`. Click and double-click arrive via `sysEvent`.

`CLICK_EVENT = 0` is falsy in JavaScript — the SDK omits it from serialized JSON. The handler defaults to `CLICK_EVENT` when `sysEvent.eventType` is absent.

`DOUBLE_CLICK_EVENT = 3` may not always fire from the hardware ring. Manual fallback: two clicks within 500 ms are promoted to double-click.

---

## Image Rendering Pipeline

```typescript
fetch(imageURL)                    // fetch raw image bytes
  // -> blob -> objectURL
  // -> draw to 200x100 canvas (or 400x200 for full-view)
  // -> canvas.toBlob('image/png')
  // -> arrayBuffer -> number[]
  // -> bridge.updateImageRawData({ containerID, containerName, imageData })
```

All sends go through a serial queue — never concurrent.

---

## Pagination Logic

```text
LIST_PAGE_SIZE = 18   // real items per page
                      // Worst case: PREV(1) + 18 + NEXT(1) = 20 (SDK hard limit)

Page 0:  [...items 0..17, "-> Next Page"]            if total > 18
Page 0:  [...items 0..N]                              if total <= 18 (no nav items)
Page N:  ["<- Prev Page", ...items, "-> Next Page"]   if items remain after page
Last:    ["<- Prev Page", ...remaining items]
```

Navigation items are detected by position (index 0 = prev, last index = next) in addition to string matching, to avoid Unicode comparison issues with the arrow characters.

---

## app.json — Network Whitelist

All known image origins are already in `app.json`. To find new origins when adding a camera source, run:

```bash
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('cameras-response.json', 'utf8'));
const origins = new Set();
for (const cam of data) {
  if (cam.ImageURL) {
    try { origins.add(new URL(cam.ImageURL).origin) } catch {}
  }
}
console.log([...origins].map(o => '\"' + o + '\"').join(','));
"
```

---

## Planned Features

### Task 1 — Voice Commands

**Goal:** Let users navigate to a highway or camera by speaking rather than scrolling.

#### 1.1 Microphone access

Investigate whether the G2 WebView exposes the browser `SpeechRecognition` / `webkitSpeechRecognition` API. If not, check whether the Even Hub SDK provides a native microphone bridge method. Document findings in `docs/` before implementing.

#### 1.2 Capture and transcribe

```typescript
const recognition = new (window.SpeechRecognition ?? window.webkitSpeechRecognition)()
recognition.lang = 'en-US'
recognition.interimResults = false
recognition.onresult = (e) => handleVoiceInput(e.results[0][0].transcript)
recognition.start()
```

Trigger recognition from a dedicated "voice" state entered via the new pre-highway screen (see Task 3).

#### 1.3 Fuzzy match

Use a lightweight fuzzy-match library (e.g. `fuse.js`) against two corpora:

| Case | User says | Match against | Action |
| --- | --- | --- | --- |
| A | `"get i-90"` | Highway names (`Object.keys(cameras)`) | Navigate to Camera Browse for best match |
| B | `"Gunderson Way"` | All camera titles across all highways | Navigate to Camera Browse for that highway, scrolled to the matched camera |

Normalize both the query and corpus to lowercase before matching. Prefer an exact highway-name match over a fuzzy camera-title match when both score similarly.

#### 1.4 Fallback

If the top match score is below threshold, show `"Command not recognized"` on the glasses display and return to the voice-input state.

---

### Task 2 — Fix Previous Page Button

**Status:** Fixed via position-based detection in `main.ts`.

The root cause was unreliable string comparison for `PREV_LABEL` (Unicode left arrow may be stripped or mangled by the SDK). The fix uses index-based detection: if `hasPrev && itemIndex === 0`, it is always the prev button regardless of the resolved string. Same logic applied to next for consistency.

---

### Task 3 — Favorites and Pre-Highway Menu

#### 3.1 New `main-menu` state

Insert a new glasses view before the highway list. Shown immediately after "Load Cameras" succeeds.

```text
Navigation state machine (updated):

[Setup — WebView]
      | Load Cameras
[Main Menu — Glasses]          <-- NEW
      |-- Favorites
      |-- Browse Highways
      +-- Voice Command
```

Implement as a `ListContainerProperty` with three fixed items.

#### 3.2 Favorites behavior

**WebView side (setup UI):**

- Add a multi-select dropdown or searchable list in `index.html` populated from the loaded `cameras` store.
- Selected cameras are saved with `bridge.setLocalStorage('favorites', JSON.stringify(favoriteCams))`.

**Glasses side:**

- On selecting "Favorites" from the main menu, load favorites from localStorage and show them as a `ListContainerProperty`.
- Selecting a favorite navigates directly to Camera View for that camera (bypasses Camera Browse).
- If the favorites list is empty, show a text message: `"No favorites saved\nAdd them in the app"`.

**Data shape:**

```typescript
type FavoriteEntry = Pick<CameraEntry, 'cameraID' | 'title' | 'imageURL'> & { highway: string }
```

Storing `highway` alongside the camera allows the double-tap back-navigation from Camera View to land on the correct highway in Camera Browse.
