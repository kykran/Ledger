// /api/program — a client's private program page (no sign-in; the unguessable link token is the key).
//   GET  ?t=TOKEN                      -> the client's programs, exercise videos, their logs and measurements
//   POST {t, action:"log", program_id, session_id, logged_on, sets:[{row_id, set_no, reps, weight, done}]}
//        Only sessions the trainer marked as homework can be logged.
//   POST {t, action:"weight", weight, taken_on}   -> adds a bodyweight entry
import { admin, send, readJson } from "./_lib.js";
import { clientProgramView, findSession } from "../src/programs-core.js";

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const day = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : new Date().toISOString().slice(0, 10);
const numOrNull = v => { if (v === "" || v == null) return null; const x = Number(v); return isFinite(x) && Math.abs(x) < 100000 ? x : null; };

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
      const uid = link.user_id, cid = link.client_id;
      const [cl, prof, progs, exs, logs, meas] = await Promise.all([
        admin.from("clients").select("data").eq("user_id", uid).eq("id", cid).maybeSingle(),
        admin.from("profiles").select("data").eq("user_id", uid).maybeSingle(),
        admin.from("programs").select("id,client_id,data").eq("user_id", uid).eq("client_id", cid),
        admin.from("exercises").select("id,data").eq("user_id", uid),
        admin.from("program_logs").select("*").eq("user_id", uid).eq("client_id", cid),
        admin.from("measurements").select("*").eq("user_id", uid).eq("client_id", cid)
      ]);
      if (!cl.data) return send(res, 404, { message: "This link isn't valid." });
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
      admin.from("program_links").update({ last_viewed_at: new Date().toISOString() }).eq("token", t).then(() => {}, () => {});
      return send(res, 200, v);
    }

    if (req.method !== "POST") return send(res, 405, { message: "Method not allowed" });
    const b = await readJson(req);
    const link = await linkFor(String(b.t || ""));
    if (!link) return send(res, 404, { message: "This link isn't valid or has been turned off." });
    const uid = link.user_id, cid = link.client_id;

    if (b.action === "weight"){
      const w = numOrNull(b.weight);
      if (w == null || w <= 0) return send(res, 400, { message: "Enter your weight." });
      const { error } = await admin.from("measurements").insert({ user_id: uid, client_id: cid, taken_on: day(b.taken_on), weight: w, source: "client" });
      if (error) throw error;
      return send(res, 200, { ok: true });
    }

    if (b.action === "log"){
      const { data: pr } = await admin.from("programs").select("id,client_id,data").eq("user_id", uid).eq("id", String(b.program_id || "")).maybeSingle();
      if (!pr || pr.client_id !== cid) return send(res, 404, { message: "That program isn't available." });
      const found = findSession(pr.data, String(b.session_id || ""));
      if (!found) return send(res, 404, { message: "That session isn't in your program anymore." });
      if (!found.session.homework) return send(res, 403, { message: "Your trainer logs this session. Only homework can be logged here." });
      const rows = Object.fromEntries((found.session.rows || []).map(r => [r.id, r]));
      const now = new Date().toISOString(), on = day(b.logged_on);
      const sets = (Array.isArray(b.sets) ? b.sets : []).slice(0, 200).filter(s => rows[s.row_id] && Number.isInteger(+s.set_no) && +s.set_no >= 1 && +s.set_no <= 12);
      const up = sets.map(s => ({ user_id: uid, program_id: pr.id, session_id: found.session.id, row_id: s.row_id, set_no: +s.set_no, client_id: cid,
        ex_name: String(rows[s.row_id].name || "").slice(0, 120), reps: numOrNull(s.reps), weight: numOrNull(s.weight), done: !!s.done, logged_on: on, source: "client", updated_at: now }));
      if (up.length){ const { error } = await admin.from("program_logs").upsert(up); if (error) throw error; }
      return send(res, 200, { ok: true, saved: up.length });
    }
    return send(res, 400, { message: "Unknown action" });
  } catch (e){
    return send(res, 500, { message: "Couldn't save right now. Try again in a minute." });
  }
}
