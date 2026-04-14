import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig(({ command, mode }) => {
  const isEvenHubBuild = mode === 'evenhub'

  return {
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
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
    base: isEvenHubBuild ? './' : '/',
    plugins: isEvenHubBuild ? [viteSingleFile()] : [],
    build: {
      target: 'esnext',
      emptyOutDir: true,
    },
  }
})
