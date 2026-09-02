import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-transport-stream.js";
import { getModelProviderRequestTransport } from "./provider-request-config.js";

const SUPPORTED_TRANSPORT_APIS = new Set<Api>([
  "openai-responses",
  "openai-codex-responses",
  "openai-completions",
  "azure-openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

const SIMPLE_TRANSPORT_API_ALIAS: Record<string, Api> = {
  "openai-responses": "openclaw-openai-responses-transport",
  "openai-codex-responses": "openclaw-openai-responses-transport",
  "openai-completions": "openclaw-openai-completions-transport",
  "azure-openai-responses": "openclaw-azure-openai-responses-transport",
  "anthropic-messages": "openclaw-anthropic-messages-transport",
  "google-generative-ai": "openclaw-google-generative-ai-transport",
};

type ProviderTransportStreamContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

// Every stream function built here understands SYSTEM_PROMPT_CACHE_BOUNDARY:
// the OpenAI-family and Anthropic transports split or strip it themselves, and
// the Google plugin transport strips it. The embedded runner strips the marker
// before handing a prompt to a provider-owned stream it cannot vouch for; this
// set lets it recognise its own transports and leave the marker in place so
// the split can happen.
const boundaryAwareTransportStreamFns = new WeakSet<StreamFn>();

export function markBoundaryAwareTransportStreamFn(streamFn: StreamFn): StreamFn {
  boundaryAwareTransportStreamFns.add(streamFn);
  return streamFn;
}

export function isBoundaryAwareTransportStreamFn(streamFn: StreamFn | undefined): boolean {
  return streamFn !== undefined && boundaryAwareTransportStreamFns.has(streamFn);
}

function createProviderOwnedGoogleTransportStreamFn(
  model: Model<Api>,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  return (
    resolveProviderStreamFn({
      provider: model.provider,
      config: ctx?.cfg,
      workspaceDir: ctx?.workspaceDir,
      env: ctx?.env,
      context: {
        config: ctx?.cfg,
        agentDir: ctx?.agentDir,
        workspaceDir: ctx?.workspaceDir,
        provider: model.provider,
        modelId: model.id,
        model,
      },
    }) ??
    resolveProviderStreamFn({
      provider: "google",
      config: ctx?.cfg,
      workspaceDir: ctx?.workspaceDir,
      env: ctx?.env,
      context: {
        config: ctx?.cfg,
        agentDir: ctx?.agentDir,
        workspaceDir: ctx?.workspaceDir,
        provider: model.provider,
        modelId: model.id,
        model,
      },
    }) ??
    undefined
  );
}

function createSupportedTransportStreamFn(
  model: Model<Api>,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  const streamFn = createSupportedTransportStreamFnUnmarked(model, ctx);
  return streamFn ? markBoundaryAwareTransportStreamFn(streamFn) : undefined;
}

function createSupportedTransportStreamFnUnmarked(
  model: Model<Api>,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  switch (model.api) {
    case "openai-responses":
    case "openai-codex-responses":
      return createOpenAIResponsesTransportStreamFn();
    case "openai-completions":
      return createOpenAICompletionsTransportStreamFn();
    case "azure-openai-responses":
      return createAzureOpenAIResponsesTransportStreamFn();
    case "anthropic-messages":
      return createAnthropicMessagesTransportStreamFn();
    case "google-generative-ai":
      return createProviderOwnedGoogleTransportStreamFn(model, ctx);
    default:
      return undefined;
  }
}

function hasTransportOverrides(model: Model<Api>): boolean {
  const request = getModelProviderRequestTransport(model);
  return Boolean(request?.proxy || request?.tls);
}

export function isTransportAwareApiSupported(api: Api): boolean {
  return SUPPORTED_TRANSPORT_APIS.has(api);
}

export function resolveTransportAwareSimpleApi(api: Api): Api | undefined {
  return SIMPLE_TRANSPORT_API_ALIAS[api];
}

export function createTransportAwareStreamFnForModel(
  model: Model<Api>,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  if (!hasTransportOverrides(model)) {
    return undefined;
  }
  if (!isTransportAwareApiSupported(model.api)) {
    throw new Error(
      `Model-provider request.proxy/request.tls is not yet supported for api "${model.api}"`,
    );
  }
  return createSupportedTransportStreamFn(model, ctx);
}

export function createOpenClawTransportStreamFnForModel(
  model: Model<Api>,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  // Explicit fallback callers use this when they need OpenClaw's HTTP
  // transport semantics regardless of the default embedded-runner strategy.
  // Native OpenAI HTTP still depends on this path for strict tool shaping,
  // attribution, cache-boundary stripping, and runtime credential injection.
  if (!isTransportAwareApiSupported(model.api)) {
    return undefined;
  }
  return createSupportedTransportStreamFn(model, ctx);
}

export function createBoundaryAwareStreamFnForModel(
  model: Model<Api>,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  // Default embedded-runner transport for every api listed above. PI's native
  // HTTP streams send the system prompt verbatim, cache-boundary marker
  // included, so they can neither split the prompt for caching nor keep the
  // marker off the wire; the embedded runner prefers these whenever they exist.
  if (!isTransportAwareApiSupported(model.api)) {
    return undefined;
  }
  return createSupportedTransportStreamFn(model, ctx);
}

export function prepareTransportAwareSimpleModel<TApi extends Api>(
  model: Model<TApi>,
  ctx?: ProviderTransportStreamContext,
): Model<Api> {
  const streamFn = createTransportAwareStreamFnForModel(model as Model<Api>, ctx);
  const alias = resolveTransportAwareSimpleApi(model.api);
  if (!streamFn || !alias) {
    return model;
  }
  return {
    ...model,
    api: alias,
  };
}

export function buildTransportAwareSimpleStreamFn(
  model: Model<Api>,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  return createTransportAwareStreamFnForModel(model, ctx);
}
