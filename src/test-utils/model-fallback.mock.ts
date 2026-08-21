export async function runWithModelFallback(params: {
  provider: string;
  model: string;
  includeCandidatePosition?: boolean;
  run: (
    provider: string,
    model: string,
    options?: {
      allowTransientCooldownProbe?: boolean;
      isFinalFallbackCandidate?: boolean;
    },
  ) => Promise<unknown>;
}) {
  return {
    result: await params.run(
      params.provider,
      params.model,
      params.includeCandidatePosition ? { isFinalFallbackCandidate: true } : undefined,
    ),
    provider: params.provider,
    model: params.model,
  };
}
