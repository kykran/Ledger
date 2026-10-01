// POST /api/outbox
//   {action:"send", id}             approve and send a held (or failed) message
//   {action:"test", kind:"weekly"|"monthly"}  build that summary now and send it to you
import { admin, send, readJson, userFrom, origin } from "./_lib.js";
import { modelFor } from "./_sync.js";
import { deliver, mailReady } from "./_mail.js";
import { weeklySummary, monthlySummary, DEFAULTS } from "../src/engine.js";

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { message: "POST only" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { code: "needs_reauth", message: "Sign in again" });
  const { action, id, kind } = await readJson(req);
  try {
    if (action === "send"){
      const { data: row } = await admin.from("outbox").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      if (!row) return send(res, 404, { message: "Message not found" });
      if (row.status === "sent") return send(res, 200, { status: "sent" });
      await admin.from("outbox").update({ status: "queued" }).eq("id", row.id);
      const { data: p } = await admin.from("profiles").select("data").eq("user_id", user.id).maybeSingle();
      const prof = (p && p.data) || {};
      return send(res, 200, { status: await deliver(row, { trainerName: prof.trainerName, replyTo: prof.myEmail || user.email }), mailReady: mailReady() });
    }
    if (action === "test"){
      const model = await modelFor(user.id);
      if (!model) return send(res, 400, { message: "Finish setup first" });
      const m = (kind === "monthly" ? monthlySummary : weeklySummary)(model.M, { appUrl: origin(req) });
      const cfg = { ...DEFAULTS.notices, ...(model.profile.notices || {}) };
      const { data: row, error } = await admin.from("outbox").insert({ user_id: user.id, kind: "test", dedupe_key: "test:" + Date.now(),
        to_email: cfg.email || model.profile.myEmail || user.email, subject: "[Preview] " + m.subject, html: m.html, body_text: m.text }).select().single();
      if (error) throw error;
      return send(res, 200, { status: await deliver(row, {}), mailReady: mailReady(), id: row.id });
    }
    return send(res, 400, { message: "Unknown action" });
  } catch (e) { return send(res, 500, { message: e.message }); }
}
