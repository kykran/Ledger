/* Sample programs data for the public demo (and the demo client page). In memory only. */
import { STARTER_EXERCISES } from "./exercise-seed.js";

const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function buildProgramsDemo(){
  const exercises = STARTER_EXERCISES.map(e => ({ id: "ex-" + slug(e.name), ...e }));
  const ex = Object.fromEntries(exercises.map(e => [e.name, e]));
  const start = addDays(new Date(), -21);
  const row = (name, sets, reps, weight, group, note) => ({ id: "r-" + slug(name) + "-" + (group || "x") + Math.random().toString(36).slice(2, 5), exId: ex[name] ? ex[name].id : null, name, group: group || "", sets: String(sets), reps: String(reps), weight: weight || "", note: note || "" });
  const weekOf = (i) => ({ id: "w" + i, label: "Week " + (i + 1), sessions: [
    { id: `w${i}-a`, name: "Day A · Lower", homework: false, notes: "", rows: [
      row("Trap Bar Deadlift", 4, 5, String(185 + i * 10), "A"), row("Bulgarian Split Squat", 3, "8 each", "30", "B1"), row("Hamstring Curl", 3, 10, "70", "B2"), row("Dead Bug", 3, "8 each", "", "C") ] },
    { id: `w${i}-b`, name: "Day B · Upper", homework: false, notes: "", rows: [
      row("Dumbbell Bench Press", 4, 8, String(45 + i * 5), "A"), row("Chest-Supported Row", 3, 10, "40", "B1"), row("Half-Kneeling Dumbbell Press", 3, "8 each", "25", "B2"), row("Face Pull", 3, 15, "", "C") ] },
    { id: `w${i}-h`, name: "Homework · On your own", homework: true, notes: "Any day between sessions. 30 minutes.", rows: [
      row("Goblet Squat", 3, 10, "35", "A1"), row("Push-Up", 3, 10, "", "A2"), row("Single-Leg RDL", 3, "8 each", "25", "B1"), row("Side Plank", 3, "30s each", "", "B2") ] }
  ]});
  const program = { id: "prog-maya", clientId: "maya", name: "Fall strength block", status: "active", startDate: iso(start), weeks: [0, 1, 2, 3].map(weekOf) };
  const logs = [];
  for (let i = 0; i < 3; i++) for (const s of program.weeks[i].sessions){
    const day = iso(addDays(start, i * 7 + (s.id.endsWith("a") ? 0 : s.id.endsWith("b") ? 2 : 4)));
    for (const r of s.rows){
      const n = parseInt(r.sets, 10) || 1;
      for (let k = 1; k <= n; k++) logs.push({ program_id: program.id, session_id: s.id, row_id: r.id, set_no: k, client_id: "maya", ex_name: r.name,
        reps: r.name === "Hamstring Curl" ? 11 - k : parseInt(r.reps, 10) || null, weight: r.weight ? Number(r.weight) + (k === n && r.name !== "Hamstring Curl" ? 5 : 0) : null, done: true, logged_on: day, source: s.homework ? "client" : "trainer" });
    }
  }
  const sites = [[14, 22, 17, 24, 141.2], [13, 21, 16, 23, 140.4], [13, 20, 15, 22, 139.6], [12, 19, 15, 21, 138.8]];
  const measurements = sites.map(([t, a, s, th, w], i) => ({ id: "m" + i, client_id: "maya", taken_on: iso(addDays(new Date(), -84 + i * 28)), weight: w, triceps: t, abdomen: a, suprailiac: s, thigh: th, body_fat: null, source: "trainer" }));
  measurements.push({ id: "m-c", client_id: "maya", taken_on: iso(addDays(new Date(), -3)), weight: 138.2, source: "client" });
  return { exercises, programs: [program], logs, measurements, profile: { maya: { sex: "female", birthYear: new Date().getFullYear() - 34 } } };
}

