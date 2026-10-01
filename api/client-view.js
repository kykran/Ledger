// GET /api/client-view?t=TOKEN — what a client sees on their private "sessions left" page.
// No sign-in: the unguessable token is the key. Shows first name, sessions and dates — never prices.
import { admin, send } from "./_lib.js";
import { modelFor } from "./_sync.js";
import { clientView } from "../src/engine.js";

export default async function handler(req, res){
  const t = String((req.query && req.query.t) || new URL(req.url, "http://x").searchParams.get("t") || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) return send(res, 404, { message: "This link isn't valid." });
  const { data: link } = await admin.from("client_links").select("*").eq("token", t).maybeSingle();
  if (!link || link.revoked_at) return send(res, 404, { message: "This link has been turned off. Ask your trainer for a new one." });
  try {
    const model = await modelFor(link.user_id);
    const v = model && clientView(model.M, link.client_id);
    if (!v) return send(res, 404, { message: "This link isn't valid." });
    v.timeZone = model.profile.timeZone || process.env.TZ;
    admin.from("client_links").update({ last_viewed_at: new Date().toISOString() }).eq("token", t).then(() => {}, () => {});
    res.setHeader("x-robots-tag", "noindex");
    return send(res, 200, v);
  } catch (e) { return send(res, 500, { message: "Couldn't load right now. Try again in a minute." }); }
}
