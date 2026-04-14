export interface CameraEntry {
  cameraID: number
  title: string
  imageURL: string
}

// Keyed by RoadName (e.g. "I-5", "SR-99")
export type CameraStore = Record<string, CameraEntry[]>

export type AppState =
  | { name: 'menu'; menuIndex: number }
  | { name: 'highway-list'; highways: string[]; page: number }
  | { name: 'camera-browse'; highway: string; cameras: CameraEntry[]; cameraIndex: number }
  | { name: 'camera-view'; highway: string; cameras: CameraEntry[]; cameraIndex: number }
  | { name: 'quad-view'; page: number }

// Max real items per list page.
// Worst case: PREV(1) + 18 items + NEXT(1) = 20 (SDK hard limit).
export const LIST_PAGE_SIZE = 18

export const NEXT_LABEL = '\u2192 Next Page'
export const PREV_LABEL = '\u2190 Prev Page'

export const MENU_BROWSE = '  Browse'
export const MENU_QUAD   = '  Favorites'
export const MENU_ITEMS  = [MENU_QUAD, MENU_BROWSE] as const

// Number of favorite cameras shown per quad-view page
export const QUAD_PAGE_SIZE = 4

// Container IDs.
// IMAGE-RENDERING.md requires the image container to be ID 2 with containerTotalNum=2.
// DISPLAY_TEXT and IMAGE never coexist, so they share ID 2.
// Full-view mode uses IDs 1–5: EVENT_TEXT + four 200×100 tiles in a 2×2 grid.
export const CONTAINER = {
  EVENT_TEXT:   1, // full-screen event capture (always present)
  DISPLAY_TEXT: 2, // visible text (camera browse only)
  IMAGE:        2, // single image (camera view) — same ID as DISPLAY_TEXT, never coexist
  IMAGE_TL:     2, // full-view tile: top-left
  IMAGE_TR:     3, // full-view tile: top-right
  IMAGE_BL:     4, // full-view tile: bottom-left
  IMAGE_BR:     5, // full-view tile: bottom-right
  MENU_LOGO:    2, // menu logo image (left side)
  MENU_TEXT:    3, // menu item text (right side)
} as const

export const CONTAINER_NAMES = {
  EVENT_TEXT:   'evt',
  DISPLAY_TEXT: 'display',
  IMAGE:        'cam-img',
  IMAGE_TL:     'cam-tl',
  IMAGE_TR:     'cam-tr',
  IMAGE_BL:     'cam-bl',
  IMAGE_BR:     'cam-br',
  MENU_LOGO:    'menu-logo',
  MENU_TEXT:    'menu-text',
} as const

// Full-view tile layout — 2×2 grid of 200×100 tiles centered on 576×288 canvas.
// xStart = (576-400)/2 = 88, yStart = (288-200)/2 = 44
export const FULL_VIEW_TILES = [
  { id: CONTAINER.IMAGE_TL, name: CONTAINER_NAMES.IMAGE_TL, x: 88,  y: 44  },
  { id: CONTAINER.IMAGE_TR, name: CONTAINER_NAMES.IMAGE_TR, x: 288, y: 44  },
  { id: CONTAINER.IMAGE_BL, name: CONTAINER_NAMES.IMAGE_BL, x: 88,  y: 144 },
  { id: CONTAINER.IMAGE_BR, name: CONTAINER_NAMES.IMAGE_BR, x: 288, y: 144 },
] as const
