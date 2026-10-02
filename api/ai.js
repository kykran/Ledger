// POST /api/ai — the Programs assistant. Signed-in trainers only.
//   {action:"create",   clientId, ownerId?, brief:{weeks, daysPerWeek, goal, equipment, notes}}
//   {action:"critique", clientId, ownerId?, programId}
//   {action:"progress", clientId, ownerId?, programId, week, session?, direction, notes}
//      session given -> progress that one session; omitted -> progress the whole week
// Reads the client's programming notes (injuries, goals, limitations), the program, the exercise
// library and recent logs, asks Claude, and returns a draft. Nothing is saved here: the trainer
// reviews the draft in the app and decides what to keep.
import { admin, send, readJson, userFrom } from "./_lib.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const DIRECTIONS = { stability: "more stability and control (unilateral, anti-rotation, tempo, balance, controlled ranges)",
  strength: "more strength (heavier loads, lower reps, longer rest, bilateral compound lifts)",
  power: "more power (explosive intent, jumps, throws, Olympic-lift derivatives where appropriate, low reps)",
  coordination: "more coordination and athleticism (multi-planar, footwork, reactive and combination movements)",
  endurance: "more muscular and cardiovascular endurance (higher reps, density, circuits, shorter rest)",
  hypertrophy: "more muscle growth (moderate loads, 8-15 reps, more sets per muscle, controlled eccentrics)",
  mobility: "more mobility and range of motion (loaded stretches, end-range strength, positional work)",
  deload: "a deload week (reduce volume about 40%, keep movement patterns, lower intensity)" };

const SYSTEM = `You are the programming assistant inside Trainer Tally, working for a certified personal trainer who runs one-on-one sessions.
You draft, critique and progress strength and conditioning programs. The trainer reviews everything you write and makes the final call.

How to work:
- Be specific and practical, the way an experienced strength coach writes a program card: exercise, sets, reps, load guidance, short coaching note.
- Prefer exercises from the trainer's library and use their exact names. You may suggest new exercises when they are clearly better; give them a clear, standard name and mark them new.
- Use the client's logged weights and reps to set loads. Write load guidance in the weight field as a number in the client's units when there's a logged reference, otherwise as RPE or a short cue (e.g. "RPE 7", "+5 lb", "bodyweight").
- Sets is a number. Reps can be a number, a range ("8-10"), per side ("8 each") or time ("30s").
- Use group letters for supersets and circuits (A1/A2, B1/B2/B3) when it saves time sensibly.
- Read the client's programming notes carefully. If an injury, condition or limitation makes an exercise risky, do not program it; if you keep something that needs care, add a flag. Every flag names the exercise, the concern, and a safer option. Be conservative. Flag anything that needs a clinician's clearance; never diagnose.
- Keep sessions realistic for a 45-60 minute one-on-one session unless told otherwise. Homework sessions should be doable alone with minimal equipment.
Always answer by calling the tool provided, exactly once.`;

const rowSchema = { type: "object", properties: {
  group: { type: "string", description: "Superset/circuit label like A1, A2, B1. Empty if none." },
  name: { type: "string" }, sets: { type: "string" }, reps: { type: "string" },
  weight: { type: "string", description: "Load guidance" }, note: { type: "string", description: "Short coaching cue for this client" },
  isNew: { type: "boolean", description: "True if this exercise is not in the trainer's library" },
  muscle: { type: "string", description: "Only for new exercises: main muscle group" }, equipment: { type: "string", description: "Only for new exercises" },
  cues: { type: "string", description: "Only for new exercises: 1-2 coaching cues" } }, required: ["name", "sets", "reps"] };
const sessionSchema = { type: "object", properties: { name: { type: "string" }, homework: { type: "boolean" }, notes: { type: "string" }, rows: { type: "array", items: rowSchema } }, required: ["name", "rows"] };
const flagSchema = { type: "array", description: "Contraindication and safety flags based on the client's notes", items: { type: "object", properties: {
  exercise: { type: "string" }, concern: { type: "string" }, alternative: { type: "string" } }, required: ["exercise", "concern"] } };

