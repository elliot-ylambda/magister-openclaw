import { registerLegacyContextEngine } from "./legacy.registration.js";
import { registerMagisterIntegrationsContextEngine } from "./magister-integrations.js";
import { registerMagisterMemoryContextEngine } from "./magister-memory.js";
import { registerMagisterPlanContextEngine } from "./magister-plan.js";
import { registerMagisterWorkflowsContextEngine } from "./magister-workflows.js";

/**
 * Ensures all built-in context engines are registered exactly once.
 *
 * The legacy engine is always registered as a safe fallback so that
 * `resolveContextEngine()` can resolve the default "legacy" slot without
 * callers needing to remember manual registration.
 *
 * Additional engines are registered by their own plugins via
 * `api.registerContextEngine()` during plugin load.
 */
let initialized = false;

export function ensureContextEnginesInitialized(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  // Always available – safe fallback for the "legacy" slot default.
  registerLegacyContextEngine();

  // Magister fork: wraps legacy and folds INTEGRATIONS.md into per-turn context.
  registerMagisterIntegrationsContextEngine();

  // Magister fork: composes with magister-integrations and additionally folds
  // WORKFLOWS.md into per-turn context.
  //   Workflows → Integrations → Legacy
  registerMagisterWorkflowsContextEngine();

  // Magister fork: folds the live marketing plan into every turn by reading
  // the gateway summary endpoint, with PLAN.md as a local fallback.
  //   Plan → Workflows → Integrations → Legacy
  registerMagisterPlanContextEngine();

  // Magister fork: composes ON TOP of magister-workflows and folds MEMORY.md +
  // USER.md into the system prompt as a per-session frozen snapshot. The active
  // slot in the gateway-image entrypoint selects 'magister-memory', yielding
  // the full chain:
  //   Memory (frozen) → Plan → Workflows → Integrations → Legacy
  registerMagisterMemoryContextEngine();
}
