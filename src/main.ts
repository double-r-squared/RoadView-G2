import { initDebugPanel, log } from './debug'
import {
  fetchAllCameras,
  fetchCameraImageDataCached,
  fetchCameraImageFresh,
  fetchCameraImageTiledCached,
  fetchCameraImageTiledFresh,
} from './api'
import {
  getBridge,
  getDeviceStatus,
  listenGlassesEvents,
  sendCameraImage,
  sendCameraImageFull,
  showCameraBrowse,
  showCameraView,
  showCameraViewFull,
  showHighwayList,
  showImageError,
  updateBrowseText,
} from './glasses'
import {
  LIST_PAGE_SIZE,
  NEXT_LABEL,
  PREV_LABEL,
  type AppState,
  type CameraStore,
} from './types'

// ─── State ────────────────────────────────────────────────────────────────────

let state: AppState = { name: 'setup' }
let cameras: CameraStore = {}
// Access code that was used to populate `cameras`.
// If the user presses Load Cameras with the same code and cameras are already
// in memory, we skip the network fetch entirely.
let cachedAccessCode = ''

// Debounce timer for camera-view scroll — waits 1s after the last scroll
// event before fetching, so rapid scrolling doesn't hammer the API.
let scrollTimer: ReturnType<typeof setTimeout> | null = null

// Full-view toggle — when true, uses four 200×100 tiled containers instead of one.
// Toggled via the checkbox in the WebView setup card.
let fullView = false

