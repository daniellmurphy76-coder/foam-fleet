import { defineConfig, type Plugin } from 'vite';

/**
 * Every build gets an id (the git commit on GitHub, else the build time). It is baked into the code as
 * __BUILD_ID__ and also written to version.json next to index.html, so a running game can ask the site
 * "is there a newer build?" (see src/game/updates.ts).
 */
const BUILD_ID =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GITHUB_SHA?.slice(0, 12) ||
  new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

function versionFile(): Plugin {
  return {
    name: 'foam-fleet-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: BUILD_ID }) });
    },
  };
}

export default defineConfig(({ command }) => ({
  // Relative asset paths, so the built game works from any folder,
  // e.g. https://<user>.github.io/foam-fleet/ on GitHub Pages.
  base: './',
  define: { __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : 'dev') },
  plugins: [versionFile()],
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
}));
