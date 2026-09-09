/// <reference types="vite/client" />

/**
 * Git commit of the running build, injected by vite.config.ts `define`.
 * Undefined outside a vite build (tsx scripts, tests) - read it through
 * `typeof __BUILD_COMMIT__ === 'string'`.
 */
declare const __BUILD_COMMIT__: string | undefined;
