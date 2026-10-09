/* Programs: pure helpers shared by the trainer app, the client page and the server.
 * Program shape (programs.data):
 *   {name, clientId, status:"active"|"archived", startDate,
 *    weeks:[{id, label, sessions:[{id, name, day (0=Sun..6, optional), homework, notes, rows:[{id, exId, name, group, sets, reps, weight, note}]}]}]}
 * A log is one set: {program_id, session_id, row_id, set_no, ex_name, reps, weight, done, logged_on, source}. */

export const pid = (p) => (p || "") + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const clone = o => JSON.parse(JSON.stringify(o));
const n = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };

export const newRow = (ex) => ({ id: pid("r"), exId: ex ? ex.id : null, name: ex ? ex.name : "", group: "", sets: ex && ex.sets ? String(ex.sets) : "", reps: ex && ex.reps ? String(ex.reps) : "", weight: "", note: "" });
export const newSession = (name) => ({ id: pid("s"), name: name || "Day A", homework: false, notes: "", rows: [] });
// A new week starts empty: workouts are added on their day from the Plan board.
export const newWeek = (label) => ({ id: pid("w"), label: label || "Week 1", sessions: [] });
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
  const week = program.weeks[wk], written = (week.sessions || []).filter(s => !s.homework && (s.rows || []).some(r => r.name));
  // A workout given a day (0 = Sunday) goes on that weekday. The rest fill the other booked days in order.
  const hasDay = x => x.day !== null && x.day !== undefined && x.day !== "";
  const onDay = written.find(x => hasDay(x) && +x.day === date.getDay());
  if (onDay) return { week, weekIndex: wk, session: onDay };
  const taken = new Set(written.filter(hasDay).map(x => +x.day)), list = written.filter(x => !hasDay(x));
  const days = [...new Set((sessionDates || []).filter(d => Math.floor((sod(d) - start) / (7 * DAYMS)) === wk && !taken.has(d.getDay())).map(d => sod(d).getTime()))].sort((a, b) => a - b);
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
 * Weight first, then reps — the way it's written on a whiteboard. Read into [{reps, weight}]:
 *   "215x5 215x5 225x4"   one set per chunk: 215 lb for 5 reps, ...   (commas work too: "215x5, 215x5")
 *   "30x8"                8 reps at 30
 *   "215x5x3"             3 sets of 5 at 215
 *   "8 8 6"               reps only, at the planned weight
 *   "8 8 6 @ 215"         reps list at one weight
 *   "bw" / "bodyweight"   no load ("12 12 bw")
 *   "3x8@215" / "3 sets of 8 at 215"   also understood
 * plan: {weight, reps(k)} from the program row, used to fill anything left out. */
export function parseSetLog(str, plan = {}){
  let t = String(str || "").toLowerCase().replace(/×|\*/g, "x").replace(/\b(lbs?|kgs?|reps?)\b/g, " ").replace(/\s*x\s*/g, "x").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const pw = n(plan.weight), planReps = k => (plan.reps ? plan.reps(k) : null);
  const bw = /\b(bw|bodyweight|body weight)\b/.test(t); t = t.replace(/\b(bw|bodyweight|body weight)\b/g, " ").trim();
  const W = w => bw ? null : w, N = "(\\d+(?:\\.\\d+)?)";
  let m = t.match(new RegExp(`^(\\d+)x${N}\\s*(?:@|at)\\s*${N}$`)) || t.match(new RegExp(`^(\\d+) sets? of ${N}\\s*(?:@|at)\\s*${N}$`));
  if (m) return Array.from({ length: Math.min(12, +m[1]) }, () => ({ reps: +m[2], weight: W(+m[3]) }));
  m = t.match(new RegExp(`^([\\d\\s,]+?)\\s*(?:@|at)\\s*${N}$`));
  if (m) return m[1].split(/[\s,]+/).filter(Boolean).slice(0, 12).map(Number).map(r => ({ reps: r, weight: W(+m[2]) }));
  const out = [];
  for (const ch of (t.match(/[\d.]+(?:x[\d.]+){0,2}/g) || [])){
    const [a, b, c] = ch.split("x").map(Number);
    if (!isFinite(a)) continue;
    if (b == null) out.push({ reps: a, weight: W(out.length ? out[out.length - 1].weight : pw) }); // bare number = reps
    else for (let k = 0; k < Math.min(12, c || 1); k++) out.push({ reps: b, weight: W(a) });     // weight x reps (x sets)
    if (out.length >= 12) break;
  }
  return out.slice(0, 12).map((x, k) => ({ reps: x.reps ?? planReps(k), weight: x.weight }));
}
/* Back to text the same way: "215x5 215x5 225x4", identical sets as "215x5x3". */
export function fmtSetLog(sets){
  const ok = (sets || []).filter(s => s && (s.reps != null || s.weight != null));
  if (!ok.length) return "";
  if (ok.every(s => s.weight == null)) return ok.map(s => s.reps ?? "?").join(" ") + " bw";
  const one = s => s.weight == null ? `${s.reps ?? "?"} bw` : `${s.weight}x${s.reps ?? "?"}`;
  if (ok.length > 2 && ok.every(s => s.reps === ok[0].reps && s.weight === ok[0].weight)) return `${one(ok[0])}x${ok.length}`;
  return ok.map(one).join(" ");
}

