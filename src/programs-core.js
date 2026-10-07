/* Programs: pure helpers shared by the trainer app, the client page and the server.
 * Program shape (programs.data):
 *   {name, clientId, status:"active"|"archived", startDate,
 *    weeks:[{id, label, sessions:[{id, name, homework, notes, rows:[{id, exId, name, group, sets, reps, weight, note}]}]}]}
 * A log is one set: {program_id, session_id, row_id, set_no, ex_name, reps, weight, done, logged_on, source}. */

export const pid = (p) => (p || "") + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const clone = o => JSON.parse(JSON.stringify(o));
const n = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };

export const newRow = (ex) => ({ id: pid("r"), exId: ex ? ex.id : null, name: ex ? ex.name : "", group: "", sets: ex && ex.sets ? String(ex.sets) : "", reps: ex && ex.reps ? String(ex.reps) : "", weight: "", note: "" });
export const newSession = (name) => ({ id: pid("s"), name: name || "Day A", homework: false, notes: "", rows: [] });
export const newWeek = (label) => ({ id: pid("w"), label: label || "Week 1", sessions: [newSession("Day A")] });
export function newProgram(clientId, name){
  return { name: name || "Program", clientId, status: "active", startDate: new Date().toISOString().slice(0, 10), weeks: [newWeek("Week 1")] };
}

/* Fresh ids everywhere, so a pasted session or week logs separately from the original. */
export function copySession(s){ const c = clone(s); c.id = pid("s"); c.rows = (c.rows || []).map(r => ({ ...r, id: pid("r") })); return c; }
export function copyWeek(w, label){ const c = clone(w); c.id = pid("w"); c.label = label || c.label; c.sessions = (c.sessions || []).map(copySession); return c; }

/* "Repeat for N weeks": puts a copy of a session into the same slot of the next N weeks, adding weeks as needed. */
export function repeatSession(prog, weekIdx, sessIdx, times){
  const p = clone(prog), src = p.weeks[weekIdx].sessions[sessIdx];
  for (let k = 1; k <= times; k++){
    const wi = weekIdx + k;
    while (p.weeks.length <= wi) p.weeks.push({ id: pid("w"), label: "Week " + (p.weeks.length + 1), sessions: [] });
    const w = p.weeks[wi];
    const copy = copySession(src);
    if (w.sessions.length > sessIdx) w.sessions[sessIdx] = copy; else w.sessions.push(copy);
  }
  return p;
}
/* Same idea for a whole week. */
export function repeatWeek(prog, weekIdx, times){
  const p = clone(prog);
  for (let k = 1; k <= times; k++){
    const wi = weekIdx + k, label = "Week " + (wi + 1);
    const copy = copyWeek(p.weeks[weekIdx], label);
    if (p.weeks.length > wi) p.weeks[wi] = copy; else p.weeks.push(copy);
  }
  return p;
}

export function findSession(prog, sessionId){
  for (const w of (prog.weeks || [])) for (const s of (w.sessions || [])) if (s.id === sessionId) return { week: w, session: s };
  return null;
}
export const setCount = r => { const x = parseInt(String(r.sets || "").match(/\d+/) || "", 10); return isFinite(x) && x > 0 ? Math.min(x, 12) : 1; };
export const rowName = (r, lib) => (r.exId && lib && lib[r.exId] && lib[r.exId].name) || r.name || "";

/* Jackson & Pollock 4-site skinfold (triceps, abdomen, suprailiac, thigh; mm). Returns body fat %, or null. */
export function bodyFat4(m, sex, age){
  const sites = [m.triceps, m.abdomen, m.suprailiac, m.thigh].map(n);
  if (sites.some(x => x == null) || !age || !sex) return null;
  const S = sites.reduce((a, b) => a + b, 0);
  const bf = sex === "female" ? 0.29669 * S - 0.00043 * S * S + 0.02963 * age + 1.4072
                              : 0.29288 * S - 0.0005 * S * S + 0.15845 * age - 5.76377;
  return Math.round(bf * 10) / 10;
}
export function ageOn(birthYear, dateStr){ const y = parseInt(birthYear, 10); if (!y) return null; return new Date(dateStr || Date.now()).getFullYear() - y; }

