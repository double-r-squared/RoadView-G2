import {
  waitForEvenAppBridge,
  OsEventTypeList,
  type EvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { log } from './debug'
import {
  CONTAINER,
  CONTAINER_NAMES,
  FULL_VIEW_TILES,
  LIST_PAGE_SIZE,
  NEXT_LABEL,
  PREV_LABEL,
  type CameraEntry,
} from './types'

// ─── Bridge singleton ─────────────────────────────────────────────────────────

let _bridge: EvenAppBridge | null = null
let _initialized = false  // true after createStartUpPageContainer has been called once

export async function getBridge(): Promise<EvenAppBridge> {
  if (!_bridge) {
    log('Waiting for EvenApp bridge...')
    _bridge = await waitForEvenAppBridge()
    log('Bridge ready')
  }
  return _bridge
}

// ─── Serial image send queue ──────────────────────────────────────────────────

let _sendQueue = Promise.resolve()

function enqueueImageSend(fn: () => Promise<void>): void {
  _sendQueue = _sendQueue.then(fn).catch((err) => log(`Image send error: ${err}`))
}

// ─── Page helper ─────────────────────────────────────────────────────────────

interface PageSpec {
  containerTotalNum: number
  listObject?: ListContainerProperty[]
  textObject?: TextContainerProperty[]
  imageObject?: ImageContainerProperty[]
}

// Calls createStartUpPageContainer once per session, then rebuildPageContainer
// for every subsequent page change (including page reloads where create returns 1).
async function setPage(spec: PageSpec): Promise<boolean> {
  const bridge = await getBridge()

  if (!_initialized) {
    log('createStartUpPageContainer...')
    const result = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer(spec)
    )
    log(`createStartUpPageContainer result: ${result}`)

    if (result === 0) {
      _initialized = true
      return true
    }
    if (result === 1) {
      // Already called this session (page reload) — fall through to rebuild
      _initialized = true
    } else {
      log(`createStartUpPageContainer failed: code ${result}`)
      return false
    }
  }

  log('rebuildPageContainer...')
  const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(spec))
  log(`rebuildPageContainer: ${ok}`)
  return ok
}

// ─── Highway List page ────────────────────────────────────────────────────────

export async function showHighwayList(highways: string[], page: number): Promise<void> {
  const start = page * LIST_PAGE_SIZE
  const slice = highways.slice(start, start + LIST_PAGE_SIZE)
  const hasPrev = page > 0
  const hasNext = start + LIST_PAGE_SIZE < highways.length

  // Max items: PREV(1) + 18 + NEXT(1) = 20  ✓
  const items: string[] = []
  if (hasPrev) items.push(PREV_LABEL)
  items.push(...slice)
  if (hasNext) items.push(NEXT_LABEL)

  const list = new ListContainerProperty({
    containerID: CONTAINER.EVENT_TEXT,
    containerName: CONTAINER_NAMES.EVENT_TEXT,
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: items,
    }),
  })

  await setPage({ containerTotalNum: 1, listObject: [list] })
  log(`Highway list page ${page}: ${items.length} items`)
}

// ─── Camera Browse page ───────────────────────────────────────────────────────
// Text-based: scroll up/down navigates cameras, single tap fetches image,
// double-click (hardware event) goes back to highway list.

export async function showCameraBrowse(
  highway: string,
  cameras: CameraEntry[],
  cameraIndex: number
): Promise<void> {
  const displayText = buildBrowseText(highway, cameraIndex, cameras.length, cameras[cameraIndex].title, cameras[cameraIndex].cameraID)

  // ID=1: invisible full-screen event capture
  const evtContainer = new TextContainerProperty({
    containerID: CONTAINER.EVENT_TEXT,
    containerName: CONTAINER_NAMES.EVENT_TEXT,
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    isEventCapture: 1,
    content: ' ',
    paddingLength: 0,
  })

  // ID=2: visible text — highway / camera index / title
  const displayContainer = new TextContainerProperty({
    containerID: CONTAINER.DISPLAY_TEXT,
    containerName: CONTAINER_NAMES.DISPLAY_TEXT,
    xPosition: 20,
    yPosition: 20,
    width: 536,
    height: 248,
    isEventCapture: 0,
    content: displayText,
    paddingLength: 8,
  })

  await setPage({
    containerTotalNum: 2,
    textObject: [evtContainer, displayContainer],
  })
  log(`Camera browse: ${highway} [${cameraIndex + 1}/${cameras.length}]`)
}