const TOOLS = {
  create: { name: "draft_program", description: "Return the drafted program.", input_schema: { type: "object", properties: {
    name: { type: "string" }, summary: { type: "string", description: "2-4 sentences on the plan and how it progresses" },
    weeks: { type: "array", items: { type: "object", properties: { label: { type: "string" }, sessions: { type: "array", items: sessionSchema } }, required: ["label", "sessions"] } },
    flags: flagSchema }, required: ["name", "summary", "weeks", "flags"] } },
  critique: { name: "critique_program", description: "Return the critique.", input_schema: { type: "object", properties: {
    summary: { type: "string", description: "2-4 sentence overall assessment" },
    strengths: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" }, priority: { type: "string", enum: ["high", "medium", "low"] }, where: { type: "string", description: "Week/session it applies to, if specific" } }, required: ["title", "detail", "priority"] } },
    flags: flagSchema }, required: ["summary", "strengths", "suggestions", "flags"] } },
  progress: { name: "progress_workout", description: "Return the progressed workout.", input_schema: { type: "object", properties: {
    summary: { type: "string", description: "1-3 sentences on what changed and why" },
    changes: { type: "array", items: { type: "string" }, description: "Bullet list of specific changes vs the current version" },
    sessions: { type: "array", items: sessionSchema, description: "The new version: one session if one was given, otherwise every session of the week in the same order" },
    flags: flagSchema }, required: ["summary", "changes", "sessions", "flags"] } }
};

const fmtRows = s => (s.rows || []).filter(r => r.name).map(r => `    ${r.group ? r.group + " " : ""}${r.name}: ${r.sets || "?"} x ${r.reps || "?"}${r.weight ? " @ " + r.weight : ""}${r.note ? " (" + r.note + ")" : ""}`).join("\n");
const fmtSession = s => `  ${s.name}${s.homework ? " [homework]" : ""}${s.notes ? " - " + s.notes : ""}\n${fmtRows(s) || "    (empty)"}`;
const fmtWeek = (w, i) => `${w.label || "Week " + (i + 1)}:\n${(w.sessions || []).map(fmtSession).join("\n")}`;

