// POST /api/outbox
//   {action:"send", id}             approve and send a held (or failed) message
//   {action:"test", kind:"weekly"|"monthly"}  build that summary now and send it to you
//   {action:"workout", clientId, programId, sessionId}  email one written session to the client now
import { admin, send, readJson, userFrom, origin } from "./_lib.js";
import { modelFor } from "./_sync.js";
import { deliver, mailReady } from "./_mail.js";
import { weeklySummary, monthlySummary, DEFAULTS } from "../src/engine.js";
import { workoutEmail } from "../src/programs-core.js";
import { programLinkFor } from "./_notices.js";

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { message: "POST only" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { code: "needs_reauth", message: "Sign in again" });
  const body = await readJson(req), { action, id, kind } = body;
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
    if (action === "workout"){
      const cid = String(body.clientId || "");
      const [{ data: cl }, { data: pr }, { data: pf }] = await Promise.all([
        admin.from("clients").select("data").eq("user_id", user.id).eq("id", cid).maybeSingle(),
        admin.from("programs").select("data").eq("user_id", user.id).eq("id", String(body.programId || "")).maybeSingle(),
        admin.from("profiles").select("data").eq("user_id", user.id).maybeSingle()]);
      if (!cl || !pr) return send(res, 404, { message: "Client or program not found" });
      const c = cl.data || {}, prof = (pf && pf.data) || {};
      if (!c.email) return send(res, 400, { message: "Add the client's email first" });
      let session = null, weekLabel = "";
      for (const w of pr.data.weeks || []) for (const x of w.sessions || []) if (x.id === body.sessionId){ session = x; weekLabel = w.label; }
      if (!session || !(session.rows || []).some(r => r.name)) return send(res, 400, { message: "That session has no exercises yet" });
      const token = await programLinkFor(user.id, cid);
      const m = workoutEmail({ first: String(c.name || "").trim().split(/[\s+&]/)[0] || "there", trainer: prof.trainerName, session, weekLabel, when: null, link: token ? origin(req) + "/p/" + token : "" });
      const { data: row, error } = await admin.from("outbox").insert({ user_id: user.id, kind: "workout", client_id: cid, dedupe_key: "workout-now:" + Date.now(),
        to_email: c.email, subject: m.subject, html: m.html, body_text: m.text }).select().single();
      if (error) throw error;
      return send(res, 200, { status: await deliver(row, { trainerName: prof.trainerName, replyTo: prof.myEmail || user.email }), mailReady: mailReady() });
    }
    return send(res, 400, { message: "Unknown action" });
  } catch (e) { return send(res, 500, { message: e.message }); }
}
