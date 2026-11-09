/**
 * The answer for the ESLint language server's `workspace/configuration`
 * requests. The server asks for `{ scopeUri, section: '' }` on every
 * settings resolution, and it expects the full VS Code `eslint.*`
 * settings object — with the extension's defaults applied — not an
 * empty object and not null.
 *
 * Verified live against vscode-langservers-extracted@4.10.0 +
 * ESLint 8.57.0 + a legacy `.eslintrc.json`, driven by a JSON-RPC
 * harness that mimics Terax's client (which answers every
 * server-to-client request with null):
 * - answering `null` makes every pull fail with
 *   `-32603 Cannot read properties of null (reading
 *   'workingDirectory')` (the server reads
 *   `configuration.workingDirectory` unconditionally);
 * - answering `{}` fails at `path.isAbsolute(undefined)` (the
 *   server's `nodePath !== null` check passes for `undefined`) and
 *   at `settings.problems` being undefined;
 * - answering this object loads the project's own ESLint, probes the
 *   config type (`eslintrc`), and returns diagnostics — including
 *   the exact `'cvReport' is assigned a value but never used`
 *   diagnostic for a `.tsx` file.
 *
 * Field notes (all of them load-bearing, none of them decorative):
 * - `validate: 'probe'` lets the server turn validation on only
 *   when the file has a config and a library; `'on'` would skip the
 *   probe, `'off'` disables validation outright.
 * - `nodePath` must be `null`, not `undefined`: the server's
 *   `!== null` guard treats `undefined` as a real path and crashes
 *   in `path.isAbsolute`.
 * - `experimental` must be an object (`settings.experimental
 *   .useFlatConfig` is read unconditionally); `{}` keeps flat config
 *   off, so ESLint 8 keeps using `.eslintrc`.
 * - `problems` must be an object (`settings.problems
 *   .shortenToSingleLine` is read while building diagnostics).
 * - `useFlatConfig: null` follows ESLint's own rollout (8.57
 *   defaults to eslintrc, 9.x defaults to flat).
 */
export const ESLINT_WORKSPACE_CONFIGURATION: Record<string, unknown> = {
  validate: "probe",
  packageManager: "npm",
  nodePath: null,
  useFlatConfig: null,
  experimental: {},
  options: {},
  run: "onType",
  debug: false,
  quiet: false,
  problems: { shortenToSingleLine: false },
  rulesCustomizations: [],
  codeAction: {
    disableRuleComment: {},
    showDocumentation: { enable: false },
  },
  codeActionOnSave: { enable: false, mode: "all" },
};
