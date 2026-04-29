export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "./types.js";

export {
  registerContextEngine,
  getContextEngineFactory,
  listContextEngineIds,
  resolveContextEngine,
} from "./registry.js";
export type { ContextEngineFactory } from "./registry.js";

export { LegacyContextEngine, registerLegacyContextEngine } from "./legacy.js";

export {
  MagisterIntegrationsContextEngine,
  registerMagisterIntegrationsContextEngine,
} from "./magister-integrations.js";

export { ensureContextEnginesInitialized } from "./init.js";
