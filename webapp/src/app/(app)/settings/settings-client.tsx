'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createClient } from '@/lib/supabase/client';
import { restartAgent, getAvailableModels, setModel, type ModelInfo } from '@/lib/gateway';
import { ManageBillingButton } from '../dashboard/manage-billing-button';
import { ByokKeys } from '@/components/settings/byok-keys';
import { SlackConnection } from '@/components/settings/slack-connection';
import { updateProfile, type ProfileUpdateState } from './actions';

type SettingsClientProps = {
  email: string;
  displayName: string;
  plan: string | null;
  periodEnd: string | null;
  cancelAt: string | null;
  isAdmin?: boolean;
  machineStatus: string | null;
  machineRegion: string | null;
  machineModel: string | null;
};

const MODEL_OUTPUT_PRICES: Record<string, string> = {
  "anthropic/claude-sonnet-4-6": "$15/M",
  "anthropic/claude-opus-4-6": "$25/M",
  "google/gemini-3.1-pro-preview": "$12/M",
  "openai/gpt-5.2": "$14/M",
  "minimax/minimax-m2.5": "$1.20/M",
  "moonshotai/kimi-k2.5": "$2.20/M",
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  running: { label: 'Agent ready', color: 'bg-emerald-500' },
  suspended: { label: 'Agent sleeping', color: 'bg-yellow-500' },
  stopped: { label: 'Agent stopped', color: 'bg-red-500' },
  provisioning: { label: 'Setting up...', color: 'bg-blue-500' },
  failed: { label: 'Agent offline', color: 'bg-red-500' },
  destroying: { label: 'Shutting down...', color: 'bg-gray-500' },
  destroyed: { label: 'Agent unavailable', color: 'bg-gray-500' },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const profileInitialState: ProfileUpdateState = {};

export function SettingsClient({
  email,
  displayName,
  plan,
  periodEnd,
  cancelAt,
  isAdmin,
  machineStatus,
  machineRegion,
  machineModel,
}: SettingsClientProps) {
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

  // Agent controls
  const [agentLoading, setAgentLoading] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetOpen, setResetOpen] = useState(false);

  // Model selection
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState(machineModel ?? '');
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [modelConfirmOpen, setModelConfirmOpen] = useState(false);

  useEffect(() => {
    if (!machineStatus) return;
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
      if (!gatewayUrl) return;
      const result = await getAvailableModels(gatewayUrl, session.access_token);
      if (result) {
        setModels(result.models);
        setCurrentModel(result.current);
      }
    })();
  }, [machineStatus]);

  async function handleModelChange(newModel: string) {
    if (newModel === currentModel) return;
    setPendingModel(newModel);
    setModelConfirmOpen(true);
  }

  async function confirmModelChange() {
    if (!pendingModel) return;
    setModelConfirmOpen(false);
    setAgentLoading('model');
    setAgentError(null);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
      if (!gatewayUrl) return;
      await setModel(gatewayUrl, session.access_token, pendingModel);
      setCurrentModel(pendingModel);
      router.refresh();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Failed to switch model');
    } finally {
      setAgentLoading(null);
      setPendingModel(null);
    }
  }

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

  async function handleRestart() {
    setAgentLoading('restart');
    setAgentError(null);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
      if (!gatewayUrl) return;
      await restartAgent(gatewayUrl, session.access_token);
      router.refresh();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Failed to restart agent');
    } finally {
      setAgentLoading(null);
    }
  }

  async function handleReset() {
    setAgentLoading('reset');
    setAgentError(null);
    try {
      const res = await fetch('/api/machine/reset', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to reset agent');
      }
      setResetOpen(false);
      setResetConfirm('');
      router.refresh();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Failed to reset agent');
    } finally {
      setAgentLoading(null);
    }
  }

  const statusInfo = machineStatus ? STATUS_LABELS[machineStatus] : null;

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
        ) : isAdmin ? (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Current plan</span>
            <span className="font-medium">Admin</span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No active subscription</p>
        )}
      </section>

      {/* BYOK API Keys */}
      <ByokKeys />

      {/* Slack Integration */}
      <SlackConnection />

      {/* Agent Section */}
      {machineStatus && (
        <section className="rounded-xl border border-border p-6 space-y-4">
          <h2 className="text-lg font-medium">Agent</h2>

          {agentError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {agentError}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Status</span>
              <span className="flex items-center gap-2">
                {statusInfo && (
                  <span className={`h-2 w-2 rounded-full ${statusInfo.color}`} />
                )}
                <span>{statusInfo?.label ?? machineStatus}</span>
              </span>
            </div>
            {machineRegion && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Region</span>
                <span className="font-mono">{machineRegion}</span>
              </div>
            )}
          </div>

          {models.length > 0 && (
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground">Model</span>
              <Select
                value={currentModel}
                onValueChange={handleModelChange}
                disabled={agentLoading !== null || machineStatus === 'provisioning' || machineStatus === 'destroying'}
              >
                <SelectTrigger className="w-48 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id} disabled={!m.allowed}>
                      <span className="flex items-center justify-between w-full gap-2">
                        <span>{m.name}{!m.allowed ? ' (CMO+ only)' : ''}</span>
                        {MODEL_OUTPUT_PRICES[m.id] && (
                          <span className="text-[10px] text-muted-foreground">{MODEL_OUTPUT_PRICES[m.id]}</span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Model change confirmation */}
          <Dialog open={modelConfirmOpen} onOpenChange={setModelConfirmOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change Model</DialogTitle>
                <DialogDescription>
                  Changing your model will restart your agent. Any in-progress work will be interrupted. Continue?
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={confirmModelChange}>
                  Confirm
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Button
            size="sm"
            disabled={agentLoading !== null}
            onClick={handleRestart}
          >
            {agentLoading === 'restart' ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="mr-2 h-3.5 w-3.5" />
            )}
            Restart Agent
          </Button>

        </section>
      )}

      {/* Danger Zone */}
      <Separator />
      <section className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 space-y-4">
        <h2 className="text-lg font-medium text-red-500">Danger Zone</h2>

        {/* Reset Agent */}
        {machineStatus && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Reset Agent</p>
            <p className="text-xs text-muted-foreground">
              This will delete all agent data and start fresh. Chat history is preserved.
            </p>
            <Dialog open={resetOpen} onOpenChange={(open) => { setResetOpen(open); if (!open) setResetConfirm(''); }}>
              <DialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={agentLoading !== null}>
                  Reset Agent
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Complete Reset</DialogTitle>
                  <DialogDescription>
                    This will permanently delete your agent and all its data, then create a fresh one.
                    Your chat history will be preserved, but all agent memory and files will be lost.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="resetConfirm">
                    Type <span className="font-mono font-bold">RESET</span> to confirm
                  </Label>
                  <Input
                    id="resetConfirm"
                    value={resetConfirm}
                    onChange={(e) => setResetConfirm(e.target.value)}
                    placeholder="RESET"
                  />
                </div>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    disabled={resetConfirm !== 'RESET' || agentLoading === 'reset'}
                    onClick={handleReset}
                  >
                    {agentLoading === 'reset' ? 'Resetting...' : 'Confirm Reset'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}

        {machineStatus && <Separator className="border-red-500/20" />}

        {/* Delete Account */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Delete Account</p>
          <p className="text-xs text-muted-foreground">
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
        </div>
      </section>
    </div>
  );
}
