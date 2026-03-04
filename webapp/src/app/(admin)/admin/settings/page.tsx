import { requireAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { AdminSettings } from '@/components/admin/admin-settings';

export default async function AdminSettingsPage() {
  await requireAdmin();
  const supabase = createServiceClient();

  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'default_model')
    .maybeSingle();

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <AdminSettings defaultModel={data?.value ?? 'anthropic/claude-opus-4-6'} />
    </div>
  );
}
