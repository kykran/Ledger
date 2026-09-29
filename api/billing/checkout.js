// POST /api/billing/checkout -> {url}  Starts the $3/month subscription on a Stripe-hosted page.
// Someone who already subscribes is sent to the customer portal instead of a second subscription.
import { admin, send, userFrom, origin } from "../_lib.js";
import { stripe, customerFor, ACCESS } from "./_stripe.js";

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { message: "POST only" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { code: "needs_reauth" });
  try {
    const customer = await customerFor(user);
    const { data: row } = await admin.from("subscriptions").select("status").eq("user_id", user.id).maybeSingle();
    if (row && ACCESS.has(row.status)){
      const p = await stripe.billingPortal.sessions.create({ customer, return_url: `${origin(req)}/` });
      return send(res, 200, { url: p.url });
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id }, billing_mode: { type: "flexible" } },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      ...(process.env.STRIPE_AUTOMATIC_TAX === "true" ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" } } : {}),
      success_url: `${origin(req)}/?billing=success`,
      cancel_url: `${origin(req)}/?billing=cancelled`
    });
    return send(res, 200, { url: session.url });
  } catch (e) {
    console.error("checkout", e);
    return send(res, 500, { message: "Couldn't start checkout. Try again in a moment." });
  }
}
