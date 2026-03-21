import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { stripe } from '@/lib/stripe/server';
import { STRIPE_WEBHOOK_SECRET } from '@/lib/stripe/config';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { generateRestaurantCode } from '@/utils/restaurantCode';
import {
  isMissingTableError,
  resolveAuthUserIdFromStripeCustomer,
  upsertBillingAccountFromSubscription,
} from '@/lib/billing/customer';
import {
  beginBillingWebhookEvent,
  markBillingWebhookEventCompleted,
  markBillingWebhookEventFailed,
} from '@/lib/billing/webhookEvents';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getSupabaseAdminClient(): typeof supabaseAdmin {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!supabaseUrl) {
    throw new Error('Missing SUPABASE_URL.');
  }
  if (!serviceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY.');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }) as typeof supabaseAdmin;
}

function toIsoFromUnixTimestamp(unixSeconds: number | null | undefined) {
  if (typeof unixSeconds !== 'number') return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function getSubscriptionId(value: string | Stripe.Subscription | null) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function getSubscriptionCustomerId(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id;

  if (!customerId) {
    throw new Error(`Missing customer on subscription ${subscription.id}`);
  }

  return customerId;
}

async function resolveAuthUserIdForSubscription(
  supabaseAdminClient: typeof supabaseAdmin,
  subscription: Stripe.Subscription,
) {
  const metadataAuthUserId = String(subscription.metadata?.auth_user_id ?? '').trim();
  if (metadataAuthUserId) {
    return metadataAuthUserId;
  }

  const stripeCustomerId = getSubscriptionCustomerId(subscription);
  const mappedAuthUserId = await resolveAuthUserIdFromStripeCustomer(
    stripeCustomerId,
    supabaseAdminClient,
  );
  if (mappedAuthUserId) {
    return mappedAuthUserId;
  }

  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (!('deleted' in customer) || !customer.deleted) {
      const customerAuthUserId = String(customer.metadata?.auth_user_id ?? '').trim();
      if (customerAuthUserId) {
        await supabaseAdminClient
          .from('stripe_customers')
          .upsert(
            {
              auth_user_id: customerAuthUserId,
              stripe_customer_id: stripeCustomerId,
            },
            { onConflict: 'auth_user_id' },
          );
        return customerAuthUserId;
      }
    }
  } catch {
    // ignore customer lookup failures in webhook path
  }

  return null;
}

