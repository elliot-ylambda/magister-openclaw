import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { checkAccess } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { ManageBillingButton } from './manage-billing-button';

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-emerald-500',
  suspended: 'bg-yellow-500',
  provisioning: 'bg-blue-500 animate-pulse',
  suspending: 'bg-yellow-500',
  failed: 'bg-red-500',
  destroying: 'bg-gray-500',
  destroyed: 'bg-gray-500',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  suspended: 'Suspended',
  provisioning: 'Provisioning',
  suspending: 'Suspending',
  failed: 'Failed',
  destroying: 'Shutting down',
  destroyed: 'Destroyed',
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function DashboardPage() {
  const { user, profile, subscription, isAdmin } = await checkAccess();

  const supabase = await createClient();

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [machineRes, usageRes] = await Promise.all([
    supabase
      .from('user_machines_safe')
      .select('status, fly_region, last_activity')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('usage_events')
      .select('cost_cents')
      .eq('user_id', user.id)
      .eq('event_type', 'llm_request')
      .gte('created_at', startOfMonth.toISOString()),
  ]);

  const machine = machineRes.data;
  const usageRows = usageRes.data ?? [];

  const totalCostCents = usageRows.reduce((sum, row) => sum + (row.cost_cents ?? 0), 0);
  const totalCostDollars = (totalCostCents / 100).toFixed(2);
  const budgetDollars = (isAdmin || subscription?.plan === 'cmo_plus') ? 150 : 50;
  const usagePercent = Math.min((totalCostCents / (budgetDollars * 100)) * 100, 100);

  const displayName = profile?.display_name ?? user.user_metadata?.full_name ?? 'there';

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back, {displayName}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Agent Status Card */}
        <div className="rounded-xl border border-border p-6 space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Agent Status</h2>
          {machine ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${STATUS_COLORS[machine.status] ?? 'bg-gray-500'}`} />
                <span className="font-medium">{STATUS_LABELS[machine.status] ?? machine.status}</span>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Region</span>
                  <span className="font-mono">{machine.fly_region}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last active</span>
                  <span>{machine.last_activity ? formatRelativeTime(machine.last_activity) : 'Never'}</span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No agent provisioned</p>
          )}
        </div>

        {/* Usage This Month Card */}
        <div className="rounded-xl border border-border p-6 space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Usage This Month</h2>
          <div className="space-y-3">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-semibold">${totalCostDollars}</span>
              <span className="text-sm text-muted-foreground">/ ${budgetDollars}.00</span>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div
                className="h-2 rounded-full bg-primary transition-all"
                style={{ width: `${usagePercent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {usageRows.length} request{usageRows.length !== 1 ? 's' : ''} this month
            </p>
          </div>
        </div>

        {/* Subscription Card */}
        <div className="rounded-xl border border-border p-6 space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Subscription</h2>
          {subscription ? (
            <div className="space-y-3">
              <div className="font-medium">
                {subscription.plan === 'cmo_plus' ? 'CMO + Specialists' : 'CMO'}
              </div>
              <div className="space-y-1 text-sm">
                {subscription.current_period_start && subscription.current_period_end && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Billing period</span>
                    <span>
                      {formatDate(subscription.current_period_start)} – {formatDate(subscription.current_period_end)}
                    </span>
                  </div>
                )}
                {subscription.cancel_at && (
                  <p className="text-sm text-yellow-500">
                    Cancels on {formatDate(subscription.cancel_at)}
                  </p>
                )}
              </div>
              <ManageBillingButton />
            </div>
          ) : isAdmin ? (
            <div className="font-medium">Admin</div>
          ) : (
            <p className="text-sm text-muted-foreground">No active subscription</p>
          )}
        </div>

        {/* Quick Actions Card */}
        <div className="rounded-xl border border-border p-6 space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Quick Actions</h2>
          <div className="flex flex-col gap-3">
            <Button asChild>
              <Link href="/chat">Start chatting</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/settings">Settings</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
