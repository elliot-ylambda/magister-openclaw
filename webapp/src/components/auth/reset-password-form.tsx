'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  requestPasswordReset,
  updatePassword,
  type ResetRequestState,
  type ResetUpdateState,
} from '@/app/(auth)/reset-password/actions';

const requestInitial: ResetRequestState = {};
const updateInitial: ResetUpdateState = {};

export function ResetPasswordForm({ mode }: { mode: 'request' | 'update' }) {
  if (mode === 'update') {
    return <UpdatePasswordForm />;
  }
  return <RequestResetForm />;
}

function RequestResetForm() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, requestInitial);

  if (state.success) {
    return (
      <div className="space-y-4 text-center">
        <h2 className="text-xl font-semibold">Check your email</h2>
        <p className="text-muted-foreground">
          We sent you a password reset link. Click it to set a new password.
        </p>
        <Link href="/login" className="text-sm text-primary underline underline-offset-4 hover:text-primary/80">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Reset your password</h2>
        <p className="text-sm text-muted-foreground">Enter your email to receive a reset link</p>
      </div>

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

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Sending...' : 'Send reset link'}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="text-primary underline underline-offset-4 hover:text-primary/80">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

function UpdatePasswordForm() {
  const [state, formAction, pending] = useActionState(updatePassword, updateInitial);

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Set new password</h2>
        <p className="text-sm text-muted-foreground">Enter your new password below</p>
      </div>

      <form action={formAction} className="space-y-4">
        {state.error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            {state.error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input id="password" name="password" type="password" placeholder="••••••••" required minLength={6} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirm password</Label>
          <Input id="confirmPassword" name="confirmPassword" type="password" placeholder="••••••••" required minLength={6} />
        </div>

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Updating...' : 'Update password'}
        </Button>
      </form>
    </div>
  );
}
