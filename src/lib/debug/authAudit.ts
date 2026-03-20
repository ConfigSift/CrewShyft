import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isDebugAllowed } from '@/lib/debug/isDebugAllowed';

type UserRow = {
  id: string;
  organization_id: string | null;
  real_email: string | null;
  auth_user_id: string | null;
};

function buildDuplicates<T extends { id: string; organization_id: string | null }>(
  rows: T[],
  keyFn: (row: T) => string | null,
) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, count: list.length, rows: list }));
}

export async function handleAuthAudit() {
  if (!isDebugAllowed()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, organization_id, real_email, auth_user_id')
    .limit(10000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as UserRow[];

  const emailDuplicates = buildDuplicates(rows, (row) => {
    if (!row.organization_id || !row.real_email) return null;
    return `${row.organization_id}::${row.real_email.toLowerCase()}`;
  }).map((dup) => {
    const [orgId, email] = dup.key.split('::');
    return {
      organization_id: orgId,
      real_email: email,
      count: dup.count,
      user_ids: dup.rows.map((row) => row.id),
      auth_user_ids: dup.rows
        .map((row) => row.auth_user_id)
        .filter((value): value is string => Boolean(value)),
    };
  });

  const authDuplicates = buildDuplicates(rows, (row) => {
    if (!row.organization_id || !row.auth_user_id) return null;
    return `${row.organization_id}::${row.auth_user_id}`;
  }).map((dup) => {
    const [orgId, authId] = dup.key.split('::');
    return {
      organization_id: orgId,
      auth_user_id: authId,
      count: dup.count,
      user_ids: dup.rows.map((row) => row.id),
      real_emails: dup.rows
        .map((row) => row.real_email)
        .filter((value): value is string => Boolean(value)),
    };
  });

  return NextResponse.json({
    ok: true,
    totals: {
      users: rows.length,
      real_email_duplicates: emailDuplicates.length,
      auth_user_id_duplicates: authDuplicates.length,
    },
    real_email_duplicates: emailDuplicates,
    auth_user_id_duplicates: authDuplicates,
  });
}
