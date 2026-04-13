import { initDebugPanel, log } from './debug'
import {
  encodeSplashImage,
  fetchAllCameras,
  fetchCameraImageDataCached,
  fetchCameraImageFresh,
  fetchCameraImageTiledCached,
  fetchCameraImageTiledFresh,
} from './api'
import {
  buildMenuText,
  getBridge,
  getDeviceStatus,
  listenGlassesEvents,
  sendCameraImage,
  sendCameraImageFull,
  sendQuadTiles,
  showCameraBrowse,
  showCameraView,
  showCameraViewFull,
  showCenteredText,
  showHighwayList,
  showMenu,
  showQuadView,
  updateCameraViewText,
  updateMenuText,
  updateTime,
  showSplash,
  updateBrowseText,
} from './glasses'
import {
  LIST_PAGE_SIZE,
  MENU_BROWSE,
  MENU_ITEMS,
  MENU_QUAD,
  NEXT_LABEL,
  PREV_LABEL,
  QUAD_PAGE_SIZE,
  type AppState,
  type CameraEntry,
  type CameraStore,
} from './types'

// ─── State ────────────────────────────────────────────────────────────────────

let state: AppState = { name: 'setup' }
let cameras: CameraStore = {}
let cachedAccessCode = ''

// Debounce timer for camera-view scroll — waits 1s after the last scroll
// event before fetching, so rapid scrolling doesn't hammer the API.
let scrollTimer: ReturnType<typeof setTimeout> | null = null

// Full-view toggle — when true, uses four 200×100 tiled containers instead of one.
let fullView = false
// Tracks which view mode the current camera-view page was built with.
let activeFullView = false

// Favorites — array of camera IDs selected by the user for Quad View.
// Persisted via bridge.setLocalStorage so they survive sessions.
let favoriteIDs: number[] = []

// Cached splash image bytes — encoded once at boot.
let splashImageData: number[] = []

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
const $favoritesCard  = document.getElementById('favorites-card')!
const $favoritesHeader = document.getElementById('favorites-header')!
const $favoritesCount = document.getElementById('favorites-count')!
const $favoritesTree  = document.getElementById('favorites-tree')!

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

// ─── Favorites picker ────────────────────────────────────────────────────────

$favoritesHeader.addEventListener('click', () => {
  $favoritesCard.classList.toggle('collapsed')
})

function updateFavoritesCount(): void {
  $favoritesCount.textContent = `(${favoriteIDs.length})`
}

async function saveFavorites(): Promise<void> {
  try {
    const bridge = await getBridge()
    await bridge.setLocalStorage('favorites', JSON.stringify(favoriteIDs))
    log(`[favorites] Saved ${favoriteIDs.length} favorites`)
  } catch (err) {
    log(`[favorites] Save error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function loadFavorites(): Promise<void> {
  try {
    const bridge = await getBridge()
    const raw = await bridge.getLocalStorage('favorites')
    if (raw) {
      favoriteIDs = JSON.parse(raw)
      log(`[favorites] Restored ${favoriteIDs.length} favorites`)
    }
  } catch (err) {
    log(`[favorites] Load error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function buildFavoritesTree(): void {
  $favoritesTree.innerHTML = ''
  const highways = Object.keys(cameras)
  for (const highway of highways) {
    const cams = cameras[highway]
    if (!cams?.length) continue

    const group = document.createElement('div')
    group.className = 'fav-highway collapsed'

    const header = document.createElement('div')
    header.className = 'fav-highway-header'
    header.innerHTML = `<span class="hw-arrow">&#9660;</span> ${highway} <span style="color:#666;font-weight:400;font-size:0.72rem;">(${cams.length})</span>`
    header.addEventListener('click', () => group.classList.toggle('collapsed'))

    const list = document.createElement('div')
    list.className = 'fav-camera-list'

    for (const cam of cams) {
      const row = document.createElement('div')
      row.className = 'fav-camera'

      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = favoriteIDs.includes(cam.cameraID)
      cb.id = `fav-${cam.cameraID}`

      const lbl = document.createElement('label')
      lbl.htmlFor = cb.id
      lbl.textContent = cam.title

      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!favoriteIDs.includes(cam.cameraID)) favoriteIDs.push(cam.cameraID)
        } else {
          favoriteIDs = favoriteIDs.filter(id => id !== cam.cameraID)
        }
        updateFavoritesCount()
        saveFavorites()
      })

      row.appendChild(cb)
      row.appendChild(lbl)
      list.appendChild(row)
    }

    group.appendChild(header)
    group.appendChild(list)
    $favoritesTree.appendChild(group)
  }
  updateFavoritesCount()
}

