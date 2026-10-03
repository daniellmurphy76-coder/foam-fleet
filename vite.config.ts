import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built game works from any folder,
  // e.g. https://<user>.github.io/foam-fleet/ on GitHub Pages.
  base: './',
  server: { port: 5180, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
