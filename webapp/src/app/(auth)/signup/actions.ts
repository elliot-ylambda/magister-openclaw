'use server';

import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export type SignupState = {
  error?: string;
  success?: boolean;
};

export async function signup(_prevState: SignupState, formData: FormData): Promise<SignupState> {
  const email = (formData.get('email') as string)?.trim().toLowerCase();
  const password = formData.get('password') as string;

  if (!email || !password) {
    return { error: 'Email and password are required.' };
  }

  // Check allowlist using service client (bypasses RLS)
  const serviceClient = createServiceClient();
  const { data: allowed } = await serviceClient
    .from('signup_allowlist')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (!allowed) {
    return { error: 'Signups are not available yet. Join our waitlist instead.' };
  }

  // Create the account using the cookie-based client
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({ email, password });

  if (error) {
    if (error.message.includes('User already registered')) {
      return { error: 'An account with this email already exists. Try signing in instead.' };
    }
    return { error: error.message };
  }

  redirect('/chat');
}
