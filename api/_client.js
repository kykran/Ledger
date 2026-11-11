// What a client sees and can do, shared by the program link (/api/program, token in the URL)
// and the client app (/api/client-app, signed in with a code and a cookie). Never prices.
import { createHash, randomBytes } from "node:crypto";
import { admin } from "./_lib.js";
import { clientProgramView, findSession, timedPlan, askWorkout, swapOptions, SWAP_REASONS, pid } from "../src/programs-core.js";
import { modelFor } from "./_sync.js";
import { clientView } from "../src/engine.js";

const day = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : new Date().toISOString().slice(0, 10);
const numOrNull = v => { if (v === "" || v == null) return null; const x = Number(v); return isFinite(x) && Math.abs(x) < 100000 ? x : null; };
export const sha = s => createHash("sha256").update(String(s)).digest("hex");
export const randomToken = n => randomBytes(n).toString("base64url");

/* Programs, videos, logs, measurements and sessions (left in the package, or this month) for one client. */
export async function programView(uid, cid){
  const [cl, prof, progs, exs, logs, meas, cw] = await Promise.all([
    admin.from("clients").select("data").eq("user_id", uid).eq("id", cid).maybeSingle(),
    admin.from("profiles").select("data").eq("user_id", uid).maybeSingle(),
    admin.from("programs").select("id,client_id,data").eq("user_id", uid).eq("client_id", cid),
    admin.from("exercises").select("id,data").eq("user_id", uid),
    admin.from("program_logs").select("*").eq("user_id", uid).eq("client_id", cid),
    admin.from("measurements").select("*").eq("user_id", uid).eq("client_id", cid),
    admin.from("client_workouts").select("id,program_id,on_date,data").eq("user_id", uid).eq("client_id", cid)
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
  const v = clientProgramView({ client: cl.data, trainerName: prof.data && prof.data.data && prof.data.data.trainerName, programs, exercises, logs: logs.data, measurements: meas.data, videoUrls, clientWorkouts: cw.data || [] });
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
    let found = findSession(pr.data, String(b.session_id || ""));
    if (!found){ const { data: w } = await admin.from("client_workouts").select("id,data").eq("user_id", uid).eq("client_id", cid).eq("program_id", pr.id).eq("id", String(b.session_id || "")).maybeSingle();
      if (w) found = { session: { ...(w.data || {}), id: w.id, homework: true } }; }
    if (!found) return { status: 404, body: { message: "That session isn't in your program anymore." } };
    if (!found.session.homework) return { status: 403, body: { message: "Your trainer logs this session. Only homework can be logged here." } };
    const rows = Object.fromEntries((found.session.rows || []).map(r => [r.id, r]));
    const now = new Date().toISOString(), on = day(b.logged_on);
    const sets = (Array.isArray(b.sets) ? b.sets : []).slice(0, 200).filter(s => rows[s.row_id] && Number.isInteger(+s.set_no) && +s.set_no >= 1 && +s.set_no <= 12);
    const up = sets.map(s => ({ user_id: uid, program_id: pr.id, session_id: found.session.id, row_id: s.row_id, set_no: +s.set_no, client_id: cid,
      ex_name: String((b.swaps && typeof b.swaps[s.row_id] === "string" && b.swaps[s.row_id]) || rows[s.row_id].name || "").slice(0, 120), reps: numOrNull(s.reps), weight: numOrNull(s.weight), timed: timedPlan(rows[s.row_id]), done: !!s.done, logged_on: on, source: "client", updated_at: now }));
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
  if (flags && b.action === "suggest") return { status: 200, body: await suggestFor(uid, cid, b) };
  if (flags && b.action === "swap") return { status: 200, body: await swapFor(uid, cid, b) };
  if (flags && b.action === "addWorkout"){
    const { data: pr } = await admin.from("programs").select("id,client_id").eq("user_id", uid).eq("id", String(b.program_id || "")).maybeSingle();
    if (!pr || pr.client_id !== cid) return { status: 404, body: { message: "That program isn't available." } };
    const w = cleanWorkout(b.workout);
    if (!w.rows.length) return { status: 400, body: { message: "Add at least one exercise." } };
    const { count } = await admin.from("client_workouts").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("client_id", cid).eq("on_date", day(b.on_date));
    if ((count || 0) >= 3) return { status: 400, body: { message: "That day already has 3 workouts you added." } };
    const id = pid("cw");
    const { error } = await admin.from("client_workouts").insert({ id, user_id: uid, client_id: cid, program_id: pr.id, on_date: day(b.on_date), data: w });
    if (error) throw error;
    return { status: 200, body: { ok: true, id } };
  }
  if (flags && b.action === "removeWorkout"){
    await admin.from("client_workouts").delete().eq("user_id", uid).eq("client_id", cid).eq("id", String(b.session_id || ""));
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { message: "Unknown action" } };
}

const str = (v, n) => String(v ?? "").slice(0, n);
function cleanWorkout(w){
  w = w || {};
  return { name: str(w.name || "Your workout", 80), notes: str(w.notes, 400), why: str(w.why, 500),
    rows: (Array.isArray(w.rows) ? w.rows : []).slice(0, 12).filter(r => r && r.name).map(r => ({ id: str(r.id, 40) || pid("r"), exId: r.exId ? str(r.exId, 60) : null,
      name: str(r.name, 80), group: str(r.group, 4), sets: str(r.sets, 8), reps: str(r.reps, 20), weight: str(r.weight, 30), note: str(r.note, 160) })) };
}

/* Asking Claude for structured JSON (one tool call). Returns the tool input, or null so the caller falls back to the built-in planner. */
async function askClaude(prompt, tool, maxTokens){
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001", max_tokens: maxTokens, system: CLIENT_SYSTEM, tools: [tool], tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => ({}));
  return (r.ok && ((j.content || []).find(x => x.type === "tool_use") || {}).input) || null;
}
const CLIENT_SYSTEM = `You help a personal training client between sessions with their trainer. You write workouts they do on their own and swap exercises they can't do.
Talk to the client in plain, friendly words, no jargon. Be conservative: never program anything the trainer's notes make risky, and when the client says something hurts, pick gentler options, tell them to stop if it hurts, and to tell their trainer. Never diagnose.
Use the trainer's exercise names when they fit. Always answer by calling the tool provided, exactly once.`;
const eqText = eq => eq ? ["bodyweight", ...eq].join(", ") : "bodyweight and light dumbbells";
const cleanAsk = t => String(t || "").replace(/\s+/g, " ").trim().slice(0, 300);

/* The client's heaviest recent set per exercise, so Claude can suggest loads. */
async function recentBests(uid, cid){
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const { data } = await admin.from("program_logs").select("ex_name,reps,weight,logged_on").eq("user_id", uid).eq("client_id", cid).gte("logged_on", since).limit(1000);
  const best = {}; for (const l of data || []){ if (!l.ex_name || l.weight == null) continue; const b = best[l.ex_name]; if (!b || l.weight > b.weight) best[l.ex_name] = l; }
  return Object.values(best).slice(0, 40).map(l => `${l.ex_name} ${l.weight}x${l.reps ?? "?"}`).join("; ") || "none yet";
}

/* A workout for one day. With no ask it fits between the client's last trainer session and their next one;
 * with an ask ("30 min legs, hotel gym, knee is sore") it's what they asked for.
 * Claude writes it when ANTHROPIC_API_KEY is set (reading the trainer's notes on injuries); otherwise the built-in planner does. */
async function suggestFor(uid, cid, b){
  const [{ data: pr }, { data: exs }, { data: cl }] = await Promise.all([
    admin.from("programs").select("id,client_id,data").eq("user_id", uid).eq("id", String(b.program_id || "")).maybeSingle(),
    admin.from("exercises").select("id,data").eq("user_id", uid),
    admin.from("clients").select("data").eq("user_id", uid).eq("id", cid).maybeSingle()
  ]);
  if (!pr || pr.client_id !== cid) return { message: "That program isn't available." };
  const library = (exs || []).map(r => ({ id: r.id, ...r.data }));
  const find = id => { const f = id && findSession(pr.data, String(id)); return f ? f.session : null; };
  const last = find(b.last_id), next = find(b.next_id), seed = Math.max(0, Math.min(20, +b.seed || 0)), ask = cleanAsk(b.ask);
  const equipment = Array.isArray(b.equipment) ? b.equipment.map(String).slice(0, 12) : null;
  const base = askWorkout({ ask, last, next, library, seed, equipment });
  if (!process.env.ANTHROPIC_API_KEY || b.noAi) return { workout: base, by: "planner" };
  try {
    const notes = (cl && cl.data && cl.data.programNotes) || "none";
    const fmt = s => s ? `${s.name}: ` + (s.rows || []).filter(r => r.name).map(r => `${r.name} ${r.sets || ""}x${r.reps || ""}${r.weight ? " @ " + r.weight : ""}`).join("; ") : "none";
    const tool = { name: "homework_workout", description: "Return the workout.", input_schema: { type: "object", properties: {
      name: { type: "string", description: "Short name, 1-4 words" }, why: { type: "string", description: "1-2 plain sentences to the client on why this workout and how to do it" },
      rows: { type: "array", items: { type: "object", properties: { group: { type: "string", description: "Pair label like A1, A2, B1" }, name: { type: "string" }, sets: { type: "string" }, reps: { type: "string" },
        weight: { type: "string", description: "Suggested load from their recent sets, else empty" }, note: { type: "string", description: "Short cue" } }, required: ["name", "sets", "reps"] } } }, required: ["name", "why", "rows"] } };
    const prompt = `The client wants a workout to do on their own on ${day(b.on_date)}.
${ask ? `What they asked for, in their words: "${ask}"\nGive them that (length, focus, place). If it says something hurts, work around it.` : `Write a 25-35 minute workout, 4-6 exercises, that balances their week: accessories that support the primary lifts in those sessions, the movement patterns those sessions skip, and single-leg and core stability. Don't repeat heavy work that would leave them sore for the next session.`}
Last session with the trainer: ${fmt(last)}
Next session with the trainer: ${fmt(next)}
Trainer's notes on this client (injuries, limits, goals): ${notes}
Their heaviest recent sets (weight x reps): ${await recentBests(uid, cid)}
Exercise library (use these exact names when they fit): ${library.map(e => e.name).join(", ")}
Equipment they have today: ${eqText(equipment)}. Use only this.
${ask ? "" : "Keep it about 30 minutes. "}Call homework_workout.`;
    const out = await askClaude(prompt, tool, 2500);
    if (!out || !Array.isArray(out.rows) || !out.rows.length) return { workout: base, by: "planner" };
    const lib = Object.fromEntries(library.map(e => [String(e.name).toLowerCase(), e]));
    const w = cleanWorkout({ name: out.name, why: out.why, rows: out.rows.map(x => { const e = lib[String(x.name).toLowerCase()]; return { ...x, id: pid("r"), name: e ? e.name : x.name, exId: e ? e.id : null }; }) });
    return { workout: w, by: "ai" };
  } catch (e){ return { workout: base, by: "planner" }; }
}

/* Up to 3 swaps for one exercise the client can't (or shouldn't) do: same job, their equipment, their trainer's notes.
 * b: {program_id, name, sets, reps, reason (equipment|busy|hurts|dislike), note, equipment, others: names already in the workout} */
async function swapFor(uid, cid, b){
  const [{ data: pr }, { data: exs }, { data: cl }] = await Promise.all([
    admin.from("programs").select("id,client_id").eq("user_id", uid).eq("id", String(b.program_id || "")).maybeSingle(),
    admin.from("exercises").select("id,data").eq("user_id", uid),
    admin.from("clients").select("data").eq("user_id", uid).eq("id", cid).maybeSingle()
  ]);
  if (!pr || pr.client_id !== cid) return { message: "That program isn't available." };
  const library = (exs || []).map(r => ({ id: r.id, ...r.data })), name = str(b.name, 80);
  const reason = SWAP_REASONS.some(r => r[0] === b.reason) ? b.reason : "dislike", note = cleanAsk(b.note);
  const equipment = Array.isArray(b.equipment) ? b.equipment.map(String).slice(0, 12) : null, others = (Array.isArray(b.others) ? b.others : []).slice(0, 15).map(x => str(x, 80));
  const base = swapOptions(name, { equipment, library, exclude: others, reason, seed: +b.seed || 0 });
  if (!process.env.ANTHROPIC_API_KEY || b.noAi) return { options: base, by: "planner" };
  try {
    const notes = (cl && cl.data && cl.data.programNotes) || "none";
    const tool = { name: "swap_options", description: "Return the swaps.", input_schema: { type: "object", properties: {
      options: { type: "array", description: "2-3 swaps, best first", items: { type: "object", properties: { name: { type: "string" }, reps: { type: "string", description: "Reps or time for each set" }, why: { type: "string", description: "Under 12 words, to the client" } }, required: ["name", "reps", "why"] } } }, required: ["options"] } };
    const why = { equipment: "They don't have the equipment for it.", busy: "The machine or station is taken.", hurts: "It hurts or doesn't feel right.", dislike: "They want something different." }[reason];
    const prompt = `The client needs a swap for "${name}" (${str(b.sets, 8) || "3"} sets x ${str(b.reps, 20) || "?"}).
Why: ${why}${note ? ` In their words: "${note}"` : ""}
Equipment they have: ${eqText(equipment)}${reason === "busy" ? " (not that machine)" : ""}. Use only this.
Already in this workout, don't repeat: ${others.join(", ") || "nothing else"}
Trainer's notes on this client (injuries, limits, goals): ${notes}
Exercise library (use these exact names when they fit): ${library.map(e => e.name).join(", ")}
Give 2-3 options that do the same job. Call swap_options.`;
    const out = await askClaude(prompt, tool, 800);
    const lib = Object.fromEntries(library.map(e => [String(e.name).toLowerCase(), e]));
    const options = (out && Array.isArray(out.options) ? out.options : []).filter(o => o && o.name).slice(0, 3).map(o => { const e = lib[String(o.name).toLowerCase()]; return { name: e ? e.name : str(o.name, 80), exId: e ? e.id : null, reps: str(o.reps, 20), why: str(o.why, 120) }; });
    return options.length ? { options, by: "ai" } : { options: base, by: "planner" };
  } catch (e){ return { options: base, by: "planner" }; }
}

/* The client's flags from the last few months, for the Sessions tab. */
export async function flagsFor(uid, cid){
  const since = new Date(Date.now() - 400 * 86400000).toISOString();
  const { data } = await admin.from("session_flags").select("session_at,reason,note,created_at,resolved_at,reply").eq("user_id", uid).eq("client_id", cid).gte("session_at", since);
  return (data || []).map(f => ({ at: new Date(f.session_at).toISOString(), reason: f.reason, note: f.note, resolved: !!f.resolved_at, reply: f.reply || "" }));
}
