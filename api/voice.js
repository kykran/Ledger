// POST /api/voice — voice logging during a live session. Signed-in trainers only.
//   {action:"config"}  -> {serverStt}  whether this server transcribes audio itself (OPENAI_API_KEY set)
//   {action:"parse", audio?, mime?, text?, rows:[...], lastRowId?}
//      audio: base64 recording (transcribed here); text: words the browser already transcribed.
//      rows: the session being recorded, from the app:
//        [{id, name, group, sets, reps, weight, logged:[{set_no, reps, weight, done}]}]
//   -> {transcript, sets:[{row_id, set_no, reps, weight}], note}
// Nothing is saved here. The app shows the parsed sets for the trainer to confirm, then saves them
// the same way a tapped set is saved.
import { send, readJson, userFrom } from "./_lib.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const STT_MODEL = process.env.STT_MODEL || "gpt-4o-mini-transcribe";
const MAX_AUDIO = 3 * 1024 * 1024; // ~3 MB of base64 is minutes of speech; real clips are a few seconds

const SYSTEM = `You turn what a personal trainer says out loud during a session into logged sets.
You get the exercises in today's session (with ids) and what has been logged so far, then one short spoken note.

Rules:
- Match each exercise the trainer mentions to one of the session's rows by meaning, not spelling. Speech-to-text mishears names ("go bet squat" = Goblet Squat, "RDL" = Romanian Deadlift). Only use row ids from the list.
- If no exercise is named ("same again", "another set", "ten at forty"), it refers to the LAST ROW USED.
- reps and weight are plain numbers. "Bodyweight" or no load means weight null. Ignore units and "each side".
- "Three sets of ten at 135" is count 3 with reps 10, weight 135. "Ten, ten, eight at 50" is three entries.
- set_no only when the trainer says which set ("set two", "last set was 6"); otherwise leave it out and the app fills the next open set.
- If something can't be matched confidently, leave it out and say why in note. Never guess an exercise.
Always answer by calling log_sets exactly once.`;

const TOOL = { name: "log_sets", description: "Return the sets to log.", input_schema: { type: "object", properties: {
  entries: { type: "array", items: { type: "object", properties: {
    row_id: { type: "string" },
    set_no: { type: "integer", description: "Only if the trainer named the set number" },
    count: { type: "integer", description: "How many identical sets this entry stands for. Default 1." },
    reps: { type: ["number", "null"] }, weight: { type: ["number", "null"] } }, required: ["row_id"] } },
  note: { type: "string", description: "Short note about anything left out, otherwise empty" } }, required: ["entries"] } };

const str = (v, n) => String(v ?? "").slice(0, n);
const num = v => { if (v === "" || v == null) return null; const x = Number(v); return isFinite(x) && x >= 0 && x < 100000 ? x : null; };

async function transcribe(b64, mime, names){
  const buf = Buffer.from(b64, "base64");
  const ext = /mp4|m4a|aac/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "webm";
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime || "audio/webm" }), "clip." + ext);
  fd.append("model", STT_MODEL);
  fd.append("language", "en");
  // Naming today's exercises up front fixes most mishearings.
  fd.append("prompt", `A personal trainer logging sets in a gym. Exercises today: ${names.join(", ")}. Example: "Goblet squat, ten reps at thirty-five."`.slice(0, 900));
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || "transcription failed"), { stt: true });
  return String(j.text || "").trim();
}

// Give every entry a set number: the one spoken, or the next set on that row that isn't done yet.
export function assignSets(entries, rows){
  const taken = {};
  for (const r of rows){ taken[r.id] = new Set((r.logged || []).filter(l => l.done).map(l => +l.set_no)); }
  const out = [];
  for (const e of entries){
    const row = rows.find(r => r.id === e.row_id); if (!row) continue;
    const n = Math.min(10, Math.max(1, +e.count || 1));
    for (let k = 0; k < n; k++){
      let no = k === 0 && Number.isInteger(e.set_no) && e.set_no >= 1 && e.set_no <= 12 ? e.set_no : null;
      if (no == null){ no = 1; while (taken[row.id].has(no) && no < 12) no++; }
      taken[row.id].add(no);
      out.push({ row_id: row.id, set_no: no, reps: num(e.reps), weight: num(e.weight) });
    }
  }
  return out;
}

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { message: "Method not allowed" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { message: "Sign in again." });
  const b = await readJson(req);
  if (b.action === "config") return send(res, 200, { serverStt: !!process.env.OPENAI_API_KEY, ai: !!process.env.ANTHROPIC_API_KEY });
  if (b.action !== "parse") return send(res, 400, { message: "Unknown action" });
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { code: "ai_not_setup", message: "Voice logging needs the AI assistant. Add ANTHROPIC_API_KEY in Vercel." });

  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 40).map(r => ({ id: str(r.id, 80), name: str(r.name, 120), group: str(r.group, 8),
    sets: str(r.sets, 20), reps: str(r.reps, 40), weight: str(r.weight, 40),
    logged: (Array.isArray(r.logged) ? r.logged : []).slice(0, 12).map(l => ({ set_no: +l.set_no || 0, reps: num(l.reps), weight: num(l.weight), done: !!l.done })) })).filter(r => r.id && r.name);
  if (!rows.length) return send(res, 400, { message: "Add exercises to this session first." });

  try {
    let transcript = str(b.text, 600).trim();
    if (!transcript && b.audio){
      if (!process.env.OPENAI_API_KEY) return send(res, 503, { code: "stt_not_setup", message: "Audio transcription isn't switched on." });
      if (String(b.audio).length > MAX_AUDIO) return send(res, 413, { message: "That recording is too long. Keep it to a sentence or two." });
      transcript = await transcribe(String(b.audio), str(b.mime, 60), rows.map(r => r.name));
    }
    if (!transcript) return send(res, 200, { transcript: "", sets: [], note: "Didn't catch anything. Try again a little closer to the phone." });

    const last = rows.find(r => r.id === b.lastRowId);
    const ctx = `SESSION ROWS:\n${rows.map(r => `  id=${r.id} | ${r.group ? r.group + " " : ""}${r.name} | planned ${r.sets || "?"} x ${r.reps || "?"}${r.weight ? " @ " + r.weight : ""} | logged: ${r.logged.filter(l => l.done).map(l => `set ${l.set_no} ${l.reps ?? "?"}x${l.weight ?? "bw"}`).join(", ") || "none"}`).join("\n")}\nLAST ROW USED: ${last ? `id=${last.id} (${last.name})` : "none yet"}\n\nTRAINER SAID: "${transcript}"`;
    const call = async (tc) => {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: SYSTEM, tools: [TOOL], tool_choice: tc, messages: [{ role: "user", content: ctx }] }) });
      return { r, j: await r.json().catch(() => ({})) };
    };
    let { r, j } = await call({ type: "tool", name: TOOL.name });
    if (!r.ok && /tool_choice|thinking/i.test((j.error && j.error.message) || "")) ({ r, j } = await call({ type: "auto" }));
    if (!r.ok) return send(res, 502, { code: "ai_error", transcript, message: "Couldn't read that one. Try again or tap the sets in." });
    const out = ((j.content || []).find(x => x.type === "tool_use") || {}).input || {};
    const sets = assignSets(Array.isArray(out.entries) ? out.entries : [], rows);
    return send(res, 200, { transcript, sets, note: str(out.note, 300) });
  } catch (e){
    return send(res, e.stt ? 502 : 500, { message: e.stt ? "Couldn't transcribe that. Try again." : "Something went wrong. Try again in a minute." });
  }
}
