import { requireAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { UsersTable, type AdminUser } from '@/components/admin/users-table';

export default async function AdminUsersPage() {
  await requireAdmin();
  const supabase = createServiceClient();

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [profilesRes, subscriptionsRes, machinesRes, usageRes] = await Promise.all([
    supabase.from('profiles').select('id, email'),
    supabase.from('subscriptions').select('user_id, plan, status').eq('status', 'active'),
    supabase
      .from('user_machines_safe')
      .select('user_id, status, fly_region, last_activity')
      .not('status', 'in', '("destroyed")'),
    supabase
      .from('usage_events')
      .select('user_id, cost_cents')
      .eq('event_type', 'llm_request')
      .gte('created_at', startOfMonth.toISOString()),
  ]);

  const profiles = profilesRes.data ?? [];
  const subscriptions = subscriptionsRes.data ?? [];
  const machines = machinesRes.data ?? [];
  const usageRows = usageRes.data ?? [];

  // Index by user_id for fast lookups
  const subsByUser = new Map(subscriptions.map((s) => [s.user_id, s]));
  const machinesByUser = new Map(machines.map((m) => [m.user_id, m]));

  // Aggregate spend per user
  const spendByUser = new Map<string, number>();
  for (const row of usageRows) {
    spendByUser.set(row.user_id, (spendByUser.get(row.user_id) ?? 0) + (row.cost_cents ?? 0));
  }

  const PLAN_BUDGETS: Record<string, number> = { cmo: 50, cmo_plus: 150 };

  const users: AdminUser[] = profiles.map((p) => {
    const sub = subsByUser.get(p.id);
    const machine = machinesByUser.get(p.id);
    const plan = sub?.plan ?? null;

    return {
      id: p.id,
      email: p.email,
      plan,
      subStatus: sub?.status ?? null,
      machineStatus: machine?.status ?? null,
      flyRegion: machine?.fly_region ?? null,
      llmSpendCents: spendByUser.get(p.id) ?? 0,
      budgetDollars: plan ? (PLAN_BUDGETS[plan] ?? 50) : 0,
      lastActivity: machine?.last_activity ?? null,
    };
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      <UsersTable users={users} />
    </div>
  );
}
