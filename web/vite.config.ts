import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.BETSEND_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  build: {
    // The server serves this directory statically — one process, one port.
    outDir: '../server/public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true },
    },
  },
});
