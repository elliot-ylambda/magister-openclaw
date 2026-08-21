import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { logToolLoopAction } from "../logging/diagnostic.js";
import {
  detectRuntimeResilienceBlock,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
  resolveRuntimeResilienceOutcomeDecision,
} from "./tool-loop-detection.js";

export const beforeToolCallRuntime = {
  getDiagnosticSessionState,
  logToolLoopAction,
  detectRuntimeResilienceBlock,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
  resolveRuntimeResilienceOutcomeDecision,
};
