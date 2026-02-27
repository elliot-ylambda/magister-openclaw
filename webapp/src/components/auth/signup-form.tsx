'use client';

import { useActionState, useState, useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signup, type SignupState } from '@/app/(auth)/signup/actions';

const initialState: SignupState = {};

export function SignupForm() {
  const [state, formAction, pending] = useActionState(signup, initialState);
  const [shaking, setShaking] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const [pulsing, setPulsing] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    if (state.error) {
      setShakeKey((k) => k + 1);
      setShaking(true);
      setPulseKey((k) => k + 1);
      setPulsing(true);
      const shakeTimer = setTimeout(() => setShaking(false), 500);
      const pulseTimer = setTimeout(() => setPulsing(false), 1200);
      return () => { clearTimeout(shakeTimer); clearTimeout(pulseTimer); };
    }
  }, [state]);

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Create an account</h2>
        <p className="text-sm text-muted-foreground">Enter your email to get started</p>
      </div>

      <motion.div
        key={pulseKey}
        animate={pulsing ? { scale: [1, 1.03, 1, 1.03, 1] } : {}}
        transition={{ duration: 1.2 }}
        className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-4 text-center text-sm text-yellow-500"
      >
        Signups are by invitation only.{' '}
        <Link
          href="/"
          className="underline underline-offset-4 hover:text-yellow-400"
        >
          Join the waitlist
        </Link>{' '}
        to get early access.
      </motion.div>

      <form action={formAction} className="space-y-4">

        {state.error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            {state.error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="you@example.com" required />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" placeholder="••••••••" required minLength={6} />
        </div>

        <motion.div
          key={shakeKey}
          animate={shaking ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : {}}
          transition={{ duration: 0.5 }}
        >
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Creating account...' : 'Create account'}
          </Button>
        </motion.div>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="text-primary underline underline-offset-4 hover:text-primary/80">
          Sign in
        </Link>
      </p>
    </div>
  );
}