/* ---------- importing a TrueCoach workout log (.txt from TrueCoach's per-client "Export") ----------
 * The file is a list of dated workouts separated by "-----":
 *   Thursday June 15, 2023 / Title: Workout 2 / Status: completed / Warmup: ...
 *   A1) Goblet Squat: 3x10          <- block, exercise, prescription (+ sometimes a note on the same line)
 *      53x8                          <- logged results start indented, then one per line: weight x reps
 *   44x10
 *   (blank line) coaching note       <- text after a blank line belongs to the exercise above
 * Results are read as weight x reps ("53x8", "50lb dbx10", "53x10x4" = 4 sets), a lone number by context,
 * and anything else ("7:43.61", "red band x10", "127m") is kept as a note on that exercise. */
const TC_DAY = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/;
const TC_ROW = /^([A-Za-z][0-9]{0,2})\)\s+(.+?)\s*:\s*(.*)$/;
const ymdOf = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
function tcPrescription(raw){
  const t = String(raw || "").trim();
  const m = t.match(/^(\d+\s*[xX×]\s*(?:[\d.,:\-]+[a-z]{0,3}|amrap|as many reps as possible|as long as possible)(?:\s*(?:min|mins|sec|secs|s|m|cals?|lengths?|rounds?)\b)?(?:\s*(?:per side|per leg|per arm|each side|each leg|each|alternating|heavy))?)\s*[-–,.]?\s*(.*)$/i);
  if (m) return { ...parseSetsReps(m[1].replace(/\s+/g, " ")), note: m[2] || "" };
  if (/^[\d\s,]+$/.test(t) && t.includes(",")) return { ...parseSetsReps(t), note: "" };   // "300, 250, 200, 150"
  return t.length <= 24 ? { sets: "", reps: t, note: "" } : { sets: "", reps: "", note: t };
}
/* One result line -> [{weight, reps}] or {text}. plannedReps helps read a lone number. */
function tcResult(line, plannedReps){
  const t = String(line || "").trim(); if (!t) return null;
  const two = t.match(/^(\d+(?:\.\d+)?)x(\d{1,2})\1x(\d{1,2})$/i); // "44x1044x10": two sets typed without a line break
  if (two) return { sets: [{ weight: +two[1], reps: +two[2] }, { weight: +two[1], reps: +two[3] }] };
  let m = t.match(/^(\d+(?:\.\d+)?)\s*(?:lbs?|kgs?)?\s*(?:[a-z]+\s*)?x\s*(\d+)(?:\s*x\s*(\d+))?\b(.*)$/i);
  if (m && !/^\s*(?:m|s|sec|min|cal)/i.test(m[4] || "")){
    const n = Math.min(12, +m[3] || 1), rest = (m[4] || "").trim(), a = +m[1], b = +m[2];
    // "10x4" on a 3x10 bodyweight move = 10 reps for 4 sets, not 10 lb for 4 reps
    if (!m[3] && plannedReps && Number.isInteger(a) && Math.abs(a - plannedReps) <= 2 && b <= 6 && b !== plannedReps && !/lb|kg/i.test(t))
      return { sets: Array.from({ length: b }, () => ({ weight: null, reps: a })), text: rest ? t : "" };
    return { sets: Array.from({ length: n }, () => ({ weight: a, reps: b })), text: rest ? t : "" };
  }
  if (/^bw(\s*x\s*\d+)?$/i.test(t)){ const r = t.match(/x\s*(\d+)/i); return { sets: [{ weight: null, reps: r ? +r[1] : plannedReps }] }; }
  const ps = t.match(/^(\d+)\s*(?:reps?\s*)?(?:per side|each side|each|per leg|per arm)$/i);
  if (ps) return { sets: [{ weight: null, reps: +ps[1] }] };
  if (/^\d+(\.\d+)?$/.test(t)){
    const v = +t, p = plannedReps || 12;
    if (!Number.isInteger(v) || p > 30) return { text: t }; // a time ("48.3") or a distance target: keep as a note
    return { sets: [v <= Math.max(20, p * 1.6) && Number.isInteger(v) ? { weight: null, reps: v } : { weight: v, reps: plannedReps || null }] };
  }
  return { text: t };
}
export function parseTrueCoach(text){
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const head = (lines.find(l => /^Workout Log:/.test(l)) || "").replace(/^Workout Log:\s*/, "").trim();
  const workouts = []; let w = null, row = null, mode = "head", sawBlank = false;
  const finish = () => { if (w) workouts.push(w); w = null; row = null; };
  for (const raw of lines){
    const line = raw.replace(/\s+$/, "");
    if (/^-{5,}$/.test(line.trim())){ finish(); continue; }
    if (/^This workout log was generated by TrueCoach/i.test(line)) continue;
    const d = line.match(TC_DAY);
    if (d){ finish(); const dt = new Date(`${d[2]} ${+d[3]}, ${d[4]}`); if (isNaN(dt)) continue;
      w = { date: ymdOf(dt), title: "", status: "", notes: [], rows: [] }; mode = "head"; sawBlank = false; continue; }
    if (!w) continue;
    if (!line.trim()){ sawBlank = true; if (mode === "result") mode = "after"; continue; }
    if (mode === "head" && /^Title:/.test(line)){ w.title = line.replace(/^Title:\s*/, "").trim(); continue; }
    if (mode === "head" && /^Status:/.test(line)){ w.status = line.replace(/^Status:\s*/, "").trim().toLowerCase(); continue; }
    const r = line.match(TC_ROW);
    if (r){
      const pr = tcPrescription(r[3]);
      row = { group: r[1].toUpperCase(), name: r[2].replace(/\s+/g, " ").replace(/[,\s]+$/, "").trim(), sets: pr.sets, reps: pr.reps, notes: pr.note ? [pr.note] : [], results: [], text: [] };
      w.rows.push(row); mode = "row"; sawBlank = false; continue;
    }
    if (!row){ w.notes.push(line.replace(/^Warmup:\s*/, "Warm-up: ").trim()); continue; }
    if (mode === "row" && /^ {2,}\S/.test(raw) && !sawBlank) mode = "result";
    if (mode === "result"){
      const res = tcResult(line, parseInt(String(row.reps).split(",")[0], 10) || null);
      if (res && res.sets) row.results.push(...res.sets);
      if (res && res.text) row.text.push(res.text);
      continue;
    }
    row.notes.push(line.trim()); // coaching note or the parts of a complex
  }
  finish();
  // A missing "x": "7512" next to 75x12, or "268" (= 26x8) among 25-30 lb sets on a set of 8.
  for (const w of workouts) for (const r of w.rows){
    const planned = parseInt(String(r.reps).split(",")[0], 10) || null;
    const others = r.results.filter(x => x.weight != null && x.reps != null && x.weight < 300).map(x => x.weight).sort((a, b) => a - b);
    const med = others.length ? others[others.length >> 1] : null;
    r.results = r.results.map(x => {
      if (x.weight == null || !Number.isInteger(x.weight) || x.weight < 100 || (med != null && x.weight < med * 2 && x.weight < 300)) return x;
      const sx = String(x.weight);
      for (const k of [1, 2]){
        const W = +sx.slice(0, -k), R = +sx.slice(-k);
        if (!W || !R || R > 30) continue;
        const fitsW = med != null ? W >= med * 0.5 && W <= med * 1.5 : true, fitsR = planned ? Math.abs(R - planned) <= 4 : R <= 15;
        if (fitsW && fitsR && (med != null || others.some(o => sx.startsWith(String(o))))) return { weight: W, reps: R };
      }
      return x;
    });
  }
  workouts.sort((a, b) => a.date.localeCompare(b.date));
  return { client: head, workouts };
}
/* Turn a parsed log into a Trainer Tally program (weeks Monday-Sunday from the first workout) plus set logs.
 * libByName: {lowercase name: exercise} so rows link to the trainer's existing exercises (and their videos). */
