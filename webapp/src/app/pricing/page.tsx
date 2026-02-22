import { createClient } from '@/lib/supabase/server';
import { PricingCards } from '@/components/pricing/pricing-cards';

export default async function PricingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let currentPlan: 'cmo' | 'cmo_plus' | null = null;
  if (user) {
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