/* Heaviest set per exercise per day, oldest first: {name: [{date, weight, reps}]}. */
export function liftHistory(logs){
  const by = {};
  for (const l of logs || []){
    const w = n(l.weight); if (w == null || !l.ex_name) continue;
    const key = l.ex_name.trim(); const d = String(l.logged_on).slice(0, 10);
    const list = by[key] || (by[key] = {});
    if (!list[d] || w > list[d].weight) list[d] = { date: d, weight: w, reps: n(l.reps) };
  }
  const out = {};
  for (const k of Object.keys(by)) out[k] = Object.values(by[k]).sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/* Small dependency-free SVG line chart. points: [{date:"YYYY-MM-DD", value, label?}]. One series, one axis. */
export function lineChart(points, { unit = "", height = 150, decimals = 1 } = {}){
  const pts = (points || []).filter(p => p && isFinite(p.value)).sort((a, b) => a.date.localeCompare(b.date));
  if (!pts.length) return `<div class="lc-empty">No entries yet.</div>`;
  const W = 600, H = height, L = 44, R = 12, T = 12, B = 24;
  const xs = pts.map(p => new Date(p.date + "T12:00:00").getTime());
  const x0 = Math.min(...xs), x1 = Math.max(...xs), span = Math.max(1, x1 - x0);
  let lo = Math.min(...pts.map(p => p.value)), hi = Math.max(...pts.map(p => p.value));
  if (hi - lo < 1e-9){ lo -= 1; hi += 1; } const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const X = t => pts.length === 1 ? (L + W - R) / 2 : L + (t - x0) / span * (W - L - R);
  const Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const fmt = v => (Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals)).toLocaleString("en-US");
  const md = d => { const [, m, dd] = d.split("-").map(Number); return m + "/" + dd; };
  const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15];
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="lc-grid"/><text x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" class="lc-ax">${fmt(v)}</text>`).join("");
  const path = pts.map((p, i) => (i ? "L" : "M") + X(xs[i]).toFixed(1) + " " + Y(p.value).toFixed(1)).join(" ");
  const idx = pts.length <= 2 ? pts.map((_, i) => i) : [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  const xl = [...new Set(idx)].map(i => `<text x="${X(xs[i]).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="lc-ax">${md(pts[i].date)}</text>`).join("");
  const dots = pts.map((p, i) => `<g class="lc-pt"><circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="14" class="lc-hit"/><circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="4" class="lc-dot"/><title>${md(p.date)}: ${fmt(p.value)}${unit}${p.label ? " · " + p.label : ""}</title></g>`).join("");
  const last = pts[pts.length - 1];
  const lastLbl = `<text x="${Math.min(W - R, X(xs[xs.length - 1]) + 0).toFixed(1)}" y="${(Y(last.value) - 10).toFixed(1)}" text-anchor="end" class="lc-val">${fmt(last.value)}${unit}</text>`;
  return `<svg class="lc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend, latest ${fmt(last.value)}${unit}">${grid}<path d="${path}" class="lc-line"/>${dots}${lastLbl}${xl}</svg>`;
}
export const LINECHART_CSS = `.lc{display:block;width:100%;height:auto;overflow:visible}.lc-grid{stroke:var(--line);stroke-width:1}.lc-ax{fill:var(--muted);font-size:11px;font-family:inherit}.lc-line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}.lc-dot{fill:var(--accent);stroke:var(--surface);stroke-width:2}.lc-hit{fill:transparent}.lc-pt:hover .lc-dot{r:6}.lc-val{fill:var(--ink);font-size:12px;font-weight:600;font-family:inherit}.lc-empty{color:var(--muted);font-size:13px;padding:18px 0;text-align:center}`;