export async function updateBrowseText(
  highway: string,
  cameras: CameraEntry[],
  cameraIndex: number
): Promise<void> {
  const bridge = await getBridge()
  const text = buildBrowseText(highway, cameraIndex, cameras.length, cameras[cameraIndex].title, cameras[cameraIndex].cameraID)

  const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: CONTAINER.DISPLAY_TEXT,
    containerName: CONTAINER_NAMES.DISPLAY_TEXT,
    contentOffset: 0,
    contentLength: text.length,
    content: text,
  }))
  log(`Browse text update [${cameraIndex + 1}/${cameras.length}]: ${ok}`)
}

function buildBrowseText(highway: string, idx: number, total: number, title: string, cameraID: number): string {
  return `${highway}\nCamera ${idx + 1} / ${total}\n${title}\nID: ${cameraID}`
}

// ─── Camera View page ─────────────────────────────────────────────────────────

export async function showCameraView(
  highway: string,
  cameras: CameraEntry[],
  cameraIndex: number,
  imageData: number[]
): Promise<void> {
  const cam = cameras[cameraIndex]

  // ID=1: invisible full-screen event capture; also used for fallback error text
  const evtContainer = new TextContainerProperty({
    containerID: CONTAINER.EVENT_TEXT,
    containerName: CONTAINER_NAMES.EVENT_TEXT,
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    isEventCapture: 1,
    content: ' ',
    paddingLength: 0,
  })

  // ID=2: image container centered on the 576×288 canvas
  const imageContainer = new ImageContainerProperty({
    containerID: CONTAINER.IMAGE,
    containerName: CONTAINER_NAMES.IMAGE,
    xPosition: 188,  // (576 - 200) / 2
    yPosition: 94,   // (288 - 100) / 2
    width: 200,
    height: 100,
  })

  const ok = await setPage({
    containerTotalNum: 2,
    textObject: [evtContainer],
    imageObject: [imageContainer],
  })

  if (ok && imageData.length > 0) {
    enqueueImageSend(async () => {
      const bridge = await getBridge()
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: CONTAINER.IMAGE,
        containerName: CONTAINER_NAMES.IMAGE,
        imageData,
      }))
      log(`Image send: ${result} — ${highway} [${cameraIndex + 1}] ${cam.title}`)
    })
  }
}

// ─── Full-view Camera View (2×2 tiled) ───────────────────────────────────────
// Covers 400×200 px centered on the 576×288 canvas using four 200×100 containers.
// Tiles are sent serially via the image queue to avoid bridge overload.
// Note: each tile sends independently — expect visible tile-by-tile loading.

export async function showCameraViewFull(
  highway: string,
  cameras: CameraEntry[],
  cameraIndex: number,
  tiles: number[][]
): Promise<void> {
  const cam = cameras[cameraIndex]

  const evtContainer = new TextContainerProperty({
    containerID: CONTAINER.EVENT_TEXT,
    containerName: CONTAINER_NAMES.EVENT_TEXT,
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    isEventCapture: 1,
    content: ' ',
    paddingLength: 0,
  })

  const imageContainers = FULL_VIEW_TILES.map(({ id, name, x, y }) =>
    new ImageContainerProperty({
      containerID: id,
      containerName: name,
      xPosition: x,
      yPosition: y,
      width: 200,
      height: 100,
    })
  )

  const ok = await setPage({
    containerTotalNum: 5,
    textObject: [evtContainer],
    imageObject: imageContainers,
  })

  if (ok && tiles.length === 4) {
    FULL_VIEW_TILES.forEach(({ id, name }, i) => {
      const tileData = tiles[i]
      if (!tileData?.length) return
      enqueueImageSend(async () => {
        const bridge = await getBridge()
        const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
          containerID: id,
          containerName: name,
          imageData: tileData,
        }))
        log(`Tile ${i} send: ${result} — ${highway} [${cameraIndex + 1}] ${cam.title}`)
      })
    })
  }
}

export function sendCameraImageFull(tiles: number[][], label: string): void {
  if (tiles.length !== 4) return
  FULL_VIEW_TILES.forEach(({ id, name }, i) => {
    const tileData = tiles[i]
    if (!tileData?.length) return
    enqueueImageSend(async () => {
      const bridge = await getBridge()
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: id,
        containerName: name,
        imageData: tileData,
      }))
      log(`Tile ${i} send: ${result} — ${label}`)
    })
  })
}

export function sendCameraImage(imageData: number[], label: string): void {
  if (imageData.length === 0) return
  enqueueImageSend(async () => {
    const bridge = await getBridge()
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: CONTAINER.IMAGE,
      containerName: CONTAINER_NAMES.IMAGE,
      imageData,
    }))
    log(`Image send: ${result} — ${label}`)
  })
}