// Resolves favorite camera IDs to full CameraEntry objects from loaded camera data.
// Preserves the order of favoriteIDs; drops IDs not found (camera may have gone inactive).
function resolveFavorites(): CameraEntry[] {
  const allCams = Object.values(cameras).flat()
  const byID = new Map(allCams.map(c => [c.cameraID, c]))
  return favoriteIDs.map(id => byID.get(id)).filter((c): c is CameraEntry => c !== undefined)
}

// ─── Navigate to menu ────────────────────────────────────────────────────────

async function goToMenu(): Promise<void> {
  state = { name: 'menu', menuIndex: 0 }
  await showMenu(splashImageData, 0)
}

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

// ─── Load Cameras ────────────────────────────────────────────────────────────
// Shared by both the WebView button and glasses tap-to-start.
// When fromSplash=true, we just update text (splash layout is still active).
// When fromSplash=false (e.g. button pressed after returning), we do a full rebuild.

async function loadCameras(fromSplash: boolean): Promise<void> {
  const code = $accessCode.value.trim()
  if (!code) {
    setStatus('Please enter your access code', 'error')
    if (fromSplash) await updateMenuText('No access code\ntap to retry')
    return
  }

  setLoading(true)
  if (fromSplash) await updateMenuText('  Loading...')

  try {
    const bridge = await getBridge()
    const highwayCount = Object.keys(cameras).length

    if (code === cachedAccessCode && highwayCount > 0) {
      const cameraCount = Object.values(cameras).reduce((s, c) => s + c.length, 0)
      log(`[cache] Camera data already loaded (${cameraCount} cameras, ${highwayCount} highways) — skipping fetch`)
      setStatus(`${cameraCount} cameras loaded — menu on glasses`, 'ok')
      $favoritesCard.classList.remove('hidden')
      buildFavoritesTree()
      if (fromSplash) {
        state = { name: 'menu', menuIndex: 0 }
        await updateMenuText(buildMenuText(0))
      } else {
        await goToMenu()
      }
      return
    }

    setStatus('Fetching cameras...', 'info')
    log(`[fetch] Cameras — access code: ${code.slice(0, 4)}...`)

    await bridge.setLocalStorage('accessCode', code)
    cameras = await fetchAllCameras(code)
    cachedAccessCode = code

    const newHighwayCount = Object.keys(cameras).length
    const cameraCount = Object.values(cameras).reduce((s, c) => s + c.length, 0)
    log(`[fetch] Done — ${cameraCount} cameras across ${newHighwayCount} highways`)
    setStatus(`${cameraCount} cameras loaded — menu on glasses`, 'ok')

    $favoritesCard.classList.remove('hidden')
    buildFavoritesTree()

    if (fromSplash) {
      state = { name: 'menu', menuIndex: 0 }
      await updateMenuText(buildMenuText(0))
    } else {
      await goToMenu()
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error'
    const msg  = err instanceof Error ? err.message : String(err)
    setStatus(`${name}: ${msg}`, 'error')
    log(`Load error [${name}]: ${msg}`)
    if (err instanceof Error && err.stack) log(`Stack: ${err.stack}`)
    if (fromSplash) await updateMenuText('Error\ntap to retry')
  } finally {
    setLoading(false)
  }
}

$btnSubmit.addEventListener('click', () => {
  const fromSplash = state.name === 'setup'
  loadCameras(fromSplash)
})

// ─── Quad View helpers ───────────────────────────────────────────────────────

async function enterQuadView(page: number): Promise<void> {
  const favs = resolveFavorites()
  if (favs.length === 0) {
    log('[quad] No favorites selected — showing centered message')
    state = { name: 'quad-view', page: 0 }
    await showCenteredText('No favorites\nSelect roads\nin the app')
    return
  }
  state = { name: 'quad-view', page }
  const totalPages = Math.ceil(favs.length / QUAD_PAGE_SIZE)
  await showQuadView([], `Page ${page + 1}/${totalPages}`)
  await updateCameraViewText(`Loading...`)
  await loadQuadPage(favs, page)
}

async function loadQuadPage(favs: CameraEntry[], page: number): Promise<void> {
  const totalPages = Math.max(1, Math.ceil(favs.length / QUAD_PAGE_SIZE))
  const start = page * QUAD_PAGE_SIZE
  const pageFavs = favs.slice(start, start + QUAD_PAGE_SIZE)

  // Fetch each favorite's image independently; fill empty slots with []
  const tiles: number[][] = [[], [], [], []]
  const fetches = pageFavs.map(async (cam, i) => {
    try {
      const imageData = await fetchCameraImageDataCached(cam.imageURL)
      tiles[i] = imageData
      log(`[quad] Tile ${i} ready: ${cam.title} (${imageData.length} bytes)`)
    } catch (err) {
      log(`[quad] Tile ${i} error: ${cam.title} — ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  await Promise.all(fetches)
  await sendQuadTiles(tiles, `Page ${page + 1}/${totalPages}`)
  await updateCameraViewText(`Page ${page + 1}/${totalPages}`)
  setStatus(`Quad View: page ${page + 1} of ${totalPages}`, 'ok')
}

// ─── Glasses event routing ────────────────────────────────────────────────────

async function handleGlassesEvent(
  event:
    | { type: 'list-select'; itemName: string; itemIndex: number }
    | { type: 'click' | 'double-click' | 'scroll-up' | 'scroll-down' }
): Promise<void> {
  log(`Event: ${JSON.stringify(event)} | state: ${state.name}`)

  // ── Setup (splash screen — tap to start) ────────────────────────────
  if (state.name === 'setup') {
    if (event.type === 'click') {
      log('[setup] Tap to start — loading cameras')
      await loadCameras(true)
    }
    return
  }

  // ── Menu (text-based, scroll to select, click to confirm) ────────────
  if (state.name === 'menu') {
    const { menuIndex } = state

    if (event.type === 'scroll-up' || event.type === 'scroll-down') {
      const next = menuIndex === 0 ? 1 : 0
      state = { ...state, menuIndex: next }
      await updateMenuText(buildMenuText(next))
      return
    }

    if (event.type === 'click') {
      const selected = MENU_ITEMS[menuIndex]
      log(`Menu confirm: "${selected}" (index ${menuIndex})`)

      if (selected === MENU_BROWSE) {
        const highways = Object.keys(cameras)
        state = { name: 'highway-list', highways, page: 0 }
        await showHighwayList(highways, 0)
        return
      }

      if (selected === MENU_QUAD) {
        await enterQuadView(0)
        return
      }
    }
    return
  }

  // ── Quad View ────────────────────────────────────────────────────────────
  if (state.name === 'quad-view') {
    const { page } = state
    const favs = resolveFavorites()
    const totalPages = Math.max(1, Math.ceil(favs.length / QUAD_PAGE_SIZE))

    if (event.type === 'double-click') {
      await goToMenu()
      return
    }

    if (event.type === 'click') {
      // Refresh current quad page
      await loadQuadPage(favs, page)
      return
    }

    if (event.type === 'scroll-down') {
      const next = Math.min(totalPages - 1, page + 1)
      if (next !== page) {
        state = { name: 'quad-view', page: next }
        await updateCameraViewText(`Page ${next + 1}/${totalPages}`)
        await loadQuadPage(favs, next)
      }
      return
    }

    if (event.type === 'scroll-up') {
      const prev = Math.max(0, page - 1)
      if (prev !== page) {
        state = { name: 'quad-view', page: prev }
        await updateCameraViewText(`Page ${prev + 1}/${totalPages}`)
        await loadQuadPage(favs, prev)
      }
      return
    }
    return
  }

  // ── Highway List ─────────────────────────────────────────────────────────
  if (state.name === 'highway-list') {
    // Double-click goes back to menu
    if (event.type === 'double-click') {
      await goToMenu()
      return
    }
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
        activeFullView = fullView
        if (fullView) {
          const tiles = await fetchCameraImageTiledCached(cam.imageURL)
          await showCameraViewFull(highway, cams, cameraIndex, tiles)
        } else {
          const imageData = await fetchCameraImageDataCached(cam.imageURL)
          await showCameraView(highway, cams, cameraIndex, imageData)
        }
        await updateCameraViewText(`${cameraIndex + 1}/${cams.length}`)
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
        await updateCameraViewText(`No image\n${cam.title}`)
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
      const modeChanged = fullView !== activeFullView
      if (modeChanged) log(`[tap] View mode changed — rebuilding page layout`)
      log(`[tap] Refresh — cameraID=${cam.cameraID} title="${cam.title}" fullView=${fullView}`)
      setStatus(`Refreshing: ${cam.title}`, 'info')
      try {
        activeFullView = fullView
        if (fullView) {
          const tiles = await fetchCameraImageTiledFresh(cam.imageURL)
          if (modeChanged) {
            await showCameraViewFull(highway, cams, cameraIndex, tiles)
          } else {
            await sendCameraImageFull(tiles, cam.title)
          }
        } else {
          const imageData = await fetchCameraImageFresh(cam.imageURL)
          if (modeChanged) {
            await showCameraView(highway, cams, cameraIndex, imageData)
          } else {
            await sendCameraImage(imageData, cam.title)
          }
        }
        await updateCameraViewText(`${cameraIndex + 1}/${cams.length}`)
        setStatus(`Showing: ${cam.title}`, 'ok')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`[tap] Refresh error: ${msg}`)
        setStatus(`No image: ${cam.title}`, 'error')
        await updateCameraViewText(`No image\n${cam.title}`)
      }
      return
    }

    if (event.type === 'scroll-up') {
      cameraIndex = Math.max(0, cameraIndex - 1)
      state = { ...state, cameraIndex }
      const cam = cams[cameraIndex]
      await updateCameraViewText(`${cameraIndex + 1}/${cams.length}`)
      scheduleImageFetch(cam.imageURL, cam.title, cam.cameraID)
      return
    }

    if (event.type === 'scroll-down') {
      cameraIndex = Math.min(cams.length - 1, cameraIndex + 1)
      state = { ...state, cameraIndex }
      const cam = cams[cameraIndex]
      await updateCameraViewText(`${cameraIndex + 1}/${cams.length}`)
      scheduleImageFetch(cam.imageURL, cam.title, cam.cameraID)
      return
    }
  }
}

async function loadAndSendImage(imageURL: string, title: string): Promise<void> {
  const modeChanged = fullView !== activeFullView
  if (modeChanged) log(`[scroll] View mode changed — rebuilding page layout`)
  log(`Fetching image: ${title} [fullView=${fullView}]`)
  setStatus(`Loading: ${title}`, 'info')
  try {
    activeFullView = fullView
    if (fullView) {
      const tiles = await fetchCameraImageTiledCached(imageURL)
      if (modeChanged && state.name === 'camera-view') {
        const { highway, cameras: cams, cameraIndex } = state
        await showCameraViewFull(highway, cams, cameraIndex, tiles)
      } else {
        await sendCameraImageFull(tiles, title)
      }
    } else {
      const imageData = await fetchCameraImageDataCached(imageURL)
      if (modeChanged && state.name === 'camera-view') {
        const { highway, cameras: cams, cameraIndex } = state
        await showCameraView(highway, cams, cameraIndex, imageData)
      } else {
        await sendCameraImage(imageData, title)
      }
    }
    setStatus(`Showing: ${title}`, 'ok')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Image error: ${msg}`)
    setStatus(`No image: ${title}`, 'error')
    await updateCameraViewText(`No image\n${title}`)
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  initDebugPanel()
  log('Road View booting...')

  try {
    const bridge = await getBridge()

    // Encode splash image at boot — menu reuses the same page layout
    try {
      splashImageData = await encodeSplashImage()
      await showSplash(splashImageData)
    } catch (err) {
      log(`Splash error: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Restore persisted favorites
    await loadFavorites()

    const savedCode = await bridge.getLocalStorage('accessCode')
    if (savedCode) {
      $accessCode.value = savedCode
      log(`Restored access code: ${savedCode.slice(0, 4)}...`)
    }

    // Clear any stale camera data from previous sessions.
    await bridge.setLocalStorage('cameras', '')
    log('[boot] Cleared stale camera cache — fresh fetch required')

    log('[input] Ring controls: SWIPE = scroll up/down | PRESS ring button = click | DOUBLE PRESS = double-click')

    await listenGlassesEvents((event) => {
      handleGlassesEvent(event).catch((err) => {
        log(`Event handler error: ${err instanceof Error ? err.message : String(err)}`)
      })
    })

    // Update the time display every 30 seconds
    setInterval(() => {
      updateTime().catch(() => {})
    }, 30_000)

    log('Boot complete — event listener active')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Boot warning: ${msg}`)
  }
}

boot()
