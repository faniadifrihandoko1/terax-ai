/**
 * Short git commit baked in at build time (vite `define` in
 * `vite.config.ts`). The app version stays 0.9.0 across fork phases,
 * so this is how a running build is identified — see Settings →
 * About. `"dev"` when the build ran without git.
 */
export const BUILD_COMMIT: string = __TERAX_COMMIT__;
