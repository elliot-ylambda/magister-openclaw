import {
  resolveProviderHttpRequestConfig,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import { parseGeminiAuth } from "./gemini-auth.js";
export { parseGeminiAuth };
export { applyGoogleGeminiModelDefault, GOOGLE_GEMINI_DEFAULT_MODEL } from "./onboard.js";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
} from "./provider-policy.js";
export { normalizeAntigravityModelId, normalizeGoogleModelId } from "./model-id.js";
export {
  createGoogleThinkingPayloadWrapper,
  createGoogleThinkingStreamWrapper,
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  isGoogleGemini3ThinkingLevelModel,
  isGoogleThinkingRequiredModel,
  resolveGoogleGemini3ThinkingLevel,
  sanitizeGoogleThinkingPayload,
  stripInvalidGoogleThinkingBudget,
  type GoogleThinkingInputLevel,
  type GoogleThinkingLevel,
} from "./thinking-api.js";
export {
  buildGoogleGenerativeAiParams,
  createGoogleGenerativeAiTransportStreamFn,
} from "./transport-stream.js";
export {
  DEFAULT_GOOGLE_API_BASE_URL,
  isGoogleGenerativeAiApi,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiApiOrigin,
  resolveGoogleGenerativeAiTransport,
  shouldNormalizeGoogleGenerativeAiProviderConfig,
  shouldNormalizeGoogleProviderConfig,
} from "./provider-policy.js";
export { buildGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
export { buildGoogleProvider } from "./provider-registration.js";

type GoogleGenerativeAiRequestOverrides = ProviderRequestTransportOverrides & {
  allowPrivateNetwork?: boolean;
};

// Magister fork patch: allow http:// to the internal Fly gateway and the exact local
// credential-broker route so image/audio/video generation can reach gemini_proxy.py
// without exposing the real Gemini key to tenant processes. The .internal TLD is Fly's
// private 6PN namespace; the loopback listener and path are fixed by the machine image.
// See openclaw-image/entrypoint.sh and docs/openclaw-sync.md (Fork-specific patches).
const TRUSTED_INTERNAL_GENAI_HOSTNAMES: ReadonlySet<string> = new Set([
  "magister-gateway.internal",
]);
const TRUSTED_LOCAL_GENAI_BROKER_ORIGIN = "http://127.0.0.1:18796";
const TRUSTED_LOCAL_GENAI_BROKER_PATH = "/api/gemini";

function isTrustedLocalGenAiBrokerUrl(url: URL): boolean {
  return (
    url.origin === TRUSTED_LOCAL_GENAI_BROKER_ORIGIN &&
    (url.pathname === TRUSTED_LOCAL_GENAI_BROKER_PATH ||
      url.pathname.startsWith(`${TRUSTED_LOCAL_GENAI_BROKER_PATH}/`))
  );
}

function resolveTrustedGoogleGenerativeAiBaseUrl(baseUrl?: string): string {
  const normalized =
    normalizeGoogleGenerativeAiBaseUrl(baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL) ??
    DEFAULT_GOOGLE_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(
      "Google Generative AI baseUrl must be a valid https URL on generativelanguage.googleapis.com",
    );
  }
  const hostname = url.hostname.toLowerCase();
  const isCanonicalGoogle =
    url.protocol === "https:" && hostname === "generativelanguage.googleapis.com";
  const isTrustedInternalProxy =
    url.protocol === "http:" && TRUSTED_INTERNAL_GENAI_HOSTNAMES.has(hostname);
  const isTrustedLocalBroker = isTrustedLocalGenAiBrokerUrl(url);
  if (!isCanonicalGoogle && !isTrustedInternalProxy && !isTrustedLocalBroker) {
    throw new Error(
      "Google Generative AI baseUrl must use https://generativelanguage.googleapis.com",
    );
  }
  return normalized;
}

export function resolveGoogleGenerativeAiHttpRequestConfig(params: {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: GoogleGenerativeAiRequestOverrides;
  capability: "image" | "audio" | "video";
  transport: "http" | "media-understanding";
}) {
  return resolveProviderHttpRequestConfig({
    baseUrl: resolveTrustedGoogleGenerativeAiBaseUrl(params.baseUrl),
    defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
    allowPrivateNetwork: params.request?.allowPrivateNetwork,
    headers: params.headers,
    request: params.request,
    defaultHeaders: parseGeminiAuth(params.apiKey).headers,
    provider: "google",
    api: "google-generative-ai",
    capability: params.capability,
    transport: params.transport,
  });
}
