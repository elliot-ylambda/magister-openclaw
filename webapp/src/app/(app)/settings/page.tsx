import { createClient } from '@/lib/supabase/server';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const [profileRes, subscriptionRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('display_name, email')
      .eq('id', user.id)
      .single(),
    supabase
      .from('subscriptions')
      .select('plan, current_period_end, cancel_at')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single(),
  ]);

  return (
    <SettingsClient
      email={profileRes.data?.email ?? user.email ?? ''}
      displayName={profileRes.data?.display_name ?? ''}
      plan={subscriptionRes.data?.plan ?? null}
      periodEnd={subscriptionRes.data?.current_period_end ?? null}
      cancelAt={subscriptionRes.data?.cancel_at ?? null}
    />
  );
}