/* Video for an exercise: YouTube / Vimeo links embed, direct files play, anything else is a link. */
export function videoEmbed(url){
  if (!url) return "";
  const u = String(url).trim(), e = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (m) return `<div class="vid"><iframe src="https://www.youtube-nocookie.com/embed/${e(m[1])}?rel=0&playsinline=1" title="Exercise video" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return `<div class="vid"><iframe src="https://player.vimeo.com/video/${e(m[1])}" title="Exercise video" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  if (/^(https?:|blob:)/.test(u) && (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(u) || /\/storage\/v1\/object\/sign\//.test(u) || u.startsWith("blob:"))) return `<div class="vid"><video src="${e(u)}" controls playsinline preload="metadata"></video></div>`;
  if (/^https?:/.test(u)) return `<a href="${e(u)}" target="_blank" rel="noopener">Watch video</a>`;
  return "";
}
export const VIDEO_CSS = `.vid{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:10px;overflow:hidden}.vid iframe,.vid video{position:absolute;inset:0;width:100%;height:100%;border:0}`;

/* What a client sees on their program page. Shared by /api/program and the demo page.
 * Only exercises used in the client's programs are sent; videoUrls maps a stored video path to a signed URL. */
export function clientProgramView({ client, trainerName, programs, exercises, logs, measurements, videoUrls = {} }){
  const lib = Object.fromEntries((exercises || []).map(e => [e.id, e]));
  const active = (programs || []).filter(p => p.status !== "archived").sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")));
  const used = new Set();
  for (const p of active) for (const w of p.weeks || []) for (const s of w.sessions || []) for (const r of s.rows || []) if (r.exId && lib[r.exId]) used.add(r.exId);
  const ex = {};
  for (const id of used){ const e = lib[id]; ex[id] = { name: e.name, cues: e.cues || "", video: e.videoPath ? (videoUrls[e.videoPath] || "") : (e.videoUrl || "") }; }
  const sex = client.sex, by = client.birthYear;
  const meas = (measurements || []).map(m => ({ date: String(m.taken_on).slice(0, 10), weight: m.weight != null ? Number(m.weight) : null,
    bodyFat: m.body_fat != null ? Number(m.body_fat) : bodyFat4(m, sex, ageOn(by, m.taken_on)), source: m.source })).sort((a, b) => a.date.localeCompare(b.date));
  const strip = p => ({ id: p.id, name: p.name, startDate: p.startDate, weeks: (p.weeks || []).map(w => ({ id: w.id, label: w.label,
    sessions: (w.sessions || []).map(s => ({ id: s.id, name: s.name, homework: !!s.homework, notes: s.notes || "",
      rows: (s.rows || []).filter(r => r.name || r.exId).map(r => ({ id: r.id, exId: r.exId && ex[r.exId] ? r.exId : null, name: (r.exId && ex[r.exId] && ex[r.exId].name) || r.name, group: r.group || "", sets: r.sets || "", reps: r.reps || "", weight: r.weight || "", note: r.note || "" })) })) })) });
  return {
    first: String(client.name || "").trim().split(/[\s+&]/)[0] || "there", trainer: trainerName || "",
    programs: active.map(strip), exercises: ex,
    logs: (logs || []).map(l => ({ p: l.program_id, s: l.session_id, r: l.row_id, n: l.set_no, reps: l.reps != null ? Number(l.reps) : null, weight: l.weight != null ? Number(l.weight) : null, done: !!l.done, date: String(l.logged_on).slice(0, 10), by: l.source, ex: l.ex_name })),
    measurements: meas, updated: new Date().toISOString()
  };
}

/* Program to-dos from the calendar. A program's week N covers startDate + 7N days.
 * For each client with an active program, this week or next with more calendar sessions
 * than planned in-studio workouts is flagged; so is a calendar week past the end of the program.
 * sessionsOf(clientId) -> [{date: Date, future: bool}] (billable sessions). Returns [{key, kind, clientId, progId, week, from, to, n, planned, dates}]. */
export function programTodos({ clients, programs, sessionsOf, now = new Date(), dismissed = [] }){
  const out = [], skip = new Set(dismissed || []);
  const DAY = 86400000;
  const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const monday = d => { const x = sod(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const from = monday(now), to = new Date(monday(now).getTime() + 14 * DAY); // this week and next: sessions coming up

  const planned = w => (w && w.sessions || []).filter(s => !s.homework && (s.rows || []).some(r => r.name || r.exId)).length;
  for (const c of clients || []){
    if (c.active === false) continue;
    const ss = (sessionsOf(c.id) || []).filter(s => s.date >= from && s.date < to);
    const progs = (programs || []).filter(p => p.clientId === c.id && p.status !== "archived" && p.startDate);
    if (!progs.length){
      const soon = ss.filter(s => s.date >= monday(now));
      if (soon.length) out.push({ key: `noprog:${c.id}`, kind: "noprogram", clientId: c.id, n: soon.length, dates: soon.map(s => s.date) });
      continue;
    }
    const p = progs.sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
    const [y, m, d] = p.startDate.split("-").map(Number), start = new Date(y, m - 1, d);
    const byWeek = {};
    for (const s of ss){ if (s.date < start) continue; const i = Math.floor((sod(s.date) - start) / (7 * DAY)); (byWeek[i] = byWeek[i] || []).push(s); }
    for (const [i, list] of Object.entries(byWeek)){
      const wk = +i, w = p.weeks[wk], have = planned(w);
      if (list.length <= have) continue;
      const key = `gap:${p.id}:${wk}:${list.length}`;
      if (skip.has(key)) continue;
      out.push({ key, kind: w ? "short" : "noweek", clientId: c.id, progId: p.id, week: wk, from: new Date(start.getTime() + wk * 7 * DAY), to: new Date(start.getTime() + (wk * 7 + 6) * DAY), n: list.length, planned: have, dates: list.map(s => s.date) });
    }
  }
  return out.filter(t => !skip.has(t.key)).sort((a, b) => (a.from || 0) - (b.from || 0));
}

/* Block colors: A-F get a fixed color (validated for color-blind separation in light and dark); later letters stay neutral.
 * The group letter is always shown too, so color is never the only cue. */
export const grpClass = g => { const L = String(g || "").trim().charAt(0).toUpperCase(); return "ABCDEF".includes(L) && L ? "g-" + L : (L ? "g-x" : ""); };
const GL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"], GD = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];
const gv = arr => "ABCDEF".split("").map((L, i) => `.g-${L}{--g:${arr[i]}}`).join("");
export const GROUP_CSS = `${gv(GL)}.g-x{--g:var(--muted)}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) ${"ABCDEF".split("").map((L, i) => `.g-${L}{--g:${GD[i]}}`).join(":root:not([data-theme=\"light\"]) ")}}
:root[data-theme="dark"] ${"ABCDEF".split("").map((L, i) => `.g-${L}{--g:${GD[i]}}`).join(":root[data-theme=\"dark\"] ")}
.gchip{display:inline-block;min-width:26px;text-align:center;font-weight:700;font-size:11.5px;border-radius:6px;padding:1px 6px;color:var(--ink);background:color-mix(in srgb,var(--g,var(--muted)) 22%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--g,var(--muted)) 55%,transparent)}`;

/* ---------- reordering rows and blocks ----------
 * A block is a run of consecutive rows whose group starts with the same letter (A1, A2, A3).
 * Rows without a group letter are their own one-row segment. */
export const letterOf = g => (String(g || "").trim().match(/^[A-Za-z]/) || [""])[0].toUpperCase();
export function segments(rows){
  const segs = [];
  (rows || []).forEach((r, i) => { const L = letterOf(r.group), last = segs[segs.length - 1];
    if (L && last && last.L === L && last.end === i - 1) last.end = i; else segs.push({ L, start: i, end: i }); });
  return segs;
}
/* Re-letter blocks top to bottom (A, B, C...) and number rows inside multi-row blocks (A1, A2, A3).
 * Rows with no group letter are left alone and don't use up a letter. */
export function relabel(rows){
  let k = 0;
  for (const g of segments(rows)){
    if (!g.L) continue;
    const L = String.fromCharCode(65 + Math.min(k++, 25)), single = g.end === g.start;
    for (let i = g.start; i <= g.end; i++) rows[i].group = single ? L : L + (i - g.start + 1);
  }
  return rows;
}
/* Move one row so it lands before index `to` (0..n, in the original order). Dropped between two rows of the
 * same block, it joins that block. */
export function moveRow(rows, from, to){
  const arr = rows.slice(), [item] = arr.splice(from, 1), t = to > from ? to - 1 : to;
  arr.splice(t, 0, item);
  const La = arr[t - 1] && letterOf(arr[t - 1].group), Lb = arr[t + 1] && letterOf(arr[t + 1].group);
  if (La && La === Lb) item.group = La;
  return relabel(arr);
}
/* Move a whole block so it lands before segment `to`, then re-letter blocks top to bottom (A, B, C...). */
export function moveBlock(rows, from, to){
  const segs = segments(rows), groups = segs.map(s => rows.slice(s.start, s.end + 1));
  const [g] = groups.splice(from, 1), t = to > from ? to - 1 : to;
  groups.splice(t, 0, g);
  return relabel(groups.flat());
}

/* Labels are automatic: every exercise belongs to a block, and blocks read A, B, C top to bottom.
 * A temporary letter that differs from the neighbours marks a new block; relabel() then renames everything. */
const tempLetter = (...avoid) => ["Q", "X", "Y", "Z", "W"].find(L => !avoid.includes(L));
export function normalizeBlocks(rows){
  (rows || []).forEach((r, i) => { if (!letterOf(r.group)) r.group = tempLetter(i ? letterOf(rows[i - 1].group) : "", rows[i + 1] ? letterOf(rows[i + 1].group) : ""); });
  return relabel(rows || []);
}
/* Superset row i (and the rest of its block) with the block above. */
export function linkUp(rows, i){
  if (i <= 0) return rows;
  const L = letterOf(rows[i - 1].group), g = segments(rows).find(x => x.start <= i && i <= x.end);
  for (let k = g.start; k <= g.end; k++) rows[k].group = L;
  return relabel(rows);
}
/* Split a superset so row i and the rows after it in that block become their own block. */
export function splitAt(rows, i){
  const g = segments(rows).find(x => x.start <= i && i <= x.end); if (!g || i === g.start) return rows;
  const T = tempLetter(g.L, rows[g.end + 1] ? letterOf(rows[g.end + 1].group) : "");
  for (let k = i; k <= g.end; k++) rows[k].group = T;
  return relabel(rows);
}
/* Add a row at the end, as a new block or supersetted with the last block. */
export function addToBlocks(rows, row, superset){
  const last = rows[rows.length - 1];
  row.group = superset && last ? letterOf(last.group) : tempLetter(last ? letterOf(last.group) : "");
  rows.push(row);
  return normalizeBlocks(rows);
}

/* ---------- one "sets x reps" field ----------
 * "3x8" -> 3 sets of 8 · "3x8,8,6" -> 3 sets: 8, 8, 6 · "8,8,6" -> 3 sets · "4x8-10" · "3x8 each" · "3x30s" · "10" -> reps only.
 * Stored as sets ("3") and reps ("8" or "8,8,6") so everything else keeps working. */
const stripX = s => String(s || "").replace(/^\s*[x×*]\s*/i, "").trim();
export function parseSetsReps(str){
  const t = String(str || "").trim().replace(/\s+/g, " ");
  if (!t) return { sets: "", reps: "" };
  const m = t.match(/^(\d+)\s*(?:x|×|\*|sets? of)\s*(.*)$/i);
  const sets = m ? m[1] : "", repsPart = stripX(m ? m[2] : t);
  const parts = repsPart.split(/\s*,\s*/).filter(Boolean);
  if (parts.length > 1){
    let n = Math.max(sets ? +sets : 0, parts.length);
    while (parts.length < n) parts.push(parts[parts.length - 1]);
    return { sets: String(n), reps: parts.join(",") };
  }
  return { sets, reps: repsPart };
}
export function fmtSetsReps(r){
  const sets = String((r && r.sets) || "").trim(), reps = stripX(r && r.reps);
  return sets && reps ? `${sets}x${reps}` : reps || (sets ? sets + "x" : "");
}
/* Target reps for set k (0-based), as a number when there is one. */
export function repsFor(r, k){
  const parts = stripX(r && r.reps).split(/\s*,\s*/);
  return parseInt(parts[Math.min(k, parts.length - 1)], 10) || null;
}

/* ---------- workout emails ---------- */
const DAYMS = 86400000;
const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const parseYmd = s => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
/* Which written session a client does on `date`: program week = weeks since the program's start date, and the
 * nth calendar session in that week gets the nth in-studio session (Day A, Day B...). null if nothing is written. */
export function sessionForDate(program, date, sessionDates){
  if (!program || !program.startDate) return null;
  const start = parseYmd(program.startDate), wk = Math.floor((sod(date) - start) / (7 * DAYMS));
  if (wk < 0 || wk >= (program.weeks || []).length) return null;
  const week = program.weeks[wk], list = (week.sessions || []).filter(s => !s.homework && (s.rows || []).some(r => r.name));
  const days = [...new Set((sessionDates || []).filter(d => Math.floor((sod(d) - start) / (7 * DAYMS)) === wk).map(d => sod(d).getTime()))].sort((a, b) => a - b);
  const n = days.indexOf(sod(date).getTime());
  if (n < 0 || n >= list.length) return null;
  return { week, weekIndex: wk, session: list[n] };
}
const EMAIL_G = { A: "#2a78d6", B: "#eb6834", C: "#1baf7a", D: "#eda100", E: "#e87ba4", F: "#008300" };
const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* The email a client gets for one session. when: Date of the session (or null for "send now"). */
export function workoutEmail({ first, trainer, session, weekLabel, when, link }){
  const day = when ? when.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }) : "";
  const time = when ? when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
  const subject = `Your workout${day ? " for " + day.replace(/,.*$/, "") : ""}: ${session.name}`;
  const rows = (session.rows || []).filter(r => r.name);
  const rx = r => [fmtSetsReps(r).replace("x", " × "), r.weight ? "@ " + r.weight : ""].filter(Boolean).join(" ");
  const text = [`Hi ${first},`, "", `Here's your workout${day ? " for " + day + (time ? " at " + time : "") : ""}: ${session.name}${weekLabel ? " (" + weekLabel + ")" : ""}.`, "",
    ...rows.map(r => `${r.group ? r.group + "  " : ""}${r.name}  ${rx(r)}${r.note ? "  (" + r.note + ")" : ""}`),
    ...(session.notes ? ["", session.notes] : []), ...(link ? ["", "Videos, cues and your log: " + link] : []), "", trainer ? "- " + trainer : ""].join("\n").trim();
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d1a14;background:#fffcf6;border:1px solid #e2d9c8;border-radius:14px;padding:24px">
  <p style="margin:0 0 4px;font-size:15px">Hi ${escH(first)},</p>
  <h1 style="font-size:20px;margin:0 0 4px">${escH(session.name)}</h1>
  <p style="margin:0 0 16px;color:#877f6f;font-size:13px">${escH([day && day + (time ? " · " + time : ""), weekLabel].filter(Boolean).join(" · "))}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">${rows.map(r => { const c = EMAIL_G[letterOf(r.group)] || "#877f6f";
    return `<tr><td style="padding:8px 8px 8px 0;border-top:1px solid #eee7da;width:38px;vertical-align:top">${r.group ? `<span style="display:inline-block;min-width:26px;text-align:center;font-weight:700;font-size:12px;border-radius:6px;padding:2px 6px;border:1px solid ${c};color:#1d1a14;background:${c}22">${escH(r.group)}</span>` : ""}</td>
      <td style="padding:8px 0;border-top:1px solid #eee7da;vertical-align:top"><b>${escH(r.name)}</b>${r.note ? `<div style="color:#4f493d;font-size:13px">${escH(r.note)}</div>` : ""}</td>
      <td style="padding:8px 0 8px 8px;border-top:1px solid #eee7da;text-align:right;white-space:nowrap;vertical-align:top">${escH(rx(r))}</td></tr>`; }).join("")}</table>
  ${session.notes ? `<p style="margin:16px 0 0;font-size:14px;color:#4f493d">${escH(session.notes)}</p>` : ""}
  ${link ? `<p style="margin:20px 0 0"><a href="${escH(link)}" style="display:inline-block;background:#1f4c9c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600">Open videos and log your sets</a></p>` : ""}
  <p style="margin:20px 0 0;color:#877f6f;font-size:12px">Sent by ${escH(trainer || "your trainer")}. Reply to this email to reach them.</p></div>`;
  return { subject, text, html };
}

/* ---------- logging a whole exercise on one line ----------
 * What a trainer types after a set, read into [{reps, weight}]:
 *   "8x215 8x215 6x225"   one set per chunk, reps x weight (215x8 works too: the bigger number is the weight)
 *   "8 215, 8 215, 6 225" commas between sets, space inside one
 *   "3x8@215" "3x8 @ 215" "3 sets of 8 at 215"   three identical sets
 *   "3x8"                 three sets of 8 at the planned weight (a lone AxB with a small second number)
 *   "8 8 6" / "8,8,6"     reps only, weight carried from the plan
 *   "8 8 6 @ 215"         reps list at one weight
 *   "bw" / "bodyweight"   no load
 * plan: {sets, reps(k), weight} from the program row, used to fill anything left out. */
export function parseSetLog(str, plan = {}){
  let t = String(str || "").toLowerCase().replace(/×|\*/g, "x").replace(/\b(lbs?|kgs?|kg|lb|reps?)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const pw = n(plan.weight), planReps = k => (plan.reps ? plan.reps(k) : null);
  const bw = /\b(bw|bodyweight|body weight)\b/.test(t); t = t.replace(/\b(bw|bodyweight|body weight)\b/g, " ").trim();
  const fill = (list, w) => list.map((r, k) => ({ reps: r ?? planReps(k), weight: bw ? null : (w ?? pw) }));
  // N sets of R at W
  let m = t.match(/^(\d+)\s*(?:x|sets? of)\s*(\d+(?:\.\d+)?)\s*(?:@|at)\s*(\d+(?:\.\d+)?)$/);
  if (m) return Array.from({ length: Math.min(12, +m[1]) }, () => ({ reps: +m[2], weight: bw ? null : +m[3] }));
  // reps list @ weight: "8 8 6 @ 215", "8,8,6 at 215"
  m = t.match(/^([\d\s,]+?)\s*(?:@|at)\s*(\d+(?:\.\d+)?)$/);
  if (m) return fill(m[1].split(/[\s,]+/).filter(Boolean).map(Number).slice(0, 12), +m[2]);
  // lone "3x8": sets x reps at the planned weight, unless the second number is clearly a weight
  m = t.match(/^(\d+)\s*x\s*(\d+(?:\.\d+)?)$/);
  if (m && +m[1] <= 8 && +m[2] <= 30) return Array.from({ length: +m[1] }, () => ({ reps: +m[2], weight: bw ? null : pw }));
  // set by set
  const chunks = t.includes(",") ? t.split(/\s*,\s*/) : (t.match(/\d+(?:\.\d+)?\s*(?:x|@)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?/g) || []);
  const out = []; let lastW = null;
  for (const ch of chunks.slice(0, 12)){
    const nums = (ch.match(/\d+(?:\.\d+)?/g) || []).map(Number); if (!nums.length) continue;
    let reps, w;
    if (nums.length === 1){ reps = nums[0]; w = lastW; }
    else { const [a, b] = nums, dec = x => !Number.isInteger(x);
      // reps first unless the first number is plainly the load (215x8, 22.5x10)
      if (!/@/.test(ch) && ((a > 30 && b <= 30) || (dec(a) && !dec(b)))){ reps = b; w = a; } else { reps = a; w = b; } }
    if (w != null) lastW = w;
    out.push({ reps, weight: bw ? null : (w ?? pw) });
  }
  return out;
}
/* Back to text, compact: identical sets collapse to "3x8@215". */
export function fmtSetLog(sets){
  const ok = (sets || []).filter(s => s && (s.reps != null || s.weight != null));
  if (!ok.length) return "";
  // Written so parseSetLog reads it back the same: "@" for light loads (5@20 isn't 5 sets of 20), "bw" for no load.
  const load = w => w == null ? "" : (w > 30 ? "x" : "@") + w;
  const bw = ok.every(s => s.weight == null) ? " bw" : "";
  if (ok.length > 2 && ok.every(s => s.reps === ok[0].reps && s.weight === ok[0].weight)) return `${ok.length}x${ok[0].reps ?? "?"}${ok[0].weight != null ? "@" + ok[0].weight : ""}${bw}`;
  return ok.map(s => `${s.reps ?? "?"}${load(s.weight)}`).join(" ") + bw;
}
