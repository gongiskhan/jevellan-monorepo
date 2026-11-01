// Vite build of the jevellan-ui web app (brief section 7): web/ (React 19, TypeScript) to dist/web/, which the UI
// server serves with index.html for every route. `npm run build:web` typechecks with tsconfig.web.json first.
//
// One zod in the bundle: @a2ui/react and @a2ui/web_core need zod 3 (their peer and own dependency), the repository
// root keeps zod 4 for the other packages, and npm nests a zod 3 copy under each @a2ui package. Every bare `zod`
// import of the web bundle resolves to packages/ui's own zod 3.25.76 so the copies are not bundled twice.
//
// No inline script or style ends up in index.html (the UI server's Content-Security-Policy is script-src 'self' and
// style-src 'self', D-064): CSS is emitted as files and the module preload polyfill stays off.

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('./web'),
  publicDir: here('./web/public'),
  base: '/',
  plugins: [react()],
  resolve: {
    alias: [{ find: /^zod$/, replacement: here('./node_modules/zod/index.js') }],
  },
  build: {
    outDir: here('./dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 1500,
  },
  server: { host: '127.0.0.1', port: 7074, strictPort: false },
});
