import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const service = createServiceClient();
  const { data: machine } = await service
    .from('user_machines_safe')
    .select('browser_enabled, browser_allowed_urls, browser_read_only')
    .eq('user_id', user.id)
    .neq('status', 'destroyed')
    .maybeSingle();

  if (!machine) {
    return NextResponse.json({
      enabled: false,
      readOnly: false,
      allowedUrls: [],
    });
  }

  return NextResponse.json({
    enabled: machine.browser_enabled,
    readOnly: machine.browser_read_only,
    allowedUrls: machine.browser_allowed_urls ?? [],
  });
}

export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (typeof body.enabled === 'boolean') updates.browser_enabled = body.enabled;
  if (typeof body.readOnly === 'boolean') updates.browser_read_only = body.readOnly;
  if (Array.isArray(body.allowedUrls)) updates.browser_allowed_urls = body.allowedUrls;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const service = createServiceClient();
  const { error } = await service
    .from('user_machines')
    .update(updates)
    .eq('user_id', user.id)
    .neq('status', 'destroyed');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: 'updated' });
}
