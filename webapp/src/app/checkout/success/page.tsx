'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2, Circle, AlertCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { getAgentStatus } from '@/lib/gateway';

const SUBSCRIPTION_POLL_MS = 2_000;
const STATUS_POLL_MS = 3_000;
const TIMEOUT_MS = 360_000; // 6 minutes — covers worst case provisioning
const REDIRECT_DELAY_MS = 1_500;
const STEP_PACE_MS = 25_000; // visual step pacing: advance one step per 25s

const SETUP_STEPS = [
  { step: 0, label: 'Initializing agent' },
  { step: 1, label: 'Creating dedicated environment' },
  { step: 2, label: 'Configuring credentials' },
  { step: 3, label: 'Allocating storage' },
  { step: 4, label: 'Deploying AI agent' },
  { step: 5, label: 'Starting up' },
] as const;

type Phase = 'subscription' | 'provisioning' | 'ready' | 'error';

export default function CheckoutSuccessPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [phase, setPhase] = useState<Phase>('subscription');
  const [provisioningStep, setProvisioningStep] = useState(-1);
  const [displayStep, setDisplayStep] = useState(-1);
  const backendStepRef = useRef(-1);
  const [errorMessage, setErrorMessage] = useState('');

  // Phase 1: Poll for subscription activation
  useEffect(() => {
    if (phase !== 'subscription') return;

    const start = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch('/api/stripe/status');
        const { active } = await res.json();
        if (active) {
          setPhase('provisioning');
          return;
        }
      } catch {
        // Network error — keep polling
      }

      if (Date.now() - start > TIMEOUT_MS) {
        setErrorMessage(
          'Your payment was received but setup is taking longer than expected.'
        );
        setPhase('error');
        return;
      }

      timer = setTimeout(poll, SUBSCRIPTION_POLL_MS);
    }

    poll();
    return () => clearTimeout(timer);
  }, [phase]);

  // Keep ref in sync so the pacing timer always reads the latest backend step
  useEffect(() => {
    backendStepRef.current = provisioningStep;
  }, [provisioningStep]);

  // Visual step pacing: advance displayStep toward backendStep at a fixed cadence
  useEffect(() => {
    if (phase !== 'provisioning' || displayStep >= backendStepRef.current) return;

    // First step shows immediately, subsequent steps wait STEP_PACE_MS
    const delay = displayStep === -1 ? 0 : STEP_PACE_MS;
    const timer = setTimeout(() => {
      setDisplayStep((prev) => {
        const target = backendStepRef.current;
        return prev < target ? prev + 1 : prev;
      });
    }, delay);

    return () => clearTimeout(timer);
  }, [phase, displayStep, provisioningStep]);

  // Phase 2: Poll gateway for provisioning progress
  useEffect(() => {
    if (phase !== 'provisioning') return;

    const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
    if (!gatewayUrl) return;

    const start = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          timer = setTimeout(poll, STATUS_POLL_MS);
          return;
        }

        const data = await getAgentStatus(gatewayUrl!, session.access_token);

        if (data) {
          if (data.status === 'running') {
            setProvisioningStep(5);
            setPhase('ready');
            return;
          }

          if (data.status === 'failed') {
            setErrorMessage(
              'Something went wrong setting up your agent. Please try again.'
            );
            setPhase('error');
            return;
          }

          if (typeof data.provisioning_step === 'number') {
            setProvisioningStep(data.provisioning_step);
          }
        }
        // null = 404 (no machine record yet, webhook still processing)
      } catch {
        // Network error — keep polling
      }

      if (Date.now() - start > TIMEOUT_MS) {
        setErrorMessage(
          'Agent setup is taking longer than expected. Please try again.'
        );
        setPhase('error');
        return;
      }

      timer = setTimeout(poll, STATUS_POLL_MS);
    }

    poll();
    return () => clearTimeout(timer);
  }, [phase, supabase]);

  // Phase 3: Redirect when ready
  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = setTimeout(() => router.replace('/chat'), REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase, router]);

  const handleRetry = useCallback(async () => {
    setErrorMessage('');
    setPhase('provisioning');
    setProvisioningStep(-1);
    setDisplayStep(-1);
    backendStepRef.current = -1;

    try {
      await fetch('/api/provision/retry', { method: 'POST' });
    } catch {
      // If retry call fails, polling will pick up existing state
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-lg">
        {/* Header */}
        {phase === 'ready' ? (
          <div className="mb-6 flex items-center gap-3">
            <CheckCircle2 className="h-6 w-6 text-green-500" />
            <div>
              <h1 className="text-lg font-semibold">Your agent is ready!</h1>
              <p className="text-sm text-muted-foreground">
                Redirecting you now&hellip;
              </p>
            </div>
          </div>
        ) : phase === 'error' ? (
          <div className="mb-6 flex items-center gap-3">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <div>
              <h1 className="text-lg font-semibold">Setup issue</h1>
              <p className="text-sm text-muted-foreground">{errorMessage}</p>
            </div>
          </div>
        ) : (
          <div className="mb-6">
            <h1 className="text-lg font-semibold">Setting up your agent</h1>
            <p className="text-sm text-muted-foreground">
              {phase === 'subscription'
                ? 'Activating your subscription...'
                : 'This usually takes a couple of minutes.'}
            </p>
          </div>
        )}

        {/* Step list */}
        {phase !== 'subscription' && (
          <div className="space-y-3">
            {SETUP_STEPS.map(({ step, label }) => {
              const isCompleted = phase === 'ready' || displayStep > step;
              const isActive =
                phase === 'provisioning' && displayStep === step;

              return (
                <div key={step} className="flex items-center gap-3">
                  {isCompleted ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                  ) : isActive ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                  )}
                  <span
                    className={
                      isCompleted
                        ? 'text-sm text-muted-foreground'
                        : isActive
                          ? 'text-sm text-foreground'
                          : 'text-sm text-muted-foreground/40'
                    }
                  >
                    {label}
                    {isActive && '...'}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Subscription phase spinner */}
        {phase === 'subscription' && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {/* Progress bar */}
        {(phase === 'provisioning' || phase === 'ready') && (
          <div className="mt-6">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{
                  width: `${phase === 'ready' ? 100 : Math.max(5, ((displayStep + 1) / SETUP_STEPS.length) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Error actions */}
        {phase === 'error' && (
          <div className="mt-6 flex gap-3">
            <button
              onClick={handleRetry}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Try again
            </button>
            <button
              onClick={() => router.replace('/chat')}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
            >
              Continue anyway
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
