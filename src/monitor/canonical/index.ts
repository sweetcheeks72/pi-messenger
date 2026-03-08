/**
 * Canonical State Model — public barrel export
 *
 * Re-exports all types, schemas, and normalization utilities from the
 * canonical state model. Import from this module, not from sub-files.
 *
 * @example
 * ```typescript
 * import { mapSessionLifecycle, deriveSections } from "./src/monitor/canonical/index.js";
 * ```
 */
export * from "./types.js";
export * from "./normalizer.js";
