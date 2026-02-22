import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <Link href="/" className="inline-block">
            <h1
              className="text-3xl tracking-tight"
              style={{ fontFamily: 'var(--font-instrument-serif)' }}
            >
              Magister
            </h1>
          </Link>
        </div>
        {children}
      </div>
    </div>
  );
}
