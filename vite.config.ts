import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

// Content-Security-Policy is set via <meta http-equiv> in index.html (fine for static hosting).
// Use a server header + nonces/hashes here only if you need stricter injection rules than the meta tag allows.

// Root hosting (default). GitHub Pages project site: `base: '/repo-name/'`. Relative asset URLs: `base: './'`.
const base = '/';

/**
 * Rolldown (Vite 8) requires `manualChunks` to be a function; Rollup’s declarative
 * `{ 'react-vendor': ['react', 'react-dom'] }` map is rejected at runtime (“Expected Function”).
 * These checks match package roots under npm or pnpm (`.pnpm/.../node_modules/...`).
 */
function manualReactVendorChunk(id: string): string | undefined {
  if (id.includes('node_modules/react-dom/')) return 'react-vendor';
  if (id.includes('node_modules/react/')) return 'react-vendor';
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    /** Prefer 5173; if another project (or stale Vite) holds it, try 5174, 5175, … */
    strictPort: false,
  },
  preview: {
    port: 4173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: manualReactVendorChunk,
      },
    },
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
})
