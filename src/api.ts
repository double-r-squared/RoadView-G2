/// <reference types="vite/client" />
import type { CameraStore } from './types'
import { log } from './debug'
import splashUrl from './assets/highway--v2.jpg'

// Encode the bundled splash image to PNG bytes for the glasses display.
// Loads via Image element directly (no fetch) so it works in packaged WebViews
// where fetch() for local bundled assets may be restricted.
// Times out after 3s so boot is never blocked.
export function encodeSplashImage(): Promise<number[]> {
  log(`[splash] encoding local asset: ${splashUrl}`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      log('[splash] timed out after 3s')
      reject(new Error('Splash image load timed out'))
    }, 3000)

    const img = new Image()
    img.onload = () => {
      clearTimeout(timer)
      const canvas = document.createElement('canvas')
      canvas.width = 200
      canvas.height = 100
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('canvas 2d context unavailable')); return }
      ctx.drawImage(img, 0, 0, 200, 100)
      canvas.toBlob(
        (b) => {
          if (!b) { reject(new Error('toBlob returned null')); return }
          b.arrayBuffer()
            .then((ab) => {
              const data = Array.from(new Uint8Array(ab))
              log(`[splash] encoded — ${data.length} bytes`)
              resolve(data)
            })
            .catch(reject)
        },
        'image/png'
      )
    }
    img.onerror = () => {
      clearTimeout(timer)
      log('[splash] Image element onerror fired')
      reject(new Error('Splash image failed to load'))
    }
    img.src = splashUrl
  })
}

// In dev mode (QR / npm run dev) the Even App loads the page without reading
// app.json, so no network permissions are granted and all external fetch()
// calls are blocked by the WebView. We route through the Vite dev server proxy
// instead. In production, route through the Cloudflare Worker CORS proxy
// because the WSDOT API doesn't return CORS headers.
const IS_DEV = import.meta.env.DEV

const CORS_PROXY = 'https://roadview-proxy.roadview.workers.dev/proxy?url='

const WSDOT_API_BASE = 'https://wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc'

log(`[api] mode=${IS_DEV ? 'dev (proxied)' : 'prod (worker)'}`)

// Builds the fetch URL for the WSDOT camera list API.
// Dev: Vite proxy. Prod: Cloudflare Worker CORS proxy.
function toApiURL(path: string): string {
  if (IS_DEV) return `/proxy/wsdot${path}`
  return `${CORS_PROXY}${encodeURIComponent(`${WSDOT_API_BASE}${path}`)}`
}

// Rewrites image URLs for the current environment at fetch time.
// In dev: proxy through Vite. In prod: route through Cloudflare Worker CORS proxy.
function toFetchURL(raw: string): string {
  if (IS_DEV) {
    return raw.replace('https://images.wsdot.wa.gov', '/proxy/images')
  }
  // Production — fix any stale proxied URLs from dev, then wrap in CORS proxy
  const canonical = raw.replace(/^\/proxy\/images/, 'https://images.wsdot.wa.gov')
  return `${CORS_PROXY}${encodeURIComponent(canonical)}`
}

interface WSDOTCamera {
  CameraID: number
  Title: string
  ImageURL: string
  IsActive: boolean
  CameraLocation: {
    RoadName: string
  }
}

export async function fetchAllCameras(accessCode: string): Promise<CameraStore> {
  const url = toApiURL(`/GetCamerasAsJson?AccessCode=${encodeURIComponent(accessCode)}`)

  log(`[fetch] GET ${url}`)

  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    // TypeError here means the request never left — blocked by WebView, CORS,
    // or no network. Not an HTTP error.
    const name = err instanceof Error ? err.name : 'UnknownError'
    const msg  = err instanceof Error ? err.message : String(err)
    log(`[fetch] BLOCKED — ${name}: ${msg}`)
    log(`[fetch] If this is "TypeError: Failed to fetch", the URL is likely not in the app.json whitelist.`)
    throw new Error(`Network blocked (${name}): ${msg}`)
  }

  log(`[fetch] Response: ${res.status} ${res.statusText}`)
  log(`[fetch] Content-Type: ${res.headers.get('content-type') ?? 'none'}`)

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable body)')
    log(`[fetch] Error body: ${body.slice(0, 200)}`)
    throw new Error(`WSDOT API ${res.status}: ${res.statusText}`)
  }

  const cameras: WSDOTCamera[] = await res.json()
  log(`[fetch] Parsed ${cameras.length} raw camera entries`)
  const store: CameraStore = {}

  for (const cam of cameras) {
    if (!cam.IsActive) continue
    const road = cam.CameraLocation?.RoadName?.trim() || 'Unknown'
    if (!store[road]) store[road] = []
    store[road].push({
      cameraID: cam.CameraID,
      title: cam.Title,
      imageURL: cam.ImageURL,
    })
  }

  // Sort highways alphabetically
  return Object.fromEntries(
    Object.entries(store).sort(([a], [b]) => a.localeCompare(b))
  )
}

// In-memory image cache — keyed by image URL.
// Avoids re-fetching when scrolling back to a previously viewed camera.
// Not persisted to localStorage (image byte arrays are too large).
const imageCache = new Map<string, number[]>()

export async function fetchCameraImageDataCached(imageURL: string): Promise<number[]> {
  const cached = imageCache.get(imageURL)
  if (cached) {
    log(`[cache] HIT — skipping network: ${imageURL}`)
    return cached
  }
  log(`[cache] MISS — fetching: ${imageURL}`)
  const data = await fetchCameraImageData(imageURL)
  imageCache.set(imageURL, data)
  log(`[cache] stored ${data.length} bytes for: ${imageURL}`)
  return data
}

