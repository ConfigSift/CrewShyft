import { type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';

export type BillingOverrideType = 'comped' | 'manual_exception';

type OrganizationBillingOverrideRow = {
  id?: string | null;
  name?: string | null;
  restaurant_code?: string | null;
  billing_override_active?: boolean | null;
  billing_override_type?: string | null;
  billing_override_reason?: string | null;
  billing_override_expires_at?: string | null;
  billing_override_set_by?: string | null;
};

export type ActiveBillingOverride = {
  organization_id: string;
  organization_name: string | null;
  restaurant_code: string | null;
  billing_override_type: BillingOverrideType;
  billing_override_reason: string | null;
  billing_override_expires_at: string | null;
  billing_override_set_by: string | null;
};

function isMissingOverrideSchemaError(error: PostgrestError | null | undefined) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    (message.includes('column') && message.includes('billing_override')) ||
    (message.includes('relation') && message.includes('organizations') && message.includes('does not exist'))
  );
}

export function normalizeBillingOverrideType(value: unknown): BillingOverrideType | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'comped') return 'comped';
  if (normalized === 'manual_exception') return 'manual_exception';
  return null;
}

export function isBillingOverrideActive(row: {
  billing_override_active?: boolean | null;
  billing_override_type?: unknown;
  billing_override_expires_at?: string | null;
} | null | undefined, now = new Date()): boolean {
  if (!row?.billing_override_active) return false;
  if (!normalizeBillingOverrideType(row.billing_override_type)) return false;
  const expiresAt = String(row.billing_override_expires_at ?? '').trim();
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs > now.getTime();
}

function toActiveBillingOverride(row: OrganizationBillingOverrideRow): ActiveBillingOverride | null {
  if (!isBillingOverrideActive(row)) return null;

  const type = normalizeBillingOverrideType(row.billing_override_type);
  if (!type) return null;

  const organizationId = String(row.id ?? '').trim();
  if (!organizationId) return null;

  return {
    organization_id: organizationId,
    organization_name: String(row.name ?? '').trim() || null,
    restaurant_code: String(row.restaurant_code ?? '').trim() || null,
    billing_override_type: type,
    billing_override_reason: String(row.billing_override_reason ?? '').trim() || null,
    billing_override_expires_at: String(row.billing_override_expires_at ?? '').trim() || null,
    billing_override_set_by: String(row.billing_override_set_by ?? '').trim() || null,
  };
}

export async function getOrganizationBillingOverride(
  organizationId: string,
  supabaseClient?: SupabaseClient,
): Promise<{ data: ActiveBillingOverride | null; error: PostgrestError | null }> {
  const client = supabaseClient ?? (await import('@/lib/supabase/admin')).supabaseAdmin;
  const { data, error } = await client
    .from('organizations')
    .select(
      'id,name,restaurant_code,billing_override_active,billing_override_type,billing_override_reason,billing_override_expires_at,billing_override_set_by',
    )
    .eq('id', organizationId)
    .maybeSingle();

  if (error && isMissingOverrideSchemaError(error)) {
    return { data: null, error: null };
  }

  if (error) {
    return { data: null, error };
  }

  return {
    data: toActiveBillingOverride((data as OrganizationBillingOverrideRow | null) ?? {}),
    error: null,
  };
}

export async function getOrganizationBillingOverrides(
  organizationIds: string[],
  supabaseClient?: SupabaseClient,
): Promise<{ data: ActiveBillingOverride[]; error: PostgrestError | null }> {
  if (organizationIds.length === 0) {
    return { data: [], error: null };
  }

  const client = supabaseClient ?? (await import('@/lib/supabase/admin')).supabaseAdmin;
  const { data, error } = await client
    .from('organizations')
    .select(
      'id,name,restaurant_code,billing_override_active,billing_override_type,billing_override_reason,billing_override_expires_at,billing_override_set_by',
    )
    .in('id', organizationIds);

  if (error && isMissingOverrideSchemaError(error)) {
    return { data: [], error: null };
  }

  if (error) {
    return { data: [], error };
  }

  return {
    data: ((data as OrganizationBillingOverrideRow[] | null) ?? [])
      .map((row) => toActiveBillingOverride(row))
      .filter((row): row is ActiveBillingOverride => Boolean(row)),
    error: null,
  };
}
