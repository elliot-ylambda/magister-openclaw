'use server';

import { createClient } from '@/lib/supabase/server';

export type SignupState = {
  error?: string;
  success?: boolean;
};

export async function signup(_prevState: SignupState, formData: FormData): Promise<SignupState> {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  if (!email || !password) {
    return { error: 'Email and password are required.' };
  }

  if (password.length < 6) {
    return { error: 'Password must be at least 6 characters.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });

  if (error) {
    if (error.message.includes('already registered')) {
      return { error: 'An account with this email already exists.' };
    }
    return { error: error.message };
  }

  return { success: true };
}
