import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuthApi } from '@/lib/supabase/adminAuth';
import { isDebugAllowed } from '@/lib/debug/isDebugAllowed';

export async function handleAuthByEmail(req: NextRequest) {
  if (!isDebugAllowed()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const email = req.nextUrl.searchParams.get('email')?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }

  const adminAuth = getAdminAuthApi();
  if (typeof adminAuth.getUserByEmail === 'function') {
    const { data, error } = await adminAuth.getUserByEmail(email);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ exists: Boolean(data?.user?.id), auth_user_id: data?.user?.id ?? null });
  }

  if (typeof adminAuth.listUsers !== 'function') {
    return NextResponse.json({ exists: false, auth_user_id: null });
  }

  const perPage = 200;
  let page = 1;
  while (true) {
    const { data: listData, error: listErr } = await adminAuth.listUsers({ page, perPage });
    if (listErr) {
      return NextResponse.json({ error: listErr.message }, { status: 500 });
    }
    const users = listData?.users ?? [];
    const match = users.find((user) => String(user.email ?? '').toLowerCase() === email);
    if (match?.id) {
      return NextResponse.json({ exists: true, auth_user_id: match.id });
    }
    if (users.length < perPage) break;
    page += 1;
  }

  return NextResponse.json({ exists: false, auth_user_id: null });
}
