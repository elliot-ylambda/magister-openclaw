'use server';

export type SignupState = {
  error?: string;
  success?: boolean;
};

export async function signup(_prevState: SignupState, _formData: FormData): Promise<SignupState> {
  return { error: 'Signups are not available yet. Join our waitlist instead.' };
}
