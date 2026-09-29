// POST /api/billing/webhook  Stripe -> subscription state in Supabase.
// Stripe Dashboard → Developers → Webhooks → Add endpoint: https://YOUR-DOMAIN/api/billing/webhook
// Events: checkout.session.completed, customer.subscription.created, customer.subscription.updated,
//         customer.subscription.deleted, customer.subscription.paused, customer.subscription.resumed,
//         invoice.paid, invoice.payment_failed
import { stripe, syncSubscription } from "./_stripe.js";

export const config = { api: { bodyParser: false } };

async function raw(req){ const chunks = []; for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c); return Buffer.concat(chunks); }

// Invoices point at their subscription differently across API versions.
const invoiceSub = inv => inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;

export default async function handler(req, res){
  if (req.method !== "POST"){ res.statusCode = 405; return res.end(); }
  let event;
  try { event = stripe.webhooks.constructEvent(await raw(req), req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { res.statusCode = 400; return res.end(`Webhook signature check failed: ${e.message}`); }

  const o = event.data.object;
  try {
    let subId = null;
    if (event.type === "checkout.session.completed" && o.mode === "subscription") subId = o.subscription;
    else if (event.type.startsWith("customer.subscription.")) subId = o.id;
    else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") subId = invoiceSub(o);
    if (subId) await syncSubscription(typeof subId === "string" ? subId : subId.id);
  } catch (e) {
    console.error("webhook", event.type, e);
    res.statusCode = 500; return res.end("retry");   // Stripe retries on non-2xx
  }
  res.statusCode = 200; res.end("ok");
}
