import { checkAccess } from '@/lib/auth';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const { user, profile, subscription, isAdmin } = await checkAccess();

  return (
    <SettingsClient
      email={profile?.email ?? user.email ?? ''}
      displayName={profile?.display_name ?? ''}
      plan={subscription?.plan ?? null}
      periodEnd={subscription?.current_period_end ?? null}
      cancelAt={subscription?.cancel_at ?? null}
      isAdmin={isAdmin}
    />
  );
}
