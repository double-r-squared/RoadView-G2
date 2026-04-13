# Even G2 Image Send — What Actually Works

## ✅ Correct image format

```typescript
// canvas.toBlob → arrayBuffer → number[]
const blob = await new Promise<Blob>((resolve, reject) => {
  canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/png');
});
const imageData = Array.from(new Uint8Array(await blob.arrayBuffer()));

await bridge.updateImageRawData(new ImageRawDataUpdate({
  containerID:   2,
  containerName: 'bs-heatmap',
  imageData,       // PNG file bytes as number[]
}));
```

**Why this works:** PNG compresses a 200×100 graphic to ~3–8 KB → only ~5 000–8 000
numbers in the JSON array, well within the JS→native bridge message limit.

---

## ❌ Formats that fail and why

| Format | Error | Reason |
|--------|-------|--------|
| `canvas.toDataURL('image/png')` as string | `sendFailed` | `data:image/png;base64,…` prefix — SDK can't parse the data URL scheme |
| Raw RGBA `number[]` (165 888 items) | `imageException` | ~580 KB JSON array overflows the bridge; glasses receive truncated/corrupt data |
| 8-bit grayscale base64 string | `sendFailed` | Wrong input format — SDK expects PNG file bytes, not raw pixel bytes |
| 4-bit packed grayscale base64 | `sendFailed` | Pre-packing confuses the SDK; it can't identify the format |

---

## Display hardware facts

- **Display format:** 4-bit grayscale (16 shades). The SDK/firmware converts the PNG internally — do NOT pre-convert.
- **Image container max size:** `width: 200, height: 100` (hard limit from docs).
- **Canvas size:** 576 × 288 px.
- **Centered image position:** `xPosition: 188, yPosition: 94` → `(576−200)/2`, `(288−100)/2`.

---

## Container setup for image + tap events

```typescript
// containerID order = draw order (higher = on top)
{
  containerTotalNum: 2,
  textObject: [
    new TextContainerProperty({
      containerID: 1, containerName: 'evt',
      content: ' ', xPosition: 0, yPosition: 0,
      width: 576, height: 288,
      isEventCapture: 1, paddingLength: 0,
    }),
  ],
  imageObject: [
    new ImageContainerProperty({
      containerID: 2, containerName: 'bs-heatmap',
      xPosition: 188, yPosition: 94,
      width: 200, height: 100,
    }),
  ],
}
```

- **Text container (ID 1)** — invisible full-screen layer; captures all events.
- **Image container (ID 2)** — drawn on top (higher ID = later in render pass).
- **Image containers have no `isEventCapture`** — you must use a text or list container behind them.

---

## Event types (from `OsEventTypeList`)

| Value | Constant | Delivered via | Meaning |
| --- | --- | --- | --- |
| 0 | `CLICK_EVENT` | `sysEvent` | Single tap / ring press |
| 1 | `SCROLL_TOP_EVENT` | `textEvent` | Scroll up |
| 2 | `SCROLL_BOTTOM_EVENT` | `textEvent` | Scroll down |
| 3 | `DOUBLE_CLICK_EVENT` | `sysEvent` | Double-tap (may not always fire from hardware) |
| 8 | `IMU_DATA_REPORT` | `textEvent` | IMU stream (filter this out) |

**Important:** Scroll events arrive via `event.textEvent`, but click and double-click arrive via `event.sysEvent`. `CLICK_EVENT = 0` is falsy in JavaScript — the SDK omits it from the serialized JSON, so `sysEvent` will be `{}` for a single click. Default to `CLICK_EVENT` when `eventType` is absent.

```typescript
bridge.onEvenHubEvent((event) => {
  if (event.sysEvent !== undefined) {
    const t = event.sysEvent['eventType'] ?? 0  // 0 = CLICK_EVENT (omitted from JSON)
    // handle click or double-click
  }
  if (event.textEvent) {
    // handle scroll events
  }
});
```

---

## `createStartUpPageContainer` lifecycle

- Can only be called **once per glasses session**. Returns code `1` (invalid) if called again.
- On page reload: fall back to `rebuildPageContainer` with the same config.
- Send image only **after** create/rebuild succeeds.

---

## Serial image queue

The glasses cannot handle concurrent image sends. Always queue:

```typescript
let sendQueue = Promise.resolve();
function enqueueImageSend(fn: () => Promise<void>) {
  sendQueue = sendQueue.then(fn).catch(err => log(`send error: ${err}`));
}
```