// Fetches a fresh image, bypassing the cache. Used for tap-to-refresh in
// camera view — ensures we display the latest snapshot from WSDOT.
export async function fetchCameraImageFresh(imageURL: string): Promise<number[]> {
  log(`[fetch] FRESH (bypass cache): ${imageURL}`)
  const data = await fetchCameraImageData(imageURL)
  // Update the cache so subsequent scroll-backs use the fresh copy
  imageCache.set(imageURL, data)
  log(`[fetch] FRESH done — ${data.length} bytes`)
  return data
}

// ─── Full-view tiled image pipeline ──────────────────────────────────────────
// Fetches an image and slices it into a 2×2 grid of 200×100 PNG tiles.
// Each tile is returned as number[] (PNG file bytes) ready for updateImageRawData.
// Order: [top-left, top-right, bottom-left, bottom-right]

const tiledImageCache = new Map<string, number[][]>()

export async function fetchCameraImageTiledCached(imageURL: string): Promise<number[][]> {
  const cached = tiledImageCache.get(imageURL)
  if (cached) {
    log(`[cache] HIT tiled — skipping network: ${imageURL}`)
    return cached
  }
  log(`[cache] MISS tiled — fetching: ${imageURL}`)
  const tiles = await fetchCameraImageTiled(imageURL)
  tiledImageCache.set(imageURL, tiles)
  log(`[cache] stored ${tiles.length} tiles for: ${imageURL}`)
  return tiles
}

export async function fetchCameraImageTiledFresh(imageURL: string): Promise<number[][]> {
  log(`[fetch] FRESH tiled (bypass cache): ${imageURL}`)
  const tiles = await fetchCameraImageTiled(imageURL)
  tiledImageCache.set(imageURL, tiles)
  log(`[fetch] FRESH tiled done — ${tiles.length} tiles`)
  return tiles
}

export async function fetchCameraImageTiled(imageURL: string): Promise<number[][]> {
  const url = toFetchURL(imageURL)
  log(`[fetch] GET (tiled) ${url}`)

  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    const name = err instanceof Error ? err.name : 'UnknownError'
    const msg  = err instanceof Error ? err.message : String(err)
    log(`[fetch] Image BLOCKED — ${name}: ${msg}`)
    throw new Error(`Image network blocked (${name}): ${msg}`)
  }

  log(`[fetch] Tiled image response: ${res.status} ${res.statusText}`)
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${res.statusText}`)

  const blob = await res.blob()
  const objURL = URL.createObjectURL(blob)

  return new Promise((resolve, reject) => {
    const img = new Image()

    img.onload = () => {
      // Draw the source image scaled to 400×200 (2×2 tiles of 200×100 each)
      const fullCanvas = document.createElement('canvas')
      fullCanvas.width  = 400
      fullCanvas.height = 200
      const ctx = fullCanvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(objURL)
        reject(new Error('canvas 2d context unavailable'))
        return
      }
      ctx.drawImage(img, 0, 0, 400, 200)
      URL.revokeObjectURL(objURL)

      // Extract four 200×100 tiles: TL, TR, BL, BR
      const tileOrigins = [
        { sx: 0,   sy: 0   },
        { sx: 200, sy: 0   },
        { sx: 0,   sy: 100 },
        { sx: 200, sy: 100 },
      ]

      const tilePromises = tileOrigins.map(({ sx, sy }) => {
        const tile = document.createElement('canvas')
        tile.width  = 200
        tile.height = 100
        const tc = tile.getContext('2d')
        if (!tc) return Promise.reject(new Error('tile canvas 2d context unavailable'))
        tc.drawImage(fullCanvas, sx, sy, 200, 100, 0, 0, 200, 100)
        return new Promise<number[]>((res, rej) => {
          tile.toBlob(
            (b) => {
              if (!b) { rej(new Error('toBlob returned null')); return }
              b.arrayBuffer()
                .then((ab) => res(Array.from(new Uint8Array(ab))))
                .catch(rej)
            },
            'image/png'
          )
        })
      })

      Promise.all(tilePromises).then(resolve).catch(reject)
    }

    img.onerror = () => {
      URL.revokeObjectURL(objURL)
      reject(new Error('Image element failed to load'))
    }

    img.src = objURL
  })
}

export async function fetchCameraImageData(imageURL: string): Promise<number[]> {
  const url = toFetchURL(imageURL)
  log(`[fetch] GET ${url}`)

  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    const name = err instanceof Error ? err.name : 'UnknownError'
    const msg  = err instanceof Error ? err.message : String(err)
    log(`[fetch] Image BLOCKED — ${name}: ${msg}`)
    throw new Error(`Image network blocked (${name}): ${msg}`)
  }

  log(`[fetch] Image response: ${res.status} ${res.statusText}`)
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${res.statusText}`)

  const blob = await res.blob()

  const objURL = URL.createObjectURL(blob)

  return new Promise((resolve, reject) => {
    const img = new Image()

    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 200
      canvas.height = 100
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(objURL)
        reject(new Error('canvas 2d context unavailable'))
        return
      }
      ctx.drawImage(img, 0, 0, 200, 100)
      URL.revokeObjectURL(objURL)

      canvas.toBlob(
        (b) => {
          if (!b) { reject(new Error('toBlob returned null')); return }
          b.arrayBuffer()
            .then((ab) => resolve(Array.from(new Uint8Array(ab))))
            .catch(reject)
        },
        'image/png'
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(objURL)
      reject(new Error('Image element failed to load'))
    }

    img.src = objURL
  })
}
