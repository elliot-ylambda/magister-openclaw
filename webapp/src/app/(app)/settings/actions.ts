'use server';

import { createClient } from '@/lib/supabase/server';

export type ProfileUpdateState = {
  error?: string;
  success?: boolean;
};

export async function updateProfile(
  _prevState: ProfileUpdateState,
  formData: FormData
): Promise<ProfileUpdateState> {
  const displayName = formData.get('displayName') as string;

  if (!displayName || displayName.trim().length === 0) {
    return { error: 'Display name is required.' };
  }

  if (displayName.length > 100) {
    return { error: 'Display name must be 100 characters or fewer.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'Not authenticated.' };
  }

  const { error } = await supabase
    .from('profiles')
    .update({ display_name: displayName.trim() })
    .eq('id', user.id);

  if (error) {
    return { error: error.message };
  }

  return { success: true };
}
