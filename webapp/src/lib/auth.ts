import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';

/**
 * Verify the current user is an authenticated admin.
 * Uses service client to check role (bypasses RLS for security).
 * Redirects to /login if unauthenticated, /chat if not admin.
 */
export async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const serviceClient = createServiceClient();
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('display_name, email, role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    redirect('/chat');
  }

  return { user, profile };
}
