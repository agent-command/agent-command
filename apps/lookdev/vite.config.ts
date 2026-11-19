import { defineConfig } from 'vite';

// Standalone look-development sandbox: no game code, no server.
export default defineConfig({
  server: { port: 5190 },
  build: { target: 'es2023', chunkSizeWarningLimit: 1500 },
});