function scheduleImageFetch(imageURL: string, title: string, cameraID: number): void {
  if (scrollTimer !== null) clearTimeout(scrollTimer)
  log(`[scroll] debounce started — cameraID=${cameraID} "${title}"`)
  scrollTimer = setTimeout(() => {
    scrollTimer = null
    log(`[scroll] debounce fired — fetching cameraID=${cameraID} "${title}"`)
    loadAndSendImage(imageURL, title)
  }, 1000)
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

const $status    = document.getElementById('status')!
const $deviceInfo = document.getElementById('device-info')!
const $accessCode = document.getElementById('access-code') as HTMLInputElement
const $btnConnect = document.getElementById('btn-connect') as HTMLButtonElement
const $btnSubmit  = document.getElementById('btn-submit') as HTMLButtonElement
const $debugPanel = document.getElementById('debug-panel')!
const $debugHeader = document.getElementById('debug-header')!
const $debugList  = document.getElementById('debug-list')!
const $btnClearLog    = document.getElementById('btn-clear-log') as HTMLButtonElement
const $fullViewToggle = document.getElementById('full-view-toggle') as HTMLInputElement

function setStatus(msg: string, type: 'info' | 'ok' | 'error' | '' = '') {
  $status.textContent = msg
  $status.className = type
}

function setLoading(loading: boolean) {
  $btnSubmit.disabled = loading
  $btnConnect.disabled = loading
}

// ─── Debug panel wiring ───────────────────────────────────────────────────────

$debugHeader.addEventListener('click', () => {
  $debugPanel.classList.toggle('collapsed')
  if (!$debugPanel.classList.contains('collapsed')) {
    $debugList.scrollTop = $debugList.scrollHeight
  }
})

$btnClearLog.addEventListener('click', (e) => {
  e.stopPropagation()
  $debugList.innerHTML = ''
})

// ─── Full-view toggle ─────────────────────────────────────────────────────────

$fullViewToggle.addEventListener('change', () => {
  fullView = $fullViewToggle.checked
  log(`[fullView] ${fullView ? 'enabled' : 'disabled'}`)
})

// ─── Connect Glasses button ───────────────────────────────────────────────────

$btnConnect.addEventListener('click', async () => {
  setLoading(true)
  setStatus('Connecting to glasses...', 'info')
  log('Connect Glasses pressed')
  try {
    const status = await getDeviceStatus()
    $deviceInfo.textContent = status
    setStatus('Glasses connected', 'ok')
    log(`Device: ${status}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setStatus(`Connect failed: ${msg}`, 'error')
    log(`Connect error: ${msg}`)
    $deviceInfo.textContent = ''
  } finally {
    setLoading(false)
  }
})

// ─── Load Cameras button ──────────────────────────────────────────────────────

$btnSubmit.addEventListener('click', async () => {
  const code = $accessCode.value.trim()
  if (!code) {
    setStatus('Please enter your access code', 'error')
    return
  }

  setLoading(true)

  try {
    const bridge = await getBridge()
    const highwayCount = Object.keys(cameras).length

    // Skip the network fetch if cameras are already in memory for this access code.
    // The initial fetch is expensive (~600+ cameras) so we only do it once per code.
    if (code === cachedAccessCode && highwayCount > 0) {
      const cameraCount = Object.values(cameras).reduce((s, c) => s + c.length, 0)
      log(`[cache] Camera data already loaded (${cameraCount} cameras, ${highwayCount} highways) — skipping fetch`)
      setStatus(`${cameraCount} cameras loaded — showing on glasses`, 'ok')
      const highways = Object.keys(cameras)
      state = { name: 'highway-list', highways, page: 0 }
      await showHighwayList(highways, 0)
      return
    }

    setStatus('Fetching cameras...', 'info')
    log(`[fetch] Cameras — access code: ${code.slice(0, 4)}...`)

    await bridge.setLocalStorage('accessCode', code)
    cameras = await fetchAllCameras(code)
    cachedAccessCode = code

    const newHighwayCount = Object.keys(cameras).length
    const cameraCount = Object.values(cameras).reduce((s, c) => s + c.length, 0)

    await bridge.setLocalStorage('cameras', JSON.stringify(cameras))
    log(`[fetch] Done — ${cameraCount} cameras across ${newHighwayCount} highways`)
    setStatus(`${cameraCount} cameras loaded — showing on glasses`, 'ok')

    const highways = Object.keys(cameras)
    state = { name: 'highway-list', highways, page: 0 }
    await showHighwayList(highways, 0)
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error'
    const msg  = err instanceof Error ? err.message : String(err)
    setStatus(`${name}: ${msg}`, 'error')
    log(`Load error [${name}]: ${msg}`)
    if (err instanceof Error && err.stack) log(`Stack: ${err.stack}`)
  } finally {
    setLoading(false)
  }
})

// ─── Glasses event routing ────────────────────────────────────────────────────

async function handleGlassesEvent(
  event:
    | { type: 'list-select'; itemName: string; itemIndex: number }
    | { type: 'click' | 'double-click' | 'scroll-up' | 'scroll-down' }
): Promise<void> {
  log(`Event: ${JSON.stringify(event)} | state: ${state.name}`)

  // ── Highway List ─────────────────────────────────────────────────────────
  if (state.name === 'highway-list') {
    if (event.type !== 'list-select') return
    const { highways, page } = state

    // Rebuild the same items array showHighwayList used for index-based lookup
    const start = page * LIST_PAGE_SIZE
    const slice = highways.slice(start, start + LIST_PAGE_SIZE)
    const hasPrev = page > 0
    const hasNext = start + LIST_PAGE_SIZE < highways.length
    const pageItems: string[] = []
    if (hasPrev) pageItems.push(PREV_LABEL)
    pageItems.push(...slice)
    if (hasNext) pageItems.push(NEXT_LABEL)

    // Prefer itemName; fall back to index lookup when name is empty
    const resolved = event.itemName || (event.itemIndex >= 0 ? pageItems[event.itemIndex] ?? '' : '')
    log(`Highway resolved: "${resolved}" (name="${event.itemName}" idx=${event.itemIndex}) hasPrev=${hasPrev} hasNext=${hasNext} pageLen=${pageItems.length}`)

    // Position-based detection is more reliable than string comparison for nav labels.
    // PREV is always index 0 when hasPrev=true; no highway can occupy that slot.
    // NEXT is always the last index when hasNext=true; same guarantee.
    const isPrev = hasPrev && (resolved === PREV_LABEL || event.itemIndex === 0)
    const isNext = hasNext && (resolved === NEXT_LABEL || event.itemIndex === pageItems.length - 1)

    if (!resolved && !isPrev && !isNext) { log('Could not resolve item'); return }

    if (isPrev) {
      const prev = page - 1
      log(`[page] PREV → page ${prev}`)
      state = { name: 'highway-list', highways, page: prev }
      await showHighwayList(highways, prev)
      return
    }

    if (isNext) {
      const next = page + 1
      log(`[page] NEXT → page ${next}`)
      state = { name: 'highway-list', highways, page: next }
      await showHighwayList(highways, next)
      return
    }

    const cams = cameras[resolved]
    if (!cams?.length) { log(`No cameras for: "${resolved}"`); return }

    state = { name: 'camera-browse', highway: resolved, cameras: cams, cameraIndex: 0 }
    await showCameraBrowse(resolved, cams, 0)
    return
  }

  // ── Camera Browse ─────────────────────────────────────────────────────────
  // Scroll up/down to navigate, single tap to fetch image, double-click to go back.
  if (state.name === 'camera-browse') {
    const { highway, cameras: cams, cameraIndex } = state

    if (event.type === 'scroll-up') {
      const next = Math.max(0, cameraIndex - 1)
      state = { ...state, cameraIndex: next }
      await updateBrowseText(highway, cams, next)
      return
    }

    if (event.type === 'scroll-down') {
      const next = Math.min(cams.length - 1, cameraIndex + 1)
      state = { ...state, cameraIndex: next }
      await updateBrowseText(highway, cams, next)
      return
    }

    if (event.type === 'double-click') {
      // Back to highway list — restore the page this highway was on
      const highways = Object.keys(cameras)
      const hIdx = highways.indexOf(highway)
      const hwPage = Math.floor(Math.max(0, hIdx) / LIST_PAGE_SIZE)
      state = { name: 'highway-list', highways, page: hwPage }
      await showHighwayList(highways, hwPage)
      return
    }

    if (event.type === 'click') {
      // Single tap — fetch image and enter camera view
      const cam = cams[cameraIndex]
      log(`Fetching image: ${cam.title} [fullView=${fullView}]`)
      setStatus(`Loading: ${cam.title}`, 'info')
      try {
        state = { name: 'camera-view', highway, cameras: cams, cameraIndex }
        if (fullView) {
          const tiles = await fetchCameraImageTiledCached(cam.imageURL)
          await showCameraViewFull(highway, cams, cameraIndex, tiles)
        } else {
          const imageData = await fetchCameraImageDataCached(cam.imageURL)
          await showCameraView(highway, cams, cameraIndex, imageData)
        }
        setStatus(`Showing: ${cam.title}`, 'ok')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`Image load error: ${msg}`)
        setStatus(`Image error: ${msg}`, 'error')
        if (fullView) {
          await showCameraViewFull(highway, cams, cameraIndex, [])
        } else {
          await showCameraView(highway, cams, cameraIndex, [])
        }
        await showImageError(cam.title)
      }
      return
    }
  }

  // ── Camera View ───────────────────────────────────────────────────────────
  // Single tap = refresh, double-click = back, scroll = prev/next with debounce.
  if (state.name === 'camera-view') {
    const { highway, cameras: cams } = state
    let { cameraIndex } = state

    if (event.type === 'double-click') {
      // Cancel any pending scroll fetch before leaving
      if (scrollTimer !== null) { clearTimeout(scrollTimer); scrollTimer = null }
      state = { name: 'camera-browse', highway, cameras: cams, cameraIndex }
      await showCameraBrowse(highway, cams, cameraIndex)
      return
    }

    if (event.type === 'click') {
      if (scrollTimer !== null) { clearTimeout(scrollTimer); scrollTimer = null }
      const cam = cams[cameraIndex]
      log(`[tap] Refresh — cameraID=${cam.cameraID} title="${cam.title}" fullView=${fullView}`)
      // Fresh fetch bypasses cache so the latest snapshot is always shown on tap
      setStatus(`Refreshing: ${cam.title}`, 'info')
      try {
        if (fullView) {
          const tiles = await fetchCameraImageTiledFresh(cam.imageURL)
          sendCameraImageFull(tiles, cam.title)
        } else {
          const imageData = await fetchCameraImageFresh(cam.imageURL)
          sendCameraImage(imageData, cam.title)
        }
        setStatus(`Showing: ${cam.title}`, 'ok')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`[tap] Refresh error: ${msg}`)
        setStatus(`No image: ${cam.title}`, 'error')
        await showImageError(cam.title)
      }
      return
    }

    if (event.type === 'scroll-up') {
      cameraIndex = Math.max(0, cameraIndex - 1)
      state = { ...state, cameraIndex }
      const cam = cams[cameraIndex]
      scheduleImageFetch(cam.imageURL, cam.title, cam.cameraID)
      return
    }

    if (event.type === 'scroll-down') {
      cameraIndex = Math.min(cams.length - 1, cameraIndex + 1)
      state = { ...state, cameraIndex }
      const cam = cams[cameraIndex]
      scheduleImageFetch(cam.imageURL, cam.title, cam.cameraID)
      return
    }
  }
}

async function loadAndSendImage(imageURL: string, title: string): Promise<void> {
  log(`Fetching image: ${title} [fullView=${fullView}]`)
  setStatus(`Loading: ${title}`, 'info')
  try {
    if (fullView) {
      const tiles = await fetchCameraImageTiledCached(imageURL)
      sendCameraImageFull(tiles, title)
    } else {
      const imageData = await fetchCameraImageDataCached(imageURL)
      sendCameraImage(imageData, title)
    }
    setStatus(`Showing: ${title}`, 'ok')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Image error: ${msg}`)
    setStatus(`No image: ${title}`, 'error')
    await showImageError(title)
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  initDebugPanel()
  log('Road View booting...')

  try {
    const bridge = await getBridge()

    const savedCode = await bridge.getLocalStorage('accessCode')
    if (savedCode) {
      $accessCode.value = savedCode
      cachedAccessCode = savedCode
      log(`Restored access code: ${savedCode.slice(0, 4)}...`)
    }

    const savedCameras = await bridge.getLocalStorage('cameras')
    if (savedCameras) {
      cameras = JSON.parse(savedCameras) as CameraStore
      const hw = Object.keys(cameras).length
      const cams = Object.values(cameras).reduce((s, c) => s + c.length, 0)
      log(`[cache] Restored ${cams} cameras across ${hw} highways from localStorage`)
      log('[cache] Press "Load Cameras" to show on glasses — fetch will be skipped (already cached)')
    }

    log('[input] Ring controls: SWIPE = scroll up/down | PRESS ring button = click | DOUBLE PRESS = double-click')

    await listenGlassesEvents((event) => {
      handleGlassesEvent(event).catch((err) => {
        log(`Event handler error: ${err instanceof Error ? err.message : String(err)}`)
      })
    })

    log('Boot complete — event listener active')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Boot warning: ${msg}`)
  }
}

boot()