function logSummary(logs){
  const by = {};
  for (const l of logs || []){ if (!l.ex_name) continue; const k = l.ex_name; const e = by[k] || (by[k] = []); e.push(l); }
  return Object.entries(by).slice(0, 40).map(([name, ls]) => {
    ls.sort((a, b) => String(a.logged_on).localeCompare(String(b.logged_on)));
    const days = {}; for (const l of ls){ const d = String(l.logged_on).slice(0, 10); (days[d] = days[d] || []).push(l); }
    const last = Object.entries(days).slice(-3).map(([d, s]) => `${d}: ${s.map(x => `${x.reps ?? "?"}x${x.weight ?? "bw"}${x.done ? "" : " (missed)"}`).join(", ")}`);
    return `  ${name} -> ${last.join(" | ")}`;
  }).join("\n");
}

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { message: "Method not allowed" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { message: "Sign in again." });
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { code: "ai_not_setup", message: "The AI assistant isn't switched on yet. Add ANTHROPIC_API_KEY to the app's Vercel environment variables." });
  const b = await readJson(req);
  const action = b.action; if (!TOOLS[action]) return send(res, 400, { message: "Unknown action" });

  try {
    // Whose data: mine, or a program another trainer shared with me (checked against program_shares).
    let owner = user.id;
    if (b.ownerId && b.ownerId !== user.id){
      const { data: sh } = await admin.from("program_shares").select("owner_id").eq("owner_id", b.ownerId).eq("program_id", String(b.programId || "")).ilike("shared_email", (user.email || "").toLowerCase()).maybeSingle();
      if (!sh) return send(res, 403, { message: "That program isn't shared with you." });
      owner = b.ownerId;
    }
    const cid = String(b.clientId || "");
    const [cl, exs, prog, logs, meas] = await Promise.all([
      admin.from("clients").select("data").eq("user_id", owner).eq("id", cid).maybeSingle(),
      admin.from("exercises").select("data").eq("user_id", owner),
      b.programId ? admin.from("programs").select("data").eq("user_id", owner).eq("id", String(b.programId)).maybeSingle() : Promise.resolve({ data: null }),
      admin.from("program_logs").select("ex_name,reps,weight,done,logged_on").eq("user_id", owner).eq("client_id", cid).gte("logged_on", new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10)),
      admin.from("measurements").select("taken_on,weight,body_fat").eq("user_id", owner).eq("client_id", cid).order("taken_on", { ascending: false }).limit(3)
    ]);
    if (!cl.data) return send(res, 404, { message: "Client not found." });
    const c = cl.data.data || {}, p = prog.data && prog.data.data;
    if (action !== "create" && !p) return send(res, 404, { message: "Program not found." });
    const lib = (exs.data || []).map(r => r.data).filter(e => e && e.name);
    const age = c.birthYear ? new Date().getFullYear() - Number(c.birthYear) : null;

    const ctx = [
      `CLIENT: ${String(c.name || "").split(/[\s+&]/)[0] || "Client"}${c.sex ? ", " + c.sex : ""}${age ? ", age " + age : ""}`,
      `PROGRAMMING NOTES (injuries, limitations, goals): ${c.programNotes ? c.programNotes : "none given"}`,
      (meas.data || []).length ? `RECENT MEASUREMENTS: ${(meas.data || []).map(m => `${m.taken_on}${m.weight != null ? " " + m.weight : ""}${m.body_fat != null ? " " + m.body_fat + "% bf" : ""}`).join("; ")}` : "",
      (logs.data || []).length ? `RECENT LOGS (date: reps x weight per set):\n${logSummary(logs.data)}` : "RECENT LOGS: none yet",
      `EXERCISE LIBRARY (use these names when they fit):\n${lib.map(e => `  ${e.name}${e.muscle ? " [" + e.muscle + (e.equipment ? ", " + e.equipment : "") + "]" : ""}`).join("\n")}`
    ].filter(Boolean).join("\n\n");

    let task;
    if (action === "create"){
      const br = b.brief || {};
      task = `Draft a new program.\nWeeks: ${Math.min(12, Math.max(1, +br.weeks || 4))}\nIn-studio sessions per week: ${Math.min(6, Math.max(1, +br.daysPerWeek || 2))}\nHomework sessions per week: ${Math.min(4, Math.max(0, +br.homework || 0))}\nGoal: ${br.goal || "general strength and fitness"}\nEquipment: ${br.equipment || "full gym"}\nOther: ${br.notes || "none"}\nProgress sensibly week to week. Week labels like "Week 1".`;
    } else if (action === "critique"){
      task = `Critique this program as a senior coach reviewing a colleague's work. Check balance of movement patterns, volume per muscle, exercise order, progression across weeks, fit with the client's goals and notes, and anything risky.\n\nPROGRAM "${p.name}":\n${(p.weeks || []).map(fmtWeek).join("\n\n")}`;
    } else {
      const wi = Math.max(0, +b.week || 0), w = (p.weeks || [])[wi];
      if (!w) return send(res, 400, { message: "That week doesn't exist." });
      const dir = DIRECTIONS[b.direction] || (b.direction ? String(b.direction).slice(0, 200) : "steady progressive overload");
      const one = b.session != null && w.sessions[+b.session];
      task = `Progress ${one ? "this session" : "this week"} into the next version for this client.\nDirection: ${dir}.${b.notes ? "\nTrainer's notes: " + String(b.notes).slice(0, 600) : ""}\nKeep what is working, change what serves the direction, and base loads on the recent logs.\n\nCURRENT ${one ? "SESSION" : "WEEK"} (${w.label || "Week " + (wi + 1)}):\n${one ? fmtSession(one) : (w.sessions || []).map(fmtSession).join("\n")}\n\nREST OF THE PROGRAM FOR CONTEXT:\n${(p.weeks || []).filter((_, i) => i !== wi).slice(0, 4).map(fmtWeek).join("\n\n")}`;
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: action === "create" ? 16000 : 8000, system: SYSTEM, tools: [TOOLS[action]], tool_choice: { type: "auto" },
        messages: [{ role: "user", content: `${ctx}\n\nTASK:\n${task}\n\nCall ${TOOLS[action].name} with your answer.` }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { code: "ai_error", message: (j.error && j.error.message) || "The AI service didn't answer. Try again." });
    const out = (j.content || []).find(x => x.type === "tool_use");
    if (!out) return send(res, 502, { code: "ai_error", message: "The AI didn't return a usable draft. Try again." });
    return send(res, 200, { action, result: out.input, model: MODEL });
  } catch (e){
    return send(res, 500, { message: "Something went wrong. Try again in a minute." });
  }
}
