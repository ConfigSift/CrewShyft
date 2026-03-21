import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const intentId = String(request.nextUrl.searchParams.get('intentId') ?? '').trim();
  if (!intentId) {
    return NextResponse.json({ error: 'intentId is required.' }, { status: 400 });
  }

  const { supabase, response } = createSupabaseRouteClient(request);
  const { data: authData } = await supabase.auth.getUser();
  const authUserId = authData.user?.id;
  if (!authUserId) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Unauthorized.' }, { status: 401 }),
      response,
    );
  }

  const { data: intent } = await supabaseAdmin
    .from('organization_create_intents')
    .select('restaurant_name')
    .eq('id', intentId)
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (!intent) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Intent not found.' }, { status: 404 }),
      response,
    );
  }

  return applySupabaseCookies(
    NextResponse.json({ restaurantName: (intent as { restaurant_name: string }).restaurant_name }),
    response,
  );
}
