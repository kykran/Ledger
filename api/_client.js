// What a client sees and can do, shared by the program link (/api/program, token in the URL)
// and the client app (/api/client-app, signed in with a code and a cookie). Never prices.
import { createHash, randomBytes } from "node:crypto";
import { admin } from "./_lib.js";
import { clientProgramView, findSession, timedPlan } from "../src/programs-core.js";
import { modelFor } from "./_sync.js";
import { clientView } from "../src/engine.js";

const day = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : new Date().toISOString().slice(0, 10);
const numOrNull = v => { if (v === "" || v == null) return null; const x = Number(v); return isFinite(x) && Math.abs(x) < 100000 ? x : null; };
export const sha = s => createHash("sha256").update(String(s)).digest("hex");
export const randomToken = n => randomBytes(n).toString("base64url");

/* Programs, videos, logs, measurements and sessions (left in the package, or this month) for one client. */
export async function programView(uid, cid){
  const [cl, prof, progs, exs, logs, meas] = await Promise.all([
    admin.from("clients").select("data").eq("user_id", uid).eq("id", cid).maybeSingle(),
    admin.from("profiles").select("data").eq("user_id", uid).maybeSingle(),
    admin.from("programs").select("id,client_id,data").eq("user_id", uid).eq("client_id", cid),
    admin.from("exercises").select("id,data").eq("user_id", uid),
    admin.from("program_logs").select("*").eq("user_id", uid).eq("client_id", cid),
    admin.from("measurements").select("*").eq("user_id", uid).eq("client_id", cid)
  ]);
  if (!cl.data) return null;
  const programs = (progs.data || []).map(r => ({ ...r.data, id: r.id, clientId: r.client_id }));
  const exercises = (exs.data || []).map(r => ({ id: r.id, ...r.data }));
  // Sign only the uploaded videos this client's programs use.
  const used = new Set(); for (const p of programs) for (const w of p.weeks || []) for (const s of w.sessions || []) for (const r of s.rows || []) if (r.exId) used.add(r.exId);
  const paths = exercises.filter(e => used.has(e.id) && e.videoPath).map(e => e.videoPath);
  const videoUrls = {};
  if (paths.length){
    const { data: signed } = await admin.storage.from("exercise-videos").createSignedUrls(paths, 6 * 3600);
    for (const s of signed || []) if (s.signedUrl) videoUrls[s.path] = s.signedUrl;
  }
  const v = clientProgramView({ client: cl.data, trainerName: prof.data && prof.data.data && prof.data.data.trainerName, programs, exercises, logs: logs.data, measurements: meas.data, videoUrls });
  // Sessions left / this month, from the calendar. The page still works if this fails.
  try { const model = await modelFor(uid), b = model && clientView(model.M, cid); if (b){ b.timeZone = model.profile.timeZone || process.env.TZ; v.sessions = b; } } catch (e){}
  return v;
}

export const FLAG_REASONS = ["Canceled early", "Session never happened", "Wrong date or time", "Something else"];

/* Logging homework, bodyweight, and (client app only) flagging a session date. Returns {status, body}. */
export async function clientAction(uid, cid, b, { flags = false } = {}){
  if (b.action === "weight"){
    const w = numOrNull(b.weight);
    if (w == null || w <= 0) return { status: 400, body: { message: "Enter your weight." } };
    const { error } = await admin.from("measurements").insert({ user_id: uid, client_id: cid, taken_on: day(b.taken_on), weight: w, source: "client" });
    if (error) throw error;
    return { status: 200, body: { ok: true } };
  }
  if (b.action === "log"){
    const { data: pr } = await admin.from("programs").select("id,client_id,data").eq("user_id", uid).eq("id", String(b.program_id || "")).maybeSingle();
    if (!pr || pr.client_id !== cid) return { status: 404, body: { message: "That program isn't available." } };
    const found = findSession(pr.data, String(b.session_id || ""));
    if (!found) return { status: 404, body: { message: "That session isn't in your program anymore." } };
    if (!found.session.homework) return { status: 403, body: { message: "Your trainer logs this session. Only homework can be logged here." } };
    const rows = Object.fromEntries((found.session.rows || []).map(r => [r.id, r]));
    const now = new Date().toISOString(), on = day(b.logged_on);
    const sets = (Array.isArray(b.sets) ? b.sets : []).slice(0, 200).filter(s => rows[s.row_id] && Number.isInteger(+s.set_no) && +s.set_no >= 1 && +s.set_no <= 12);
    const up = sets.map(s => ({ user_id: uid, program_id: pr.id, session_id: found.session.id, row_id: s.row_id, set_no: +s.set_no, client_id: cid,
      ex_name: String(rows[s.row_id].name || "").slice(0, 120), reps: numOrNull(s.reps), weight: numOrNull(s.weight), timed: timedPlan(rows[s.row_id]), done: !!s.done, logged_on: on, source: "client", updated_at: now }));
    if (up.length){ const { error } = await admin.from("program_logs").upsert(up); if (error) throw error; }
    return { status: 200, body: { ok: true, saved: up.length } };
  }
  if (flags && b.action === "flag"){
    const at = new Date(String(b.session_at || ""));
    if (isNaN(at)) return { status: 400, body: { message: "Pick a session." } };
    const reason = FLAG_REASONS.includes(b.reason) ? b.reason : null;
    if (!reason) return { status: 400, body: { message: "Pick a reason." } };
    const note = String(b.note || "").trim().slice(0, 500);
    if (reason === "Something else" && !note) return { status: 400, body: { message: "Add a short note so your trainer knows what's up." } };
    const { data: open } = await admin.from("session_flags").select("id").eq("user_id", uid).eq("client_id", cid).eq("session_at", at.toISOString()).is("resolved_at", null).limit(1);
    const row = { user_id: uid, client_id: cid, session_at: at.toISOString(), reason, note };
    const { error } = open && open[0] ? await admin.from("session_flags").update({ reason, note, created_at: new Date().toISOString() }).eq("id", open[0].id) : await admin.from("session_flags").insert(row);
    if (error) throw error;
    return { status: 200, body: { ok: true } };
  }
  if (flags && b.action === "unflag"){
    const at = new Date(String(b.session_at || ""));
    if (isNaN(at)) return { status: 400, body: { message: "Pick a session." } };
    await admin.from("session_flags").delete().eq("user_id", uid).eq("client_id", cid).eq("session_at", at.toISOString()).is("resolved_at", null);
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { message: "Unknown action" } };
}

/* The client's flags from the last few months, for the Sessions tab. */
export async function flagsFor(uid, cid){
  const since = new Date(Date.now() - 400 * 86400000).toISOString();
  const { data } = await admin.from("session_flags").select("session_at,reason,note,created_at,resolved_at,reply").eq("user_id", uid).eq("client_id", cid).gte("session_at", since);
  return (data || []).map(f => ({ at: new Date(f.session_at).toISOString(), reason: f.reason, note: f.note, resolved: !!f.resolved_at, reply: f.reply || "" }));
}
