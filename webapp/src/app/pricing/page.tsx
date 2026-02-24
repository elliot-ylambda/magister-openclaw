import Image from 'next/image';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { PricingCards } from '@/components/pricing/pricing-cards';
import { signOut } from './actions';

export default async function PricingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let currentPlan: 'cmo' | 'cmo_plus' | null = null;
  if (user) {
    // Check if admin — admins bypass pricing
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role === 'admin') {
      redirect('/chat');
    }

    const { data } = await supabase
      .from('subscriptions')
      .select('plan')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing'])
      .limit(1)
      .maybeSingle();
    currentPlan = data?.plan ?? null;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-20">
      {user && (
        <nav className="fixed top-0 left-0 right-0 z-50 h-[72px] flex items-center border-b border-border/40">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 md:px-10">
            <a href="/" className="flex items-center gap-2.5">
              <Image src="/magister-logo-white.svg" alt="Magister" width={28} height={30} />
              <span
                className="text-[15px] font-medium text-white tracking-[0.12em] uppercase"
                style={{ fontFamily: 'var(--font-dm-sans)' }}
              >
                Magister
              </span>
            </a>
            <form action={signOut}>
              <button
                type="submit"
                className="text-[13px] font-medium transition-colors duration-300 text-muted-foreground hover:text-white"
                style={{ fontFamily: 'var(--font-dm-sans)' }}
              >
                Sign out
              </button>
            </form>
          </div>
        </nav>
      )}
      <h1
        className="text-4xl font-semibold tracking-tight text-center mb-4"
        style={{ fontFamily: 'var(--font-instrument-serif)' }}
      >
        Choose your plan
      </h1>
      <p className="text-muted-foreground text-center mb-12 max-w-lg">
        Deploy an autonomous marketing agent that works in your tools.
      </p>
      <PricingCards
        isAuthenticated={!!user}
        currentPlan={currentPlan}
      />
    </div>
  );
}
