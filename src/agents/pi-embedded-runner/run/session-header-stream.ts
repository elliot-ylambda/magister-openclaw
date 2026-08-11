import type { StreamFn } from "@mariozechner/pi-agent-core";

const SESSION_HEADER = "X-Session-Id";
const ACTIVITY_SESSION_HEADER = "X-Magister-Activity-Session-Id";

export function wrapStreamFnWithSessionHeader(
  streamFn: StreamFn,
  sessionKey: string | undefined,
  activitySessionKey?: string,
): StreamFn {
  if (!sessionKey) {
    return streamFn;
  }

  return (model, context, options) => {
    const headers = Object.fromEntries(
      Object.entries(options?.headers ?? {}).filter(
        ([name]) =>
          name.toLowerCase() !== SESSION_HEADER.toLowerCase() &&
          name.toLowerCase() !== ACTIVITY_SESSION_HEADER.toLowerCase(),
      ),
    );
    return streamFn(model, context, {
      ...options,
      headers: {
        ...headers,
        [SESSION_HEADER]: sessionKey,
        ...(activitySessionKey ? { [ACTIVITY_SESSION_HEADER]: activitySessionKey } : {}),
      },
    });
  };
}
