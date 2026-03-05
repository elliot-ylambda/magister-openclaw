import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next') ?? '/chat';

  const supabase = await createClient();

  // PKCE code exchange (used by signUp, signIn with magic link, OAuth)
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
    }

    // Password recovery flow — redirect to reset-password page
    if (type === 'recovery') {
      return NextResponse.redirect(`${origin}/reset-password?mode=update`);
    }

    // Allowlist enforcement for new OAuth signups
    const user = data.session?.user;
    if (user && user.app_metadata?.provider !== 'email') {
      const createdAt = new Date(user.created_at);
      const isNewUser = Date.now() - createdAt.getTime() < 30_000;

      if (isNewUser) {
        const serviceClient = createServiceClient();
        const { data: allowlistEntry } = await serviceClient
          .from('signup_allowlist')
          .select('email')
          .eq('email', user.email!)
          .maybeSingle();

        if (!allowlistEntry) {
          await serviceClient.auth.admin.deleteUser(user.id);
          await supabase.auth.signOut();
          return NextResponse.redirect(`${origin}/signup?error=not_allowlisted`);
        }
      }
    }

    return NextResponse.redirect(`${origin}${next}`);
  }

  // Token hash verification (used by email confirmation in some configurations)
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash, type: type as 'email' | 'recovery' });
    if (error) {
      return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
    }

    if (type === 'recovery') {
      return NextResponse.redirect(`${origin}/reset-password?mode=update`);
    }

    return NextResponse.redirect(`${origin}${next}`);
  }

  // No code or token_hash — something went wrong
  return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
}
