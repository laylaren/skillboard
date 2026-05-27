import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // During `vite dev` we proxy /api/* to the local Fastify instance so the SPA
  // can hot-reload without rebuilding the server bundle on every change.
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7300',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
