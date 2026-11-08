/// <reference types="vite/client" />

/** True only in builds made with `TERAX_BENCH=1` (scripts/app-lab); a literal `false` otherwise. */
declare const __TERAX_BENCH__: boolean;

/** Short git commit baked in at build time (`vite.config.ts`); `"dev"` when git was unavailable. */
declare const __TERAX_COMMIT__: string;