export function truecoachToProgram(parsed, { clientId, name, libByName = {} }){
  const ws = parsed.workouts || []; if (!ws.length) return null;
  const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const first = parse(ws[0].date), start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - ((first.getDay() + 6) % 7));
  const nWeeks = Math.floor((parse(ws[ws.length - 1].date) - start) / (7 * DAYMS)) + 1;
  const label = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " '" + String(d.getFullYear()).slice(2);
  const weeks = Array.from({ length: nWeeks }, (_, i) => ({ id: pid("w"), label: label(new Date(start.getTime() + i * 7 * DAYMS + 3600000)), sessions: [] }));
  const program = { name: name || "TrueCoach history", clientId, status: "archived", startDate: ymdOf(start), imported: "truecoach", weeks };
  const logs = [], key = n => n.toLowerCase().replace(/\s+/g, " ").trim(), count = {};
  for (const w of ws) for (const r of w.rows){ const k = key(r.name); (count[k] = count[k] || {})[r.name] = (count[k][r.name] || 0) + 1; }
  const canon = Object.fromEntries(Object.entries(count).map(([k, v]) => [k, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]));
  for (const w of ws){
    const dt = parse(w.date), wi = Math.round((dt - start) / DAYMS) >> 0, week = weeks[Math.floor(wi / 7)];
    const s = { id: pid("s"), name: w.title || "Workout", day: dt.getDay(), homework: false, notes: w.notes.join("\n"), rows: [] };
    for (const r of w.rows){
      const nm = canon[key(r.name)] || r.name, ex = libByName[nm.toLowerCase()];
      const note = [...r.notes, ...(r.text.length ? ["Logged: " + r.text.join(", ")] : [])].join(" · ");
      const row = { id: pid("r"), exId: ex ? ex.id : null, name: ex ? ex.name : nm, group: r.group, sets: r.sets, reps: r.reps, weight: "", note };
      s.rows.push(row);
      r.results.forEach((x, k) => logs.push({ program_id: null, session_id: s.id, row_id: row.id, set_no: k + 1, client_id: clientId, ex_name: row.name, reps: x.reps ?? null, weight: x.weight ?? null, done: true, logged_on: w.date }));
    }
    week.sessions.push(s);
  }
  return { program, logs, stats: { workouts: ws.length, from: ws[0].date, to: ws[ws.length - 1].date, sets: logs.length,
    logged: ws.filter(w => w.rows.some(r => r.results.length || r.text.length)).length, exercises: Object.keys(canon).length, weeks: nWeeks } };
}

