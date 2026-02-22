'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';
import { ManageBillingButton } from '../dashboard/manage-billing-button';
import { updateProfile, type ProfileUpdateState } from './actions';

type SettingsClientProps = {
  email: string;
  displayName: string;
  plan: string | null;
  periodEnd: string | null;
  cancelAt: string | null;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const profileInitialState: ProfileUpdateState = {};

export function SettingsClient({ email, displayName, plan, periodEnd, cancelAt }: SettingsClientProps) {
  const router = useRouter();

  // Profile form
  const [profileState, profileAction, profilePending] = useActionState(
    async (prev: ProfileUpdateState, formData: FormData) => {
      const result = await updateProfile(prev, formData);
      if (result.success) router.refresh();
      return result;
    },
    profileInitialState
  );

  // Password form
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  async function handlePasswordSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    const form = new FormData(e.currentTarget);
    const password = form.get('password') as string;
    const confirmPassword = form.get('confirmPassword') as string;

    if (!password || !confirmPassword) {
      setPasswordError('Both fields are required.');
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters.');
      return;
    }

    setPasswordLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setPasswordLoading(false);

    if (error) {
      setPasswordError(error.message);
      return;
    }

    setPasswordSuccess(true);
    (e.target as HTMLFormElement).reset();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account settings</p>
      </div>

      {/* Profile Section */}
      <section className="rounded-xl border border-border p-6 space-y-4">
        <h2 className="text-lg font-medium">Profile</h2>
        <form action={profileAction} className="space-y-4">
          {profileState.error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {profileState.error}
            </div>
          )}
          {profileState.success && (
            <div className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-500" role="status">
              Profile updated successfully.
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="displayName">Display name</Label>
            <Input
              id="displayName"
              name="displayName"
              defaultValue={displayName}
              placeholder="Your name"
              required
              maxLength={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={email} disabled />
            <p className="text-xs text-muted-foreground">
              Contact support to change your email address.
            </p>
          </div>

          <Button type="submit" size="sm" disabled={profilePending}>
            {profilePending ? 'Saving...' : 'Save'}
          </Button>
        </form>
      </section>

      {/* Password Section */}
      <section className="rounded-xl border border-border p-6 space-y-4">
        <h2 className="text-lg font-medium">Password</h2>
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          {passwordError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {passwordError}
            </div>
          )}
          {passwordSuccess && (
            <div className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-500" role="status">
              Password updated successfully.
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>

          <Button type="submit" size="sm" disabled={passwordLoading}>
            {passwordLoading ? 'Updating...' : 'Update password'}
          </Button>
        </form>
      </section>

      {/* Billing Section */}
      <section className="rounded-xl border border-border p-6 space-y-4">
        <h2 className="text-lg font-medium">Billing</h2>
        {plan ? (
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Current plan</span>
              <span className="font-medium">
                {plan === 'cmo_plus' ? 'CMO + Specialists' : 'CMO'}
              </span>
            </div>
            {periodEnd && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Renews on</span>
                <span>{formatDate(periodEnd)}</span>
              </div>
            )}
            {cancelAt && (
              <p className="text-sm text-yellow-500">
                Cancels on {formatDate(cancelAt)}
              </p>
            )}
            <ManageBillingButton returnUrl="/settings" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No active subscription</p>
        )}
      </section>

      {/* Danger Zone */}
      <Separator />
      <section className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 space-y-4">
        <h2 className="text-lg font-medium text-red-500">Danger Zone</h2>
        <p className="text-sm text-muted-foreground">
          Once you delete your account, there is no going back. This action cannot be undone.
        </p>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" size="sm">
              Delete account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete account</DialogTitle>
              <DialogDescription>
                To delete your account and all associated data, please email{' '}
                <a
                  href="mailto:support@magistermarketing.com"
                  className="text-primary underline underline-offset-4"
                >
                  support@magistermarketing.com
                </a>{' '}
                from your registered email address. We&apos;ll process your request within 48 hours.
              </DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </section>
    </div>
  );
}