/* The Trainer Tally `programs` adapter contract, in memory. */
export function demoProgramsAdapter(){
  const P = buildProgramsDemo();
  const c = o => JSON.parse(JSON.stringify(o));
  const key = r => [r.program_id, r.session_id, r.row_id, r.set_no].join("|");
  return {
    async ready(){ return { ok: true }; },
    async listExercises(){ return c(P.exercises); },
    async saveExercises(list){ for (const e of list){ const i = P.exercises.findIndex(x => x.id === e.id); if (i >= 0) P.exercises[i] = c(e); else P.exercises.push(c(e)); } },
    async deleteExercise(id){ P.exercises = P.exercises.filter(e => e.id !== id); },
    async uploadVideo(file){ return { path: "demo/" + file.name, localUrl: URL.createObjectURL(file) }; },
    async videoUrl(path){ return null; },
    async deleteVideo(){},
    async listPrograms(){ return c(P.programs); },
    async saveProgram(p){ const i = P.programs.findIndex(x => x.id === p.id); if (i >= 0) P.programs[i] = c(p); else P.programs.push(c(p)); },
    async deleteProgram(id){ P.programs = P.programs.filter(p => p.id !== id); P.logs = P.logs.filter(l => l.program_id !== id); },
    async emailWorkout(){ await new Promise(r => setTimeout(r, 200)); return { status: "sent", mailReady: true }; },
    async logs(clientId){ return c(P.logs.filter(l => l.client_id === clientId)); },
    // Demo stand-in for voice logging: the browser's speech recognition hears it, a simple matcher reads it.
    async voice(b){
      if (b.action === "config") return { serverStt: false };
      await new Promise(r => setTimeout(r, 300));
      const t = String(b.text || "").toLowerCase(), rows = b.rows || [];
      const words = w => w.toLowerCase().split(/[^a-z]+/).filter(x => x.length > 2);
      const score = r => words(r.name).filter(w => t.includes(w)).length;
      const best = rows.map(r => [r, score(r)]).sort((a, b) => b[1] - a[1])[0];
      const row = best && best[1] ? best[0] : rows.find(r => r.id === b.lastRowId);
      const n = (t.match(/\d+(\.\d+)?/g) || []).map(Number);
      if (!row || !n.length) return { transcript: b.text || "", sets: [], note: "Say the exercise, then reps and weight." };
      const done = new Set((row.logged || []).filter(l => l.done).map(l => l.set_no)); let no = 1; while (done.has(no)) no++;
      return { transcript: b.text, sets: [{ row_id: row.id, set_no: no, reps: n[0], weight: n[1] ?? null }], note: "" };
    },
    // Demo stand-in for the AI assistant: canned but shaped exactly like the real /api/ai results.
    async ai(b){
      await new Promise(r => setTimeout(r, 400));
      const prog = P.programs.find(p => p.id === b.programId);
      const bump = r => ({ ...r, weight: /^\d+$/.test(r.weight || "") ? String(+r.weight + 5) : r.weight || "RPE 7", note: "Demo suggestion" });
      if (b.action === "critique") return { result: { summary: "Demo critique: solid split between lower and upper days with sensible supersets. Pulling volume is a little light compared with pushing.",
        strengths: ["Big lifts come first while fresh", "Homework is short and doable alone"], suggestions: [{ title: "Add a second pull", detail: "Add a row or pulldown on Day A to balance the presses.", priority: "medium", where: "Day A" }, { title: "Progress the deadlift", detail: "Climb by 5-10 lb a week while bar speed holds.", priority: "low" }],
        flags: [{ exercise: "Trap Bar Deadlift", concern: "Demo flag: watch the low back if notes mention back pain.", alternative: "Hip Thrust" }] } };
      if (b.action === "progress"){
        const w = prog.weeks[b.week], ss = b.session != null ? [w.sessions[b.session]] : w.sessions;
        return { result: { summary: `Demo: progressed toward ${b.direction || "your notes"}.`, changes: ["Loads up about 5 lb where logs allowed", "Swapped one exercise for a new single-leg option"],
          sessions: ss.map(s => ({ name: s.name, homework: s.homework, notes: s.notes, rows: [...s.rows.slice(0, -1).map(bump), { group: "C", name: "Copenhagen Plank", sets: "2", reps: "20s each", weight: "", note: "New for adductor strength", isNew: true, muscle: "Core", equipment: "Bench" }] })),
          flags: [] } };
      }
      const base = P.programs[0].weeks.slice(0, Math.min(4, +((b.brief || {}).weeks) || 4));
      return { result: { name: "Demo program", summary: "Demo draft: two full-body days and one homework session, building load each week.", flags: [],
        weeks: base.map(w => ({ label: w.label, sessions: w.sessions.map(s => ({ name: s.name, homework: s.homework, notes: s.notes, rows: s.rows.map(r => ({ group: r.group, name: r.name, sets: r.sets, reps: r.reps, weight: r.weight, note: "" })) })) })) } };
    },
    async programLogs(ownerId, programId){ return c(P.logs.filter(l => l.program_id === programId)); },
    async logDates(){ return P.logs.map(l => ({ client_id: l.client_id, logged_on: l.logged_on })); },
    sharing: {
      shares: {},
      async ready(){ return true; },
      async list(pid){ return (this.shares[pid] || []).map(e => ({ shared_email: e })); },
      async add(p, email){ (this.shares[p.id] = this.shares[p.id] || []).push(email.trim().toLowerCase()); },
      async remove(pid, email){ this.shares[pid] = (this.shares[pid] || []).filter(e => e !== email); },
      async withMe(){ return { programs: [], exercises: [] }; },
      async leave(){}
    },
    async saveLogs(rows){ for (const r of rows){ const i = P.logs.findIndex(l => key(l) === key(r)); const row = { ...c(r), source: "trainer" }; if (i >= 0) P.logs[i] = row; else P.logs.push(row); } },
    async measurements(clientId){ return c(P.measurements.filter(m => m.client_id === clientId)); },
    async saveMeasurement(m){ const row = c(m); if (!row.id) row.id = "m" + Date.now(); const i = P.measurements.findIndex(x => x.id === row.id); if (i >= 0) P.measurements[i] = row; else P.measurements.push(row); },
    async deleteMeasurement(id){ P.measurements = P.measurements.filter(m => m.id !== id); },
    link: {
      async get(id){ return { token: "demo", url: "/program.html?demo=" + encodeURIComponent(id) }; },
      async create(id){ return { token: "demo", url: "/program.html?demo=" + encodeURIComponent(id) }; },
      async revoke(){}
    }
  };
}
