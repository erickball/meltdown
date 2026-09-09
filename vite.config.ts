import { defineConfig } from 'vite';
import { execSync } from 'child_process';

// The git commit of the build, stamped into bug reports so a reproduction
// can check out the exact physics that produced them. Missing git (a bare
// export of the tree) is reported as 'unknown' rather than failing the build.
function buildCommit(): string {
  try {
    const sha = execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: './', // Use relative paths for SharePoint compatibility
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'esnext', // Support top-level await
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
