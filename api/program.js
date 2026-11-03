// /api/program — a client's private program page (no sign-in; the unguessable link token is the key).
//   GET  ?t=TOKEN                      -> the client's programs, exercise videos, their logs and measurements,
//                                         plus their sessions (left in the package, or this month) and booked dates. Never prices.
//   POST {t, action:"log", program_id, session_id, logged_on, sets:[{row_id, set_no, reps, weight, done}]}
//        Only sessions the trainer marked as homework can be logged; logged_on is the day the client did it.
//   POST {t, action:"weight", weight, taken_on}   -> adds a bodyweight entry
// The client app (/api/client-app) serves the same view to a signed-in client.
import { admin, send, readJson } from "./_lib.js";
import { programView, clientAction } from "./_client.js";

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

async function linkFor(t){
  if (!TOKEN.test(t)) return null;
  const { data } = await admin.from("program_links").select("*").eq("token", t).maybeSingle();
  return data && !data.revoked_at ? data : null;
}

export default async function handler(req, res){
  res.setHeader("x-robots-tag", "noindex");
  try {
    if (req.method === "GET"){
      const t = String((req.query && req.query.t) || new URL(req.url, "http://x").searchParams.get("t") || "");
      const link = await linkFor(t);
      if (!link) return send(res, 404, { message: "This link isn't valid or has been turned off. Ask your trainer for a new one." });
      const v = await programView(link.user_id, link.client_id);
      if (!v) return send(res, 404, { message: "This link isn't valid." });
      admin.from("program_links").update({ last_viewed_at: new Date().toISOString() }).eq("token", t).then(() => {}, () => {});
      return send(res, 200, v);
    }

    if (req.method !== "POST") return send(res, 405, { message: "Method not allowed" });
    const b = await readJson(req);
    const link = await linkFor(String(b.t || ""));
    if (!link) return send(res, 404, { message: "This link isn't valid or has been turned off." });
    const r = await clientAction(link.user_id, link.client_id, b);
    return send(res, r.status, r.body);
  } catch (e){
    return send(res, 500, { message: "Couldn't save right now. Try again in a minute." });
  }
}
