'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2 } from 'lucide-react';

const MAX_POLL_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

export default function CheckoutSuccessPage() {
  const router = useRouter();
  const [status, setStatus] = useState<'polling' | 'success' | 'timeout'>('polling');

  useEffect(() => {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch('/api/stripe/status');
        const { active } = await res.json();

        if (active) {
          setStatus('success');
          setTimeout(() => router.replace('/chat'), 1_000);
          return;
        }
      } catch {
        // Network error — keep polling
      }

      if (Date.now() - start > MAX_POLL_DURATION_MS) {
        setStatus('timeout');
        return;
      }

      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    poll();
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 text-center">
        {status === 'polling' && (
          <>
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <h1 className="text-xl font-semibold">Setting up your account&hellip;</h1>
            <p className="text-sm text-muted-foreground">
              This usually takes just a few seconds.
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <h1 className="text-xl font-semibold">You&apos;re all set!</h1>
            <p className="text-sm text-muted-foreground">Redirecting you now&hellip;</p>
          </>
        )}

        {status === 'timeout' && (
          <>
            <h1 className="text-xl font-semibold">Almost there</h1>
            <p className="text-sm text-muted-foreground max-w-sm">
              Your payment was received but setup is taking longer than expected.
              Please try refreshing in a moment.
            </p>
            <button
              onClick={() => router.replace('/chat')}
              className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Continue to app
            </button>
          </>
        )}
      </div>
    </div>
  );
}
