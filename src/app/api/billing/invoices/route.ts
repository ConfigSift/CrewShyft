import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError } from '@/lib/apiResponses';
import { stripe } from '@/lib/stripe/server';
import { getStripeCustomerIdForAuthUser } from '@/lib/billing/customer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export type InvoiceLine = {
  id: string;
  description: string | null;
  amount: number;
  quantity: number | null;
  currency: string;
  period: { start: string; end: string } | null;
};

export type InvoiceSummary = {
  id: string;
  number: string | null;
  status: string | null;
  amount_paid: number;
  amount_due: number;
  currency: string;
  created: string;
  period_start: string | null;
  period_end: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  lines: InvoiceLine[];
};

export async function GET(request: NextRequest) {
  const { supabase, response } = createSupabaseRouteClient(request);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const authUserId = authData.user?.id;
  if (!authUserId) {
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Not signed in. Please sign out/in again.'
        : authError?.message || 'Unauthorized.';
    return applySupabaseCookies(jsonError(message, 401), response);
  }

  const stripeCustomerId = await getStripeCustomerIdForAuthUser(authUserId, supabaseAdmin);
  if (!stripeCustomerId) {
    return applySupabaseCookies(
      NextResponse.json({ invoices: [] }),
      response,
    );
  }

  try {
    const invoiceList = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: 24,
      expand: ['data.lines'],
    });

    const invoices: InvoiceSummary[] = invoiceList.data.map((inv) => ({
      id: inv.id,
      number: inv.number ?? null,
      status: inv.status ?? null,
      amount_paid: inv.amount_paid,
      amount_due: inv.amount_due,
      currency: inv.currency,
      created: new Date(inv.created * 1000).toISOString(),
      period_start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
      period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
      hosted_invoice_url: inv.hosted_invoice_url ?? null,
      invoice_pdf: inv.invoice_pdf ?? null,
      lines: (inv.lines?.data ?? []).map((line) => ({
        id: line.id,
        description: line.description ?? null,
        amount: line.amount,
        quantity: line.quantity ?? null,
        currency: line.currency,
        period:
          line.period
            ? {
                start: new Date(line.period.start * 1000).toISOString(),
                end: new Date(line.period.end * 1000).toISOString(),
              }
            : null,
      })),
    }));

    return applySupabaseCookies(
      NextResponse.json({ invoices }),
      response,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return applySupabaseCookies(
      NextResponse.json({ error: message || 'Unable to load invoices.' }, { status: 500 }),
      response,
    );
  }
}
