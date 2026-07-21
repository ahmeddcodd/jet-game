import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so a production build can be served from any subpath.
  base: './',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    // .glb models live in public/ and are copied verbatim; nothing to inline.
    assetsInlineLimit: 0,
  },
});
