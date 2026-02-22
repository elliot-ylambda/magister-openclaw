import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { UserNav } from '@/components/shared/user-nav';
import { Separator } from '@/components/ui/separator';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireAdmin();

  const displayName = profile?.display_name ?? (user.user_metadata?.full_name as string) ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-4 border-b px-6">
        <Link href="/admin" className="text-sm font-semibold">
          Admin
        </Link>
        <Separator orientation="vertical" className="h-4" />
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/admin"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Overview
          </Link>
          <Link
            href="/admin/users"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Users
          </Link>
        </nav>
        <div className="flex-1" />
        <Link
          href="/chat"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to app
        </Link>
        <UserNav email={user.email ?? null} displayName={displayName} />
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
