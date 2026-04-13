import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // In dev mode the WebView has no app.json whitelist, so all external
      // fetch() calls are blocked. These proxy rules route API and image
      // requests through the local dev server, which is already allowed.
      '/proxy/wsdot': {
        target: 'https://wsdot.wa.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/wsdot/, '/Traffic/api/HighwayCameras/HighwayCamerasREST.svc'),
      },
      '/proxy/images': {
        target: 'https://images.wsdot.wa.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/images/, ''),
      },
    },
  },
})
