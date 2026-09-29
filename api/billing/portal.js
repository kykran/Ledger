// POST /api/billing/portal -> {url}  Stripe's hosted page: update card, see invoices, cancel.
import { send, userFrom, origin } from "../_lib.js";
import { stripe, customerFor } from "./_stripe.js";

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { message: "POST only" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { code: "needs_reauth" });
  try {
    const customer = await customerFor(user);
    const s = await stripe.billingPortal.sessions.create({ customer, return_url: `${origin(req)}/` });
    return send(res, 200, { url: s.url });
  } catch (e) {
    console.error("portal", e);
    return send(res, 500, { message: "Couldn't open billing. Try again in a moment." });
  }
}
