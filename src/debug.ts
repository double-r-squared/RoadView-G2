const MAX_ENTRIES = 200

let _panel: HTMLElement | null = null
let _list: HTMLElement | null = null

export function initDebugPanel(): void {
  _panel = document.getElementById('debug-panel')
  _list = document.getElementById('debug-list')
}

export function log(message: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
  const entry = `[${ts}] ${message}`

  // Always print to browser console
  console.log(entry)

  if (!_list) return

  const li = document.createElement('li')
  li.textContent = entry
  _list.appendChild(li)

  // Trim old entries
  while (_list.children.length > MAX_ENTRIES) {
    _list.removeChild(_list.firstChild!)
  }

  // Auto-scroll to bottom if panel is open
  if (_panel && !_panel.classList.contains('collapsed')) {
    _list.scrollTop = _list.scrollHeight
  }
}
