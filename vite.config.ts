import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Use relative paths for SharePoint compatibility
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // Generate a single JS file for simpler deployment
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});
