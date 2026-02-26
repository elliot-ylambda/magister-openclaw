import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: connection } = await supabase
    .from('slack_connections')
    .select('team_name, status, created_at')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  return NextResponse.json({
    connected: !!connection,
    teamName: connection?.team_name ?? null,
    connectedAt: connection?.created_at ?? null,
  });
}
