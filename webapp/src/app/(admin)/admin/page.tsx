import { requireAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default async function AdminOverviewPage() {
  await requireAdmin();
  const supabase = createServiceClient();

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [
    usersRes,
    machinesRes,
    usageRes,
    activeSubsRes,
    recentActivityRes,
  ] = await Promise.all([
    // Total users
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    // All machines for status breakdown
    supabase.from('user_machines_safe').select('status'),
    // Total LLM spend this month
    supabase
      .from('usage_events')
      .select('cost_cents')
      .eq('event_type', 'llm_request')
      .gte('created_at', startOfMonth.toISOString()),
    // Active subscriptions for revenue
    supabase
      .from('subscriptions')
      .select('plan')
      .eq('status', 'active'),
    // Recent activity
    supabase
      .from('usage_events')
      .select('user_id, model, cost_cents, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const totalUsers = usersRes.count ?? 0;
  const machines = machinesRes.data ?? [];
  const usageRows = usageRes.data ?? [];
  const activeSubs = activeSubsRes.data ?? [];
  const recentActivity = recentActivityRes.data ?? [];

  // Machine status breakdown
  const statusCounts: Record<string, number> = {};
  for (const m of machines) {
    statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
  }
  const runningCount = statusCounts['running'] ?? 0;

  // Total LLM spend
  const totalSpendCents = usageRows.reduce((sum, r) => sum + (r.cost_cents ?? 0), 0);
  const totalSpendDollars = (totalSpendCents / 100).toFixed(2);

  // Revenue estimate
  const PLAN_PRICES: Record<string, number> = { cmo: 299, cmo_plus: 999 };
  const estimatedRevenue = activeSubs.reduce(
    (sum, s) => sum + (PLAN_PRICES[s.plan] ?? 0),
    0
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Admin Overview</h1>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="rounded-xl border border-border p-6">
          <p className="text-sm text-muted-foreground">Total Users</p>
          <p className="mt-2 text-3xl font-semibold">{totalUsers}</p>
        </div>
        <div className="rounded-xl border border-border p-6">
          <p className="text-sm text-muted-foreground">Active Agents</p>
          <p className="mt-2 text-3xl font-semibold">{runningCount}</p>
          <p className="text-xs text-muted-foreground mt-1">
            of {machines.length} total
          </p>
        </div>
        <div className="rounded-xl border border-border p-6">
          <p className="text-sm text-muted-foreground">LLM Spend (Month)</p>
          <p className="mt-2 text-3xl font-semibold">${totalSpendDollars}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {usageRows.length} requests
          </p>
        </div>
        <div className="rounded-xl border border-border p-6">
          <p className="text-sm text-muted-foreground">Est. Revenue (MRR)</p>
          <p className="mt-2 text-3xl font-semibold">
            ${estimatedRevenue.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {activeSubs.length} active subscription{activeSubs.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Machine Status Breakdown */}
        <div className="rounded-xl border border-border p-6 space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Machine Status</h2>
          {machines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No machines provisioned</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(statusCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          status === 'running'
                            ? 'bg-emerald-500'
                            : status === 'suspended'
                              ? 'bg-yellow-500'
                              : status === 'failed'
                                ? 'bg-red-500'
                                : status === 'provisioning'
                                  ? 'bg-blue-500'
                                  : 'bg-gray-500'
                        }`}
                      />
                      <span className="capitalize">{status}</span>
                    </div>
                    <span className="font-mono">{count}</span>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="rounded-xl border border-border p-6 space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Recent Activity</h2>
          {recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent activity</p>
          ) : (
            <div className="space-y-2">
              {recentActivity.map((event, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs text-muted-foreground truncate max-w-[120px]">
                      {event.user_id.slice(0, 8)}
                    </span>
                    {event.model && (
                      <span className="text-xs text-muted-foreground">{event.model}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs">
                      ${((event.cost_cents ?? 0) / 100).toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(event.created_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
