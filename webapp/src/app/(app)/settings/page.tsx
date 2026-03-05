import { checkAccess } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const { user, profile, subscription, isAdmin } = await checkAccess();

  // Fetch machine status for Agent section
  const serviceClient = createServiceClient();
  const { data: machine } = await serviceClient
    .from('user_machines_safe')
    .select('status, fly_region, preferred_model')
    .eq('user_id', user.id)
    .neq('status', 'destroyed')
    .maybeSingle();

  return (
    <SettingsClient
      email={profile?.email ?? user.email ?? ''}
      displayName={profile?.display_name ?? ''}
      plan={subscription?.plan ?? null}
      periodEnd={subscription?.current_period_end ?? null}
      cancelAt={subscription?.cancel_at ?? null}
      isAdmin={isAdmin}
      machineStatus={machine?.status ?? null}
      machineRegion={machine?.fly_region ?? null}
      machineModel={machine?.preferred_model ?? null}
    />
  );
}
