import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  const formMode = mode === 'update' ? 'update' : 'request';

  return <ResetPasswordForm mode={formMode} />;
}
