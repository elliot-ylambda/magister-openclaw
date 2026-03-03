import { requireAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { SecretsManager, type GlobalSecret, type SecretOverride, type UserProfile } from '@/components/admin/secrets-manager';

export default async function AdminSecretsPage() {
  await requireAdmin();
  const supabase = createServiceClient();

  const [secretsRes, overridesRes, profilesRes] = await Promise.all([
    supabase.from('global_secrets').select('*').order('key'),
    supabase.from('user_secret_overrides').select('*'),
    supabase.from('profiles').select('id, email'),
  ]);

  const secrets: GlobalSecret[] = (secretsRes.data ?? []).map((s) => ({
    id: s.id,
    key: s.key,
    value: s.value,
    description: s.description,
    category: s.category,
    is_sensitive: s.is_sensitive,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  const overrides: SecretOverride[] = (overridesRes.data ?? []).map((o) => ({
    id: o.id,
    user_id: o.user_id,
    secret_key: o.secret_key,
    value: o.value,
    created_at: o.created_at,
    updated_at: o.updated_at,
  }));

  const profiles: UserProfile[] = (profilesRes.data ?? []).map((p) => ({
    id: p.id,
    email: p.email,
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
      <SecretsManager secrets={secrets} overrides={overrides} profiles={profiles} />
    </div>
  );
}
