/* Programs: pure helpers shared by the trainer app, the client page and the server.
 * Program shape (programs.data):
 *   {name, clientId, status:"active"|"archived", startDate,
 *    weeks:[{id, label, sessions:[{id, name, homework, notes, rows:[{id, exId, name, group, sets, reps, weight, note}]}]}]}
 * A log is one set: {program_id, session_id, row_id, set_no, ex_name, reps, weight, done, logged_on, source}. */

export const pid = (p) => (p || "") + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const clone = o => JSON.parse(JSON.stringify(o));
const n = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };

export const newRow = (ex) => ({ id: pid("r"), exId: ex ? ex.id : null, name: ex ? ex.name : "", group: "", sets: ex && ex.sets ? String(ex.sets) : "", reps: ex && ex.reps ? String(ex.reps) : "", weight: "", note: "" });
export const newSession = (name) => ({ id: pid("s"), name: name || "Day A", homework: false, notes: "", rows: [newRow(), newRow(), newRow()] });
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