/* ---------- progress between sessions ----------
 * Top set of a day = heaviest weight, most reps at that weight (bodyweight work: most reps). */
export function topSet(logs){
  let best = null;
  for (const l of logs || []){
    if (!l.done && l.reps == null && l.weight == null) continue;
    const w = n(l.weight), r = n(l.reps);
    if (!best || (w ?? -1) > (best.weight ?? -1) || ((w ?? -1) === (best.weight ?? -1) && (r ?? 0) > (best.reps ?? 0))) best = { weight: w, reps: r };
  }
  return best;
}
/* This time vs last time for one exercise: {dw, dr, text, dir: "up"|"down"|"same"} or null. */
export function liftDelta(cur, prev){
  if (!cur || !prev) return null;
  const dw = cur.weight != null && prev.weight != null ? Math.round((cur.weight - prev.weight) * 10) / 10 : 0;
  const dr = cur.reps != null && prev.reps != null ? cur.reps - prev.reps : 0;
  const part = (v, u) => (v > 0 ? "+" : "−") + Math.abs(v) + u;
  const bits = []; if (dw) bits.push(part(dw, " lb")); if (dr) bits.push(part(dr, dr === 1 || dr === -1 ? " rep" : " reps"));
  const dir = dw > 0 || (dw === 0 && dr > 0) ? "up" : dw < 0 || (dw === 0 && dr < 0) ? "down" : "same";
  return { dw, dr, dir, text: bits.length ? bits.join(" · ") : "same as last time" };
}
/* The big three, matched by name. Dumbbell, incline, Romanian, sumo etc. don't count. */
export const STANDARD_LIFTS = [
  { key: "bench", label: "Bench press", test: n => /bench press/.test(n) && !/\b(db|dumbbell|incline|decline|kb|close|floor|single|sa)\b/.test(n) },
  { key: "squat", label: "Back squat", test: n => /back squat/.test(n) && !/\b(db|dumbbell|kb|goblet|box|pause|single|split)\b/.test(n) },
  { key: "dead", label: "Deadlift", test: n => /dead\s?lift/.test(n) && !/\b(romanian|rdl|sumo|kb|kettlebell|db|dumbbell|single|sl|trap|hex|stiff|deficit|defecit|depth|glute)\b/.test(n) }
];
/* Per standard lift: [{date, weight, reps}] heaviest set per day, across every name that matches. */
export function standardLiftHistory(logs){
  const out = {};
  for (const L of STANDARD_LIFTS){
    const days = {};
    for (const l of logs || []){
      const w = n(l.weight); if (w == null || !l.ex_name || !L.test(l.ex_name.toLowerCase())) continue;
      const d = String(l.logged_on).slice(0, 10);
      if (!days[d] || w > days[d].weight || (w === days[d].weight && (n(l.reps) || 0) > (days[d].reps || 0))) days[d] = { date: d, weight: w, reps: n(l.reps), name: l.ex_name };
    }
    out[L.key] = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

/* ---------- pre-session brief ----------
 * What to know walking into a session: for each exercise, what they did last time and what to do today,
 * plus a few flags (notes, a long gap, skipped homework, the package). Pure: the caller passes logs and billing stats.
 * Going up needs every set to hit its reps. With a rep range ("8-10") reps climb first, then weight once every set
 * reaches the top. Weight steps: +5 lb, +10 at 200+. Bodyweight: add a rep. A heavier last set: match it on all sets.
 * Stuck (missed reps and no better top set across the last 3 times): drop 5 lb or swap the exercise.
 * Returns {lines:[{rowId, name, last, lastDate, say, dir:"up"|"reps"|"hold"|"new"|"plan", weight?, stuck}], flags:[{text, tone, note?}]}.
 * `weight` is the suggested load when it differs from the plan, so "Use these numbers" can write it in. */
const fmtW = w => String(Math.round(w * 10) / 10);
const repRange = r => { const m = String((r && r.reps) || "").match(/(\d+)\s*[-–]\s*(\d+)/); return m ? [+m[1], +m[2]] : null; };
export function sessionBrief({ session, logs = [], notes = "", billing = null, before = new Date() }){
  const cut = ymdOf(before), lines = [], flags = [];
  const byEx = {};
  for (const l of logs){
    if (!l.ex_name || (!l.done && l.reps == null && l.weight == null)) continue;
    const d = String(l.logged_on).slice(0, 10); if (d >= cut) continue;
    const k = l.ex_name.trim().toLowerCase(); ((byEx[k] = byEx[k] || {})[d] = byEx[k][d] || []).push(l);
  }
  for (const r of (session && session.rows) || []){
    if (!r.name) continue;
    const days = byEx[r.name.trim().toLowerCase()] || {}, dates = Object.keys(days).sort(), lastDate = dates[dates.length - 1];
    if (!lastDate){ lines.push({ rowId: r.id, name: r.name, last: "", lastDate: "", say: "First time", dir: "new", stuck: false }); continue; }
    const sets = days[lastDate].sort((a, b) => a.set_no - b.set_no).map(l => ({ reps: n(l.reps), weight: n(l.weight) }));
    const last = fmtSetLog(sets), top = topSet(sets), pw = n(r.weight), range = repRange(r);
    const goal = k => range ? range[0] : repsFor(r, k);
    const full = sets.length >= setCount(r), hitAll = full && sets.every((s, k) => s.reps != null && (goal(k) == null || s.reps >= goal(k)));
    const hitTop = range ? full && sets.every(s => s.reps != null && s.reps >= range[1]) : hitAll;
    let say, dir, weight = null;
    if (top.weight != null && pw != null && pw > top.weight){ say = `Plan says ${fmtW(pw)}`; dir = "plan"; }
    else if (top.weight != null){
      const across = sets.every(s => s.weight === top.weight);
      if (hitTop && !across){ weight = top.weight; say = `${fmtW(weight)} for all sets`; dir = "up"; }
      else if (hitTop){ weight = top.weight + (top.weight >= 200 ? 10 : 5); say = `Try ${fmtW(weight)}`; dir = "up"; }
      else if (range && hitAll){ weight = top.weight; say = `${fmtW(weight)}, aim for ${range[1]} reps`; dir = "reps"; }
      else { weight = top.weight; say = `Stay at ${fmtW(weight)}, missed reps`; dir = "hold"; }
    } else { say = hitAll ? "Add a rep" : "Same again, missed reps"; dir = hitAll ? "reps" : "hold"; }
    // Stuck: not ready to go up, and the last 3 times the top set never beat the first of them.
    const tops = dates.slice(-3).map(d => topSet(days[d]));
    const stuck = (dir === "hold" || (dir === "reps" && range)) && tops.length === 3 && tops.slice(1).every(t => (t.weight ?? -1) < (tops[0].weight ?? -1) || ((t.weight ?? -1) === (tops[0].weight ?? -1) && (t.reps ?? 0) <= (tops[0].reps ?? 0)));
    if (stuck && dir === "hold" && top.weight != null && top.weight > 5){ weight = top.weight - 5; say = `Try ${fmtW(weight)} or swap it`; }
    if (weight != null && pw != null && weight === pw) weight = null;
    lines.push({ rowId: r.id, name: r.name, last, lastDate, say, dir, weight, stuck });
  }
  const note = String(notes || "").trim();
  if (note) flags.push({ text: note.length > 140 ? note.slice(0, 140) + "…" : note, tone: "warn", note: true });
  const allDays = logs.map(l => String(l.logged_on).slice(0, 10)).filter(d => d < cut).sort(), lastSeen = allDays.pop();
  if (lastSeen){ const gap = Math.round((parseYmd(cut) - parseYmd(lastSeen)) / DAYMS); if (gap >= 10) flags.push({ text: `First session in ${gap} days. Ease back in.`, tone: "warn" }); }
  // Homework: only for clients who log it themselves, when nothing came in over the last week.
  const hw = logs.filter(l => l.source === "client").map(l => String(l.logged_on).slice(0, 10)).filter(d => d < cut).sort().pop();
  if (hw){ const since = Math.round((parseYmd(cut) - parseYmd(hw)) / DAYMS); if (since > 7) flags.push({ text: `No homework logged in ${since} days`, tone: "info" }); }
  if (billing && billing.bill === "package"){
    const left = billing.remaining;
    if (billing.status === "owes") flags.push({ text: "Package not marked paid", tone: "warn" });
    else if (left != null && left <= 0) flags.push({ text: left < 0 ? `${-left} session${left === -1 ? "" : "s"} past the package. Renewal due` : "Last package used up. Renewal due", tone: "warn" });
    else if (billing.status === "low") flags.push({ text: `${left} session${left === 1 ? "" : "s"} left in the package`, tone: "info" });
  } else if (billing && billing.status === "owes") flags.push({ text: billing.label || "Owes money", tone: "warn" });
  return { lines, flags };
}