export async function showImageError(title: string): Promise<void> {
  const bridge = await getBridge()
  const text = `No image available\n${title}`
  const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: CONTAINER.EVENT_TEXT,
    containerName: CONTAINER_NAMES.EVENT_TEXT,
    contentOffset: 0,
    contentLength: text.length,
    content: text,
  }))
  log(`Error text shown (${ok}): ${title}`)
}

// ─── Event listener ───────────────────────────────────────────────────────────

export type GlassesEventHandler = (event: {
  type: 'list-select'
  itemName: string
  itemIndex: number
} | {
  type: 'click' | 'double-click' | 'scroll-up' | 'scroll-down'
}) => void

// Manual double-tap tracking — DOUBLE_CLICK_EVENT (3) may not fire on G2 ring.
// Two clicks within DOUBLE_TAP_MS → emit 'double-click' on the second click.
const DOUBLE_TAP_MS = 500
let _lastClickTime = 0

function consumeDoubleTap(): boolean {
  const now = Date.now()
  const isDouble = now - _lastClickTime < DOUBLE_TAP_MS
  _lastClickTime = now
  return isDouble
}

export async function listenGlassesEvents(handler: GlassesEventHandler): Promise<() => void> {
  const bridge = await getBridge()

  return bridge.onEvenHubEvent((event) => {
    if (event.listEvent) {
      const itemName  = event.listEvent.currentSelectItemName ?? ''
      const itemIndex = event.listEvent.currentSelectItemIndex ?? -1
      log(`[listEvent] name="${itemName}" index=${itemIndex}`)
      handler({ type: 'list-select', itemName, itemIndex })
      return
    }

    // Click and double-click arrive as sysEvent (not textEvent).
    // Single click: sysEvent={} — eventType 0 is omitted from JSON because it's falsy.
    // Double click: sysEvent={eventType:3}
    if (event.sysEvent !== undefined) {
      const rawVal = event.sysEvent['eventType'] ?? event.jsonData?.['eventType']
      // Default to 0 (CLICK_EVENT) when the field is absent
      const t: number = typeof rawVal === 'number' ? rawVal
                      : typeof rawVal === 'string'  ? Number(rawVal)
                      : OsEventTypeList.CLICK_EVENT

      log(`[sysEvent] eventType=${t}`)

      if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        _lastClickTime = 0  // reset so next single tap isn't misread
        handler({ type: 'double-click' })
      } else if (t === OsEventTypeList.CLICK_EVENT) {
        if (consumeDoubleTap()) {
          handler({ type: 'double-click' })
        } else {
          handler({ type: 'click' })
        }
      }
      return
    }

    if (event.textEvent) {
      // eventType=0 (CLICK_EVENT) is falsy — the SDK may parse it as undefined.
      // Read from raw jsonData as fallback before giving up.
      const parsed = event.textEvent.eventType
      const raw    = event.jsonData

      let t: OsEventTypeList | undefined = parsed
      if (t === undefined && raw) {
        const rawVal = raw['eventType'] ?? raw['Event_Type'] ?? raw['event_type']
        if (typeof rawVal === 'number') t = rawVal as OsEventTypeList
        else if (typeof rawVal === 'string') t = Number(rawVal) as OsEventTypeList
      }

      log(`[textEvent] type=${t}`)

      if (t === undefined) return
      if (t === OsEventTypeList.IMU_DATA_REPORT) return

      if (t === OsEventTypeList.SCROLL_TOP_EVENT) {
        handler({ type: 'scroll-up' })
      } else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        handler({ type: 'scroll-down' })
      } else if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        // Hardware double-click — trust it directly
        _lastClickTime = 0  // reset so next single tap isn't misread
        handler({ type: 'double-click' })
      } else if (t === OsEventTypeList.CLICK_EVENT) {
        // Manual double-tap detection as fallback (two clicks within 500ms)
        if (consumeDoubleTap()) {
          handler({ type: 'double-click' })
        } else {
          handler({ type: 'click' })
        }
      }
    }
  })
}

// ─── Device status ────────────────────────────────────────────────────────────

export async function getDeviceStatus(): Promise<string> {
  const bridge = await getBridge()
  const device = await bridge.getDeviceInfo()
  if (!device) return 'No device found'
  const s = device.status
  return `Model: ${device.model} | SN: ${device.sn} | Connected: ${s.isConnected()} | Battery: ${s.batteryLevel ?? '?'}%`
}
