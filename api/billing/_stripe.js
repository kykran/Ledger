// Shared Stripe helpers for the billing routes.
import Stripe from "stripe";
import { admin } from "../_lib.js";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { maxNetworkRetries: 2 });

// Statuses that keep the app unlocked. past_due keeps access while Stripe retries the card.
export const ACCESS = new Set(["active", "trialing", "past_due"]);

// current_period_end moved onto subscription items in API version 2025-03-31.basil; read either.
export function periodEnd(sub){
  const t = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  return t ? new Date(t * 1000) : null;
}

// Find this user's Stripe customer, creating one (once) if needed.
export async function customerFor(user){
  const { data } = await admin.from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
  if (data && data.stripe_customer_id) return data.stripe_customer_id;
  const c = await stripe.customers.create(
    { email: user.email, metadata: { user_id: user.id } },
    { idempotencyKey: "customer-" + user.id }
  );
  await admin.from("subscriptions").upsert({ user_id: user.id, stripe_customer_id: c.id, updated_at: new Date().toISOString() });
  return c.id;
}

// Always re-read the subscription from Stripe, so out-of-order webhooks can't store stale state.
export async function syncSubscription(subId){
  const sub = await stripe.subscriptions.retrieve(subId);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let userId = sub.metadata && sub.metadata.user_id;
  if (!userId){
    const { data } = await admin.from("subscriptions").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
    userId = data && data.user_id;
  }
  if (!userId) return;
  const end = periodEnd(sub);
  // Access runs to the end of the paid period plus two days of leeway for renewals.
  const accessUntil = ACCESS.has(sub.status) && end ? new Date(end.getTime() + 2 * 86400000) : new Date();
  await admin.from("subscriptions").upsert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    current_period_end: end ? end.toISOString() : null,
    access_until: accessUntil.toISOString(),
    updated_at: new Date().toISOString()
  });
}
