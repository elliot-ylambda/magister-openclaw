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

/**
 * Check whether the current user has access to the app.
 * Admins always have access; regular users need an active subscription.
 * Redirects to /login if unauthenticated.
 */
export async function checkAccess() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const [{ data: profile }, { data: subscription }] = await Promise.all([
    supabase
      .from('profiles')
      .select('display_name, email, role')
      .eq('id', user.id)
      .single(),
    supabase
      .from('subscriptions')
      .select('plan, status, current_period_start, current_period_end, cancel_at')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle(),
  ]);

  const isAdmin = profile?.role === 'admin';

  return {
    user,
    profile,
    subscription,
    isAdmin,
    hasAccess: isAdmin || !!subscription,
  };
}