async function upsertBillingAccountRow(
  supabaseAdminClient: typeof supabaseAdmin,
  subscription: Stripe.Subscription,
  sourceEvent: string,
  eventId: string,
) {
  const authUserId = await resolveAuthUserIdForSubscription(supabaseAdminClient, subscription);
  if (!authUserId) {
    console.warn('[billing:webhook] missing auth_user_id for billing account upsert', {
      eventId,
      eventType: sourceEvent,
      sourceEvent,
      subscriptionId: subscription.id,
      customer: subscription.customer,
    });
    return;
  }

  const { error } = await upsertBillingAccountFromSubscription(
    authUserId,
    subscription,
    supabaseAdminClient,
  );
  if (error) {
    const missingBillingAccountsTable =
      String(error.code ?? '').toUpperCase() === 'PGRST205' ||
      String(error.message ?? '').toLowerCase().includes('could not find the table');
    if (missingBillingAccountsTable) {
      console.warn('[billing:webhook] billing_accounts table missing, skipping customer upsert', {
        eventId,
        eventType: sourceEvent,
        sourceEvent,
        authUserId,
        subscriptionId: subscription.id,
      });
      return;
    }

    console.error('[billing:webhook] billing_accounts upsert failed', {
      eventId,
      eventType: sourceEvent,
      sourceEvent,
      authUserId,
      subscriptionId: subscription.id,
      error: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw error;
  }
}

async function upsertMirroredSubscriptionState(
  supabaseAdminClient: typeof supabaseAdmin,
  subscription: Stripe.Subscription,
  organizationId: string,
  sourceEvent: string,
  eventId: string,
) {
  // Per-org subscriptions skip billing_accounts writes to avoid overwriting
  // an existing bundled subscription row for other orgs.
  const billingMode = String(subscription.metadata?.billing_mode ?? '').trim();
  const isPerOrg = billingMode === 'per_org';

  if (!isPerOrg) {
    // Legacy bundled subscriptions: write to both tables for backward compatibility.
    await upsertBillingAccountRow(supabaseAdminClient, subscription, sourceEvent, eventId);
  } else {
    console.log('[billing:webhook] skipping billing_accounts write for per_org subscription', {
      eventId,
      sourceEvent,
      subscriptionId: subscription.id,
      organizationId,
    });
  }

  return upsertSubscriptionRow(
    supabaseAdminClient,
    subscription,
    organizationId,
    sourceEvent,
    eventId,
  );
}

async function updateMirroredSubscriptionStatus(
  supabaseAdminClient: typeof supabaseAdmin,
  subscriptionId: string,
  sourceEvent: string,
  eventId: string,
  updates: {
    status: string;
    cancel_at_period_end?: boolean;
  },
) {
  const payload = {
    ...updates,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdminClient
    .from('subscriptions')
    .update(payload)
    .eq('stripe_subscription_id', subscriptionId);

  if (error) {
    console.error('[billing:webhook] mirrored subscriptions update failed', {
      eventId,
      eventType: sourceEvent,
      subscriptionId,
      supabaseError: {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      },
    });
    throw error;
  }

  const { error: billingAccountError } = await supabaseAdminClient
    .from('billing_accounts')
    .update(payload)
    .eq('stripe_subscription_id', subscriptionId);

  if (billingAccountError) {
    if (isMissingTableError(billingAccountError)) {
      console.warn(
        '[billing:webhook] billing_accounts table missing during mirrored status update',
        {
          eventId,
          eventType: sourceEvent,
          subscriptionId,
        },
      );
      return;
    }

    console.error('[billing:webhook] mirrored billing_accounts update failed', {
      eventId,
      eventType: sourceEvent,
      subscriptionId,
      supabaseError: {
        message: billingAccountError.message,
        details: billingAccountError.details,
        hint: billingAccountError.hint,
        code: billingAccountError.code,
      },
    });
    throw billingAccountError;
  }
}

async function upsertSubscriptionRow(
  supabaseAdminClient: typeof supabaseAdmin,
  subscription: Stripe.Subscription,
  organizationId: string,
  sourceEvent: string,
  eventId: string,
) {
  const customerId = getSubscriptionCustomerId(subscription);
  const priceId = subscription.items.data[0]?.price?.id ?? '';
  const quantity = subscription.items.data[0]?.quantity ?? 1;
  const currentPeriodStart = toIsoFromUnixTimestamp(subscription.current_period_start);
  const currentPeriodEnd = toIsoFromUnixTimestamp(subscription.current_period_end);

  // Resolve owner and billing mode from subscription metadata
  const ownerAuthUserId = await resolveAuthUserIdForSubscription(supabaseAdminClient, subscription);
  const billingMode = String(subscription.metadata?.billing_mode ?? '').trim() || 'legacy';

  const upsertPayload = {
    organization_id: organizationId,
    status: subscription.status,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    current_period_end: currentPeriodEnd,
    updated_at: new Date().toISOString(),
    stripe_price_id: priceId,
    quantity,
    current_period_start: currentPeriodStart,
    cancel_at_period_end: subscription.cancel_at_period_end,
    owner_auth_user_id: ownerAuthUserId,
    billing_mode: billingMode === 'per_org' ? 'per_org' : 'legacy',
  };

  console.log('[billing:webhook] upserting subscription row', {
    eventId,
    eventType: sourceEvent,
    sourceEvent,
    organizationId,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: customerId,
    status: subscription.status,
    currentPeriodEnd,
    quantity,
    priceId,
  });

  const { error } = await supabaseAdminClient
    .from('subscriptions')
    .upsert(upsertPayload, { onConflict: 'organization_id' });

  if (error) {
    const isMissingOrgFk =
      error.code === '23503' &&
      String(error.message ?? '').toLowerCase().includes('foreign key');
    const isMissingOrgMessage =
      String(error.message ?? '').toLowerCase().includes('organization') &&
      String(error.message ?? '').toLowerCase().includes('not present');

    if (isMissingOrgFk || isMissingOrgMessage) {
      console.warn('[billing:webhook] ignoring subscription upsert for deleted organization', {
        eventId,
        eventType: sourceEvent,
        sourceEvent,
        organizationId,
        stripeSubscriptionId: subscription.id,
        supabaseError: {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        },
      });
      return { ignoredMissingOrganization: true };
    }

    console.error('[billing:webhook] subscriptions upsert failed', {
      eventId,
      eventType: sourceEvent,
      sourceEvent,
      organizationId,
      stripeSubscriptionId: subscription.id,
      supabaseError: {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      },
    });
    throw error;
  }

  return { ignoredMissingOrganization: false };
}

/**
 * Stripe webhook handler.
 * Uses request.text() for raw body access (required for signature verification).
 */
export async function handleStripeWebhook(request: NextRequest) {
  console.log('[billing:webhook] env presence', {
    STRIPE_SECRET_KEY: Boolean(process.env.STRIPE_SECRET_KEY),
    STRIPE_WEBHOOK_SECRET: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    SUPABASE_SERVICE_ROLE: Boolean(process.env.SUPABASE_SERVICE_ROLE),
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  });

  if (!STRIPE_WEBHOOK_SECRET) {
    console.error('[billing:webhook] STRIPE_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 500 });
  }

  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    console.error('[billing:webhook] Missing stripe-signature header');
    return NextResponse.json({ error: 'Missing signature.' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[billing:webhook] Signature verification failed:', message);
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
  }

  console.log('[billing:webhook] received event', {
    eventId: event.id,
    eventType: event.type,
  });

  let supabaseAdminClient: typeof supabaseAdmin | null = null;
  try {
    supabaseAdminClient = getSupabaseAdminClient();
    const beginResult = await beginBillingWebhookEvent(supabaseAdminClient, event);
    if (beginResult.kind === 'duplicate') {
      console.log('[billing:webhook] duplicate event acknowledged without reprocessing', {
        eventId: event.id,
        eventType: event.type,
        status: beginResult.status,
      });
      return NextResponse.json({ received: true, duplicate: true });
    }
    if (beginResult.persistence === 'none') {
      console.warn(
        '[billing:webhook] billing_webhook_events table missing; processing without idempotency persistence',
        {
          eventId: event.id,
          eventType: event.type,
        },
      );
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session,
          event.id,
          supabaseAdminClient,
        );
        break;

      case 'customer.subscription.created':
        await handleSubscriptionCreatedOrUpdated(
          event.data.object as Stripe.Subscription,
          'customer.subscription.created',
          event.id,
          supabaseAdminClient,
        );
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionCreatedOrUpdated(
          event.data.object as Stripe.Subscription,
          'customer.subscription.updated',
          event.id,
          supabaseAdminClient,
        );
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
          supabaseAdminClient,
          event.id,
        );
        break;

      case 'invoice.paid':
        await handleInvoicePaid(
          event.data.object as Stripe.Invoice,
          supabaseAdminClient,
          event.id,
        );
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(
          event.data.object as Stripe.Invoice,
          supabaseAdminClient,
          event.id,
        );
        break;

      case 'invoice.payment_action_required':
        await handleInvoicePaymentActionRequired(
          event.data.object as Stripe.Invoice,
          supabaseAdminClient,
          event.id,
        );
        break;

      case 'payment_intent.requires_action':
        handlePaymentIntentRequiresAction(
          event.data.object as Stripe.PaymentIntent,
          event.id,
        );
        break;

      default:
        console.log('[billing:webhook] unhandled event type, acknowledging', {
          eventId: event.id,
          eventType: event.type,
        });
        break;
    }

    await markBillingWebhookEventCompleted(supabaseAdminClient, event);
  } catch (err) {
    if (supabaseAdminClient) {
      try {
        await markBillingWebhookEventFailed(supabaseAdminClient, event, err);
      } catch (markFailedError) {
        console.error(
          '[billing:webhook] failed to persist webhook failure state',
          markFailedError,
        );
      }
    }
    console.error(`[billing:webhook] Error handling ${event.type}:`, err);
    return NextResponse.json({ error: 'Webhook handler failed.' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

export async function POST(request: NextRequest) {
  return handleStripeWebhook(request);
}

// ---------------------------------------------------------------------------
// Intent commit (webhook safety-net for new per-org restaurant creation flow)
// ---------------------------------------------------------------------------

/**
 * Commits a pending organization creation intent during the webhook.
 * This is a safety net — the success page's finalize-checkout flow is the
 * primary path. If the user closes the browser before the redirect, this
 * ensures the org is still created when Stripe fires the webhook.
 * Returns the new organizationId on success, null on failure or skip.
 */
async function commitIntentInWebhook(
  supabaseAdminClient: typeof supabaseAdmin,
  intentId: string,
  authUserId: string,
  eventId: string,
): Promise<string | null> {
  const { data: intent } = await supabaseAdminClient
    .from('organization_create_intents')
    .select('id,status,organization_id,restaurant_name,location_name')
    .eq('id', intentId)
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (!intent) {
    console.warn('[billing:webhook] commitIntentInWebhook: intent not found', { eventId, intentId, authUserId });
    return null;
  }

  // Idempotency: already committed by the success-page flow
  const typedIntent = intent as {
    id: string;
    status: string;
    organization_id: string | null;
    restaurant_name: string;
    location_name: string | null;
  };
  if (typedIntent.organization_id) {
    if (typedIntent.status !== 'completed') {
      await supabaseAdminClient
        .from('organization_create_intents')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', intentId);
    }
    console.log('[billing:webhook] commitIntentInWebhook: already committed', {
      eventId, intentId, organizationId: typedIntent.organization_id,
    });
    return typedIntent.organization_id;
  }

  if (typedIntent.status !== 'pending') {
    console.warn('[billing:webhook] commitIntentInWebhook: intent not pending', {
      eventId, intentId, status: typedIntent.status,
    });
    return null;
  }

  // Create organization (retry up to 5 times for restaurant_code collisions)
  let createdOrgId: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidateCode = generateRestaurantCode();
    const { data: orgData, error: orgError } = await supabaseAdminClient
      .from('organizations')
      .insert({ name: typedIntent.restaurant_name, restaurant_code: candidateCode })
      .select('id')
      .single();

    if (!orgError && orgData) {
      createdOrgId = (orgData as { id: string }).id;
      break;
    }
    const isDuplicate = orgError?.code === '23505';
    if (!isDuplicate) {
      console.error('[billing:webhook] commitIntentInWebhook: org insert failed', {
        eventId, intentId, error: orgError?.message,
      });
      return null;
    }
  }

  if (!createdOrgId) {
    console.error('[billing:webhook] commitIntentInWebhook: could not generate unique restaurant code', {
      eventId, intentId,
    });
    return null;
  }

  try {
    // Membership
    await supabaseAdminClient
      .from('organization_memberships')
      .upsert(
        { organization_id: createdOrgId, auth_user_id: authUserId, role: 'admin' },
        { onConflict: 'organization_id,auth_user_id' },
      );

    // User profile — use existing profile data if present, otherwise default
    const { data: existingUser } = await supabaseAdminClient
      .from('users')
      .select('full_name,email,phone,jobs')
      .eq('auth_user_id', authUserId)
      .limit(1)
      .maybeSingle();

    const typedUser = existingUser as {
      full_name?: string;
      email?: string;
      phone?: string;
      jobs?: unknown[];
    } | null;
    const fullName = String(typedUser?.full_name ?? '').trim() || 'Team Member';
    const email = String(typedUser?.email ?? '').trim() || null;
    const phone = String(typedUser?.phone ?? '').trim() || null;
    const jobs = Array.isArray(typedUser?.jobs) ? typedUser.jobs : [];

    await supabaseAdminClient
      .from('users')
      .upsert(
        { auth_user_id: authUserId, organization_id: createdOrgId, email, full_name: fullName, phone, role: 'admin', jobs },
        { onConflict: 'organization_id,auth_user_id' },
      );

    // Location (optional)
    const locationName = String(typedIntent.location_name ?? '').trim();
    if (locationName) {
      await supabaseAdminClient
        .from('locations')
        .insert({ organization_id: createdOrgId, name: locationName, sort_order: 0 });
    }

    // Mark intent completed
    await supabaseAdminClient
      .from('organization_create_intents')
      .update({
        status: 'completed',
        organization_id: createdOrgId,
        updated_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', intentId);

    console.log('[billing:webhook] commitIntentInWebhook: success', { eventId, intentId, organizationId: createdOrgId });
    return createdOrgId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[billing:webhook] commitIntentInWebhook: failed, rolling back', { eventId, intentId, error: message });
    await supabaseAdminClient.from('organization_memberships').delete().eq('organization_id', createdOrgId);
    await supabaseAdminClient.from('users').delete().eq('organization_id', createdOrgId);
    await supabaseAdminClient.from('organizations').delete().eq('id', createdOrgId);
    await supabaseAdminClient
      .from('organization_create_intents')
      .update({ status: 'failed', updated_at: new Date().toISOString(), last_error: { message } })
      .eq('id', intentId);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  eventId: string,
  supabaseAdminClient: typeof supabaseAdmin,
) {
  console.log('[billing:webhook] checkout.session.completed payload', {
    eventId,
    eventType: 'checkout.session.completed',
    sessionId: session.id,
    subscription: session.subscription,
    customer: session.customer,
    metadata: session.metadata ?? null,
    mode: session.mode,
  });

  if (session.mode !== 'subscription') return;

  const subscriptionId = getSubscriptionId(session.subscription);

  if (!subscriptionId) {
    throw new Error('checkout.session.completed missing subscription ID');
  }

  // Always pull the full, current subscription object before DB writes.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  let organizationId: string | null = subscription.metadata?.organization_id ?? null;
  if (!organizationId) {
    organizationId = session.metadata?.organization_id ?? null;
  }

  if (!organizationId) {
    console.warn(
      '[billing:webhook] checkout.session.completed missing organization_id in subscription metadata, falling back to session metadata',
      { eventId, subscriptionId },
    );
  }

  if (!organizationId) {
    // Check for a pending intent — new per-org restaurant creation flow.
    // The success page is the primary commit path; this is the safety net
    // for users who close the browser before the redirect completes.
    const pendingIntentId =
      String(subscription.metadata?.intent_id ?? session.metadata?.intent_id ?? '').trim() || null;

    if (pendingIntentId) {
      const authUserId = await resolveAuthUserIdForSubscription(supabaseAdminClient, subscription);
      if (authUserId) {
        const committedOrgId = await commitIntentInWebhook(
          supabaseAdminClient,
          pendingIntentId,
          authUserId,
          eventId,
        );
        if (committedOrgId) {
          organizationId = committedOrgId;
          // Patch organization_id onto the Stripe subscription metadata so that
          // future subscription events (updates, renewals) can resolve the org.
          try {
            await stripe.subscriptions.update(subscription.id, {
              metadata: { ...subscription.metadata, organization_id: committedOrgId },
            });
          } catch (patchErr) {
            console.warn('[billing:webhook] failed to patch subscription metadata with organization_id', {
              eventId,
              subscriptionId: subscription.id,
              error: patchErr instanceof Error ? patchErr.message : String(patchErr),
            });
          }
        }
      }
    }

    if (!organizationId) {
      console.log('[billing:webhook] checkout.session.completed has no organization metadata, billing account only', {
        eventId,
        subscriptionId: subscription.id,
        status: subscription.status,
      });
      await upsertBillingAccountRow(
        supabaseAdminClient,
        subscription,
        'checkout.session.completed',
        eventId,
      );
      return;
    }
  }

  console.log('[billing:webhook] checkout subscription details', {
    eventId,
    eventType: 'checkout.session.completed',
    organizationId,
    subscriptionId: subscription.id,
    customer: subscription.customer,
    status: subscription.status,
    currentPeriodEnd: subscription.current_period_end,
    metadata: subscription.metadata ?? null,
  });

  const upsertResult = await upsertMirroredSubscriptionState(
    supabaseAdminClient,
    subscription,
    organizationId,
    'checkout.session.completed',
    eventId,
  );

  if (upsertResult.ignoredMissingOrganization) {
    console.log('[billing:webhook] write skipped (organization missing)', {
      eventId,
      eventType: 'checkout.session.completed',
      organizationId,
      subscriptionId: subscription.id,
      status: subscription.status,
    });
  } else {
    console.log('[billing:webhook] write success', {
      eventId,
      eventType: 'checkout.session.completed',
      organizationId,
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
    });
  }
}

async function handleSubscriptionCreatedOrUpdated(
  eventSubscription: Stripe.Subscription,
  sourceEvent: 'customer.subscription.created' | 'customer.subscription.updated',
  eventId: string,
  supabaseAdminClient: typeof supabaseAdmin,
) {
  const subscriptionId = getSubscriptionId(eventSubscription);
  if (!subscriptionId) {
    throw new Error(`Missing subscription ID in ${sourceEvent}`);
  }

  // Always pull the full, current subscription object before DB writes.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const organizationId = subscription.metadata?.organization_id ?? null;
  if (!organizationId) {
    await upsertBillingAccountRow(supabaseAdminClient, subscription, sourceEvent, eventId);
    console.log('[billing:webhook] subscription event without organization metadata, billing account only', {
      eventId,
      eventType: sourceEvent,
      subscriptionId: subscription.id,
      status: subscription.status,
    });
    return;
  }

  console.log('[billing:webhook] customer.subscription retrieved', {
    eventId,
    eventType: sourceEvent,
    organizationId,
    subscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodEnd: subscription.current_period_end,
    customer: subscription.customer,
  });

  const upsertResult = await upsertMirroredSubscriptionState(
    supabaseAdminClient,
    subscription,
    organizationId,
    sourceEvent,
    eventId,
  );

  if (upsertResult.ignoredMissingOrganization) {
    console.log('[billing:webhook] write skipped (organization missing)', {
      eventId,
      eventType: sourceEvent,
      organizationId,
      subscriptionId: subscription.id,
      status: subscription.status,
    });
  } else {
    console.log('[billing:webhook] write success', {
      eventId,
      eventType: sourceEvent,
      organizationId,
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
    });
  }
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  supabaseAdminClient: typeof supabaseAdmin,
  eventId: string,
) {
  await upsertBillingAccountRow(
    supabaseAdminClient,
    subscription,
    'customer.subscription.deleted',
    eventId,
  );

  await updateMirroredSubscriptionStatus(
    supabaseAdminClient,
    subscription.id,
    'customer.subscription.deleted',
    eventId,
    {
      status: 'canceled',
      cancel_at_period_end: false,
    },
  );

  console.log('[billing:webhook] subscription canceled', {
    eventId,
    eventType: 'customer.subscription.deleted',
    subscriptionId: subscription.id,
  });
}

async function handleInvoicePaid(
  invoice: Stripe.Invoice,
  supabaseAdminClient: typeof supabaseAdmin,
  eventId: string,
) {
  const subscriptionId = getSubscriptionId(invoice.subscription);

  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const organizationId = subscription.metadata?.organization_id ?? null;
  if (!organizationId) {
    await upsertBillingAccountRow(supabaseAdminClient, subscription, 'invoice.paid', eventId);
    console.log('[billing:webhook] invoice.paid without organization metadata, billing account only', {
      eventId,
      eventType: 'invoice.paid',
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      status: subscription.status,
    });
    return;
  }

  const upsertResult = await upsertMirroredSubscriptionState(
    supabaseAdminClient,
    subscription,
    organizationId,
    'invoice.paid',
    eventId,
  );

  if (upsertResult.ignoredMissingOrganization) {
    console.log('[billing:webhook] invoice.paid skipped (organization missing)', {
      eventId,
      eventType: 'invoice.paid',
      organizationId,
      subscriptionId: subscription.id,
      status: subscription.status,
    });
  } else {
    console.log('[billing:webhook] invoice.paid upserted subscription', {
      eventId,
      eventType: 'invoice.paid',
      organizationId,
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
    });
  }
}

async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  supabaseAdminClient: typeof supabaseAdmin,
  eventId: string,
) {
  const subscriptionId = getSubscriptionId(invoice.subscription);

  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await upsertBillingAccountRow(
    supabaseAdminClient,
    subscription,
    'invoice.payment_failed',
    eventId,
  );

  await updateMirroredSubscriptionStatus(
    supabaseAdminClient,
    subscriptionId,
    'invoice.payment_failed',
    eventId,
    {
      status: 'past_due',
    },
  );

  console.error('[billing:webhook] payment failed; subscription marked past_due', {
    eventId,
    eventType: 'invoice.payment_failed',
    subscriptionId,
  });
}

async function handleInvoicePaymentActionRequired(
  invoice: Stripe.Invoice,
  supabaseAdminClient: typeof supabaseAdmin,
  eventId: string,
) {
  const subscriptionId = getSubscriptionId(invoice.subscription);
  if (!subscriptionId) {
    console.log('[billing:webhook] invoice.payment_action_required without subscription, acknowledging', {
      eventId,
      eventType: 'invoice.payment_action_required',
      invoiceId: invoice.id,
    });
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const organizationId = subscription.metadata?.organization_id ?? null;
  if (!organizationId) {
    await upsertBillingAccountRow(
      supabaseAdminClient,
      subscription,
      'invoice.payment_action_required',
      eventId,
    );
    console.log('[billing:webhook] invoice.payment_action_required without organization metadata, billing account only', {
      eventId,
      eventType: 'invoice.payment_action_required',
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      status: subscription.status,
    });
    return;
  }

  const upsertResult = await upsertMirroredSubscriptionState(
    supabaseAdminClient,
    subscription,
    organizationId,
    'invoice.payment_action_required',
    eventId,
  );

  if (upsertResult.ignoredMissingOrganization) {
    console.log('[billing:webhook] invoice.payment_action_required skipped (organization missing)', {
      eventId,
      eventType: 'invoice.payment_action_required',
      organizationId,
      subscriptionId: subscription.id,
      status: subscription.status,
    });
  } else {
    console.log('[billing:webhook] invoice.payment_action_required upserted subscription', {
      eventId,
      eventType: 'invoice.payment_action_required',
      organizationId,
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
    });
  }
}

function handlePaymentIntentRequiresAction(
  paymentIntent: Stripe.PaymentIntent,
  eventId: string,
) {
  console.log('[billing:webhook] payment_intent.requires_action received', {
    eventId,
    paymentIntentId: paymentIntent.id,
    customer: paymentIntent.customer,
    invoice: paymentIntent.invoice,
    status: paymentIntent.status,
  });
}
