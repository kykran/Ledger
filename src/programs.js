/* Trainer Tally · Programs (trainer side).
 * Exercise library, per-client programs (weeks > sessions > rows), set logging, measurements and progress charts.
 * app.js calls attach(ctx) once and then render()/onClick()/onChange()/onInput() while the Programs tab is open.
 * Data goes through ctx.A.programs (see adapter-hosted.js / programs-demo.js). */
import { pid, newRow, newSession, newWeek, newProgram, copySession, copyWeek, repeatSession, repeatWeek, setCount,
  bodyFat4, ageOn, liftHistory, lineChart, LINECHART_CSS, videoEmbed, VIDEO_CSS, programTodos } from "./programs-core.js";
import { STARTER_EXERCISES } from "./exercise-seed.js";

let C = null; // context from app.js
const PG = { ready: null, loading: false, view: "clients", clientId: null, progId: null, week: 0, sub: "program",
  lib: null, progs: null, logs: {}, meas: {}, clip: null, repeat: null, confirm: null, save: "", libQ: "", lift: "", link: {}, edEx: null, videoUrls: {},
  shared: [], sharedLib: [], sharing: false, shareList: null };
const timers = {};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const fmtDay = d => { if (!d) return "–"; const [y, m, dd] = String(d).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
const P = () => PG.progs && [...PG.progs, ...PG.shared].find(p => p.id === PG.progId);
const libById = () => Object.fromEntries([...(PG.sharedLib || []), ...(PG.lib || [])].map(e => [e.id, e]));
const libByName = () => Object.fromEntries((PG.lib || []).map(e => [e.name.trim().toLowerCase(), e]));
/* Programs other trainers shared with me show up as virtual clients: "sh:<owner>:<their client id>". */
const sharedClients = () => { const out = {}; for (const p of PG.shared){ const id = "sh:" + p.ownerId + ":" + p.clientId; out[id] = out[id] || { id, name: p.clientName || "Client", shared: true, ownerId: p.ownerId, ownerName: p.ownerName, realId: p.clientId }; } return Object.values(out); };
const client = id => C.S.clients.find(c => c.id === id) || sharedClients().find(c => c.id === id);
const progsOf = c => c.shared ? PG.shared.filter(p => p.ownerId === c.ownerId && p.clientId === c.realId) : (PG.progs || []).filter(p => p.clientId === c.id);
const redraw = () => C.render();

/* ---------- loading ---------- */
async function load(){
  if (PG.loading) return; PG.loading = true;
  try {
    PG.ready = await C.A.programs.ready();
    if (PG.ready.ok){
      const [lib, progs] = await Promise.all([C.A.programs.listExercises(), C.A.programs.listPrograms()]);
      PG.lib = lib; PG.progs = progs;
      const sh = C.A.programs.sharing;
      PG.sharing = sh ? await sh.ready().catch(() => false) : false;
      if (PG.sharing){ try { const w = await sh.withMe(); PG.shared = w.programs; PG.sharedLib = w.exercises; } catch (e){} }
      if (!lib.length && !(C.S.prof && C.S.prof.programsSeeded)){
        const list = STARTER_EXERCISES.map(e => ({ id: pid("ex"), ...e }));
        await C.A.programs.saveExercises(list); PG.lib = list;
        C.saveProfile({ programsSeeded: true }).catch(() => {});
      }
    }
  } catch (e){ PG.ready = { ok: false, code: "unavailable", message: e.message }; }
  PG.loading = false; redraw();
}
async function loadClient(id){
  try {
    const sc = client(id);
    if (sc && sc.shared){ const all = []; for (const p of progsOf(sc)) all.push(...await C.A.programs.programLogs(sc.ownerId, p.id)); PG.logs[id] = all; PG.meas[id] = []; return redraw(); }
    const [logs, meas] = await Promise.all([C.A.programs.logs(id), C.A.programs.measurements(id)]);
    PG.logs[id] = logs; PG.meas[id] = meas;
  } catch (e){ C.toast("Couldn't load this client's logs"); PG.logs[id] = PG.logs[id] || []; PG.meas[id] = PG.meas[id] || []; }
  if (C.A.programs.link) C.A.programs.link.get(id).then(l => { PG.link[id] = l || false; if (PG.clientId === id) redraw(); }).catch(() => {});
  redraw();
}

/* ---------- to-dos: calendar sessions without a planned workout ---------- */
function todos(M){
  M = M || (C.getModel && C.getModel());
  if (!M || !PG.progs) return [];
  return programTodos({ clients: C.S.clients, programs: PG.progs, now: M.now || new Date(), dismissed: (C.S.prof && C.S.prof.programsDismissed) || [],
    sessionsOf: id => { const st = M.stats && M.stats[id]; return st ? [...st.past, ...st.future] : []; } });
}
const shortD = d => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
function todoText(t){
  const c = client(t.clientId), first = c ? c.name : "Client";
  if (t.kind === "noprogram") return { who: first, what: `${t.n} session${t.n === 1 ? "" : "s"} on the calendar this week or next, and no program yet` };
  const p = (PG.progs || []).find(x => x.id === t.progId), wl = p && p.weeks[t.week] ? p.weeks[t.week].label : "Week " + (t.week + 1);
  return { who: first, what: t.kind === "noweek"
    ? `${t.n} session${t.n === 1 ? "" : "s"} ${shortD(t.from)}–${shortD(t.to)}, but the program ends before ${wl}`
    : `${t.n} session${t.n === 1 ? "" : "s"} ${shortD(t.from)}–${shortD(t.to)}, ${wl} has ${t.planned} workout${t.planned === 1 ? "" : "s"} planned` };
}
function renderTodos(){
  if (C.modelLoading && C.modelLoading()) return `<section class="card"><div class="card-h"><h2>To do</h2><span class="small muted">Reading your calendar…</span></div></section>`;
  const list = todos(); if (!list.length) return "";
  const gaps = list.filter(t => t.kind !== "noprogram"), none = list.filter(t => t.kind === "noprogram");
  const row = t => { const x = todoText(t); return `<div><span><b>${esc(x.who)}</b> · ${esc(x.what)}</span><span class="rowacts"><button class="btn sm primary" data-act="pg-todo-open" data-key="${esc(t.key)}">${t.kind === "noprogram" ? "Start program" : t.kind === "noweek" ? "Add week" : "Open"}</button><button class="btn sm ghost" data-act="pg-todo-x" data-key="${esc(t.key)}" title="${t.kind === "noprogram" ? "This client doesn't use programs" : "Dismiss"}">${t.kind === "noprogram" ? "Not needed" : "Dismiss"}</button></span></div>`; };
  return `<section class="card"><div class="card-h"><h2>To do</h2><span class="small muted">from your calendar</span></div>
    ${gaps.length ? `<div class="list">${gaps.map(row).join("")}</div>` : ""}
    ${none.length ? `<details ${gaps.length ? "" : "open"}><summary class="small">${none.length} client${none.length === 1 ? "" : "s"} with sessions coming up and no program</summary><div class="list" style="margin-top:8px">${none.map(row).join("")}</div></details>` : ""}
  </section>`;
}

/* ---------- saving ---------- */
function saveSoon(p){
  PG.save = "Saving…"; setSaveLabel();
  clearTimeout(timers[p.id]);
  timers[p.id] = setTimeout(async () => {
    try { p.updatedAt = new Date().toISOString(); await C.A.programs.saveProgram(p); PG.save = "Saved"; }
    catch (e){ PG.save = "Not saved. Check your connection."; C.toast("Couldn't save the program"); }
    setSaveLabel();
  }, 700);
}
function setSaveLabel(){ const el = document.getElementById("pg-save"); if (el) el.textContent = PG.save; }

/* ---------- render ---------- */
function render(){
  if (!C.A.programs) return `<div class="card"><div class="empty">Programs are available in the hosted app.</div></div>`;
  if (!PG.ready){ load(); return `<div class="card"><div class="empty"><b>Loading programs…</b></div></div>`; }
  if (!PG.ready.ok) return PG.ready.code === "not_setup"
    ? `<div class="card"><div class="empty"><b>Programs needs a one-time setup</b><span>The database tables for programs haven't been created yet. Once they are, this tab fills in with your exercise library and client programs.</span><button class="btn" data-act="pg-retry">Check again</button></div></div>`
    : `<div class="card"><div class="empty"><b>Couldn't load programs</b><span>${esc(PG.ready.message || "Check your connection and try again.")}</span><button class="btn" data-act="pg-retry">Try again</button></div></div>`;
  const seg = `<div class="seg" role="group" aria-label="Programs view">${[["clients", "Clients"], ["library", "Exercise library"]].map(([v, l]) => `<button data-act="pg-view" data-v="${v}" aria-pressed="${PG.view === v}">${l}</button>`).join("")}</div>`;
  const style = `<style>${LINECHART_CSS}${VIDEO_CSS}${CSS}</style>`;
  const own = C.standalone ? "" : `<a class="btn sm ghost" href="/programs${C.A.name === "demo" ? "?demo" : ""}" target="_blank" rel="noopener" style="margin-left:auto">Open on its own ↗</a>`;
  if (PG.view === "library") return style + `<div class="pg-top">${seg}${own}</div>` + renderLibrary();
  if (PG.clientId && client(PG.clientId)) return style + renderClient();
  return style + `<div class="pg-top">${seg}${own}</div>` + renderClientList();
}

function renderClientList(){
  const list = C.S.clients.filter(c => c.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const progOf = id => (PG.progs || []).filter(p => p.clientId === id && p.status !== "archived");
  return renderTodos() + `<section class="card"><div class="card-h"><h2>Client programs</h2><span class="small muted">${(PG.progs || []).filter(p => p.status !== "archived").length} active programs</span></div>
    ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Program</th><th class="num">Weeks</th><th>Updated</th><th></th></tr></thead><tbody>
    ${list.map(c => { const ps = progOf(c.id), p = ps[0];
      return `<tr><td><div class="who">${C.avatar(c)}<a href="#" class="n" data-act="pg-open" data-id="${esc(c.id)}">${esc(c.name)}</a></div></td>
        <td>${p ? esc(p.name) + (ps.length > 1 ? ` <span class="small muted">+${ps.length - 1}</span>` : "") : `<span class="muted small">None yet</span>`}</td>
        <td class="num">${p ? (p.weeks || []).length : "–"}</td><td class="small">${p && p.updatedAt ? fmtDay(p.updatedAt) : "–"}</td>
        <td><div class="rowacts"><button class="btn sm ${p ? "" : "primary"}" data-act="pg-open" data-id="${esc(c.id)}">${p ? "Open" : "Start program"}</button></div></td></tr>`; }).join("")}
    </tbody></table></div>` : `<div class="empty">Add clients first, then build their programs here.</div>`}</section>` + renderShared();
}
function renderShared(){
  const cs = sharedClients(); if (!cs.length) return "";
  return `<section class="card"><div class="card-h"><h2>Shared with you</h2><span class="small muted">one client's program, shared by another trainer</span></div>
    <div class="list">${cs.map(c => { const p = progsOf(c)[0]; return `<div><span class="who">${C.avatar(c)}<span><a href="#" data-act="pg-open" data-id="${esc(c.id)}" style="font-weight:600;color:var(--ink);text-decoration:none">${esc(c.name)}</a> <span class="small muted">· ${esc(p ? p.name : "")}${c.ownerName ? " · from " + esc(c.ownerName) : ""}</span></span></span><button class="btn sm" data-act="pg-open" data-id="${esc(c.id)}">Open</button></div>`; }).join("")}</div></section>`;
}

function renderClient(){
  const c = client(PG.clientId), progs = progsOf(c);
  if (!PG.progId || !progs.find(p => p.id === PG.progId)){ const a = progs.find(p => p.status !== "archived") || progs[0]; PG.progId = a ? a.id : null; PG.week = 0; }
  const link = PG.link[c.id];
  const head = `<div class="pg-top"><button class="btn sm" data-act="pg-back">← All clients</button>
    <div class="who" style="margin-right:auto">${C.avatar(c)}<b style="font-size:16px">${esc(c.name)}</b></div>
    <div class="seg" role="group" aria-label="Client view">${[["program", "Program"], ["progress", "Progress"]].map(([v, l]) => `<button data-act="pg-sub" data-v="${v}" aria-pressed="${PG.sub === v}">${l}</button>`).join("")}</div>
    ${c.shared ? `<span class="tag">shared by ${esc(c.ownerName || "another trainer")}</span>` : `<button class="btn sm" data-act="pg-share">${link ? "Client link" : "Share with client"}</button>`}</div>`;
  const notes = c.shared ? "" : `<details class="card pg-notes" ${c.programNotes ? "" : "open"}><summary><b>Programming notes</b> <span class="small muted">${c.programNotes ? esc(c.programNotes.slice(0, 90)) + (c.programNotes.length > 90 ? "…" : "") : "injuries, limitations, goals. The assistant reads these and flags anything risky"}</span></summary>
    <textarea class="pg-in" data-pg="cnotes" rows="3" placeholder="e.g. Left knee meniscus repair 2024, no deep loaded flexion. Lower back flares with heavy hinging. Goal: hike Kilimanjaro in March.">${esc(c.programNotes || "")}</textarea>
    <span class="small muted">Private to you. Saved when you click away.</span></details>`;
  return head + (PG.sub === "progress" ? renderProgress(c) : notes + renderProgram(c, progs));
}

/* ---------- program builder ---------- */
function renderProgram(c, progs){
  const p = P();
  if (!p && c.shared) return `<section class="card"><div class="empty">This program is no longer shared with you.</div></section>`;
  if (!p) return `<section class="card"><div class="empty"><b>No program for ${esc(c.name.split(" ")[0])} yet</b><span>Start one, then add weeks, sessions and exercises.</span>
    <div class="actions"><input id="pg-newname" class="pg-in" placeholder="Program name" value="${esc(c.name.split(" ")[0])}'s program"><button class="btn primary" data-act="pg-new">Start program</button>${C.A.programs.ai ? `<button class="btn" data-act="pg-ai" data-mode="create">✦ Draft with AI</button>` : ""}</div></div></section>`;
  const W = p.weeks || [], wi = Math.min(PG.week, Math.max(0, W.length - 1)); PG.week = wi;
  const week = W[wi];
  const clip = PG.clip;
  const progSel = progs.length > 1 ? `<select class="pg-in" data-pg="progsel">${progs.map(x => `<option value="${esc(x.id)}" ${x.id === p.id ? "selected" : ""}>${esc(x.name)}${x.status === "archived" ? " (archived)" : ""}</option>`).join("")}</select>` : "";
  const weekChips = `<div class="pg-weeks" role="tablist">${W.map((w, i) => `<button role="tab" aria-selected="${i === wi}" data-act="pg-week" data-i="${i}">${esc(w.label || "Week " + (i + 1))}</button>`).join("")}<button data-act="pg-addweek" title="Add a week">+ Week</button></div>`;
  const weekActs = week ? `<div class="pg-acts">
      <button class="btn sm" data-act="pg-copyweek">Copy week</button>
      ${clip && clip.type === "week" ? `<button class="btn sm" data-act="pg-pasteweek">Paste week here</button>` : ""}
      ${PG.repeat && PG.repeat.week ? repeatForm() : `<button class="btn sm" data-act="pg-repeat" data-week="1">Repeat week…</button>`}
      ${C.A.programs.ai ? `<button class="btn sm" data-act="pg-ai" data-mode="progress">✦ Progress week</button><button class="btn sm" data-act="pg-ai" data-mode="critique">✦ Critique program</button>` : ""}
      ${PG.confirm === "delweek" ? `<button class="btn sm danger" data-act="pg-delweek">Delete ${esc(week.label)}?</button>` : `<button class="btn sm ghost" data-act="pg-confirm" data-k="delweek">Delete week</button>`}
    </div>` : "";
  return `<section class="card pg-prog">
    <div class="card-h"><div class="pg-row">${progSel}<input class="pg-in pg-title" data-pg="prog" data-f="name" value="${esc(p.name)}" aria-label="Program name"></div>
      <div class="pg-acts"><span class="small muted" id="pg-save">${esc(PG.save)}</span>
      ${p.shared ? (PG.confirm === "leave" ? `<button class="btn sm danger" data-act="pg-leave">Remove from my list?</button>` : `<button class="btn sm ghost" data-act="pg-confirm" data-k="leave">Remove from my list</button>`) : `
      ${PG.sharing ? `<button class="btn sm" data-act="pg-sharetr">Share with a trainer</button>` : ""}
      <button class="btn sm" data-act="pg-newprog">New program</button>
      <button class="btn sm ghost" data-act="pg-archive">${p.status === "archived" ? "Unarchive" : "Archive"}</button>
      ${PG.confirm === "delprog" ? `<button class="btn sm danger" data-act="pg-delprog">Delete program?</button>` : `<button class="btn sm ghost" data-act="pg-confirm" data-k="delprog">Delete</button>`}`}</div></div>
    ${weekChips}
    ${week ? `<div class="pg-row"><input class="pg-in" data-pg="week" data-f="label" value="${esc(week.label)}" aria-label="Week name" style="max-width:180px">${weekActs}</div>` : ""}
  </section>
  ${week ? (week.sessions || []).map((s, si) => renderSession(p, wi, si, s)).join("") : `<div class="card"><div class="empty">No weeks yet. <button class="btn sm primary" data-act="pg-addweek">Add a week</button></div></div>`}
  ${week ? `<div class="pg-acts" style="justify-content:flex-start"><button class="btn primary" data-act="pg-addsess">+ Session</button>${clip && clip.type === "session" ? `<button class="btn" data-act="pg-pastesess">Paste “${esc(clip.data.name)}”</button>` : ""}</div>` : ""}
  <datalist id="pg-exlist">${(PG.lib || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map(e => `<option value="${esc(e.name)}"></option>`).join("")}</datalist>`;
}
function repeatForm(){
  return `<span class="pg-repeat">Copy into the next <input type="number" min="1" max="52" value="${esc(PG.repeat.n || 3)}" id="pg-rep-n" class="pg-in" style="width:64px"> weeks <button class="btn sm primary" data-act="pg-repeat-go">Paste</button><button class="btn sm ghost" data-act="pg-repeat-x">Cancel</button></span>`;
}
function renderSession(p, wi, si, s){
  const lib = libById();
  const rep = PG.repeat && !PG.repeat.week && PG.repeat.s === si;
  const rows = (s.rows || []).map((r, ri) => {
    const ex = r.exId && lib[r.exId]; const hasVid = ex && (ex.videoUrl || ex.videoPath);
    const f = (k, ph, w) => `<input class="pg-in" data-pg="row" data-s="${si}" data-r="${ri}" data-f="${k}" value="${esc(r[k])}" placeholder="${ph}" ${w ? `style="width:${w}"` : ""} aria-label="${ph}">`;
    return `<tr><td>${f("group", "A1", "48px")}</td>
      <td><div class="pg-exname"><input class="pg-in" list="pg-exlist" data-pg="row" data-s="${si}" data-r="${ri}" data-f="name" value="${esc(r.name)}" placeholder="Exercise" aria-label="Exercise">${hasVid ? `<button class="btn sm ghost" data-act="pg-vid" data-id="${esc(ex.id)}" title="Watch video" aria-label="Watch video">▶</button>` : ex ? "" : r.name ? `<span class="pg-new" title="Not in your library yet">new</span>` : ""}</div></td>
      <td>${f("sets", "Sets", "56px")}</td><td>${f("reps", "Reps", "72px")}</td><td>${f("weight", "Weight", "72px")}</td><td>${f("note", "Note")}</td>
      <td><button class="btn sm ghost" data-act="pg-delrow" data-s="${si}" data-r="${ri}" aria-label="Remove row">✕</button></td></tr>`;
  }).join("");
  const cKey = "delsess" + si;
  return `<section class="card pg-sess ${s.homework ? "hw" : ""}">
    <div class="card-h"><div class="pg-row" style="flex:1"><input class="pg-in pg-sname" data-pg="sess" data-s="${si}" data-f="name" value="${esc(s.name)}" aria-label="Session name">
      <label class="check small"><input type="checkbox" data-pg="sess" data-s="${si}" data-f="homework" ${s.homework ? "checked" : ""}> Homework <span class="muted">(client can log)</span></label></div>
      <div class="pg-acts"><button class="btn sm" data-act="pg-log" data-s="${si}">Log</button>${C.A.programs.ai ? `<button class="btn sm" data-act="pg-ai" data-mode="progress" data-s="${si}">✦ Progress</button>` : ""}<button class="btn sm" data-act="pg-copysess" data-s="${si}">Copy</button>
        ${rep ? "" : `<button class="btn sm" data-act="pg-repeat" data-s="${si}">Repeat…</button>`}
        <button class="btn sm ghost" data-act="pg-up" data-s="${si}" aria-label="Move up" ${si ? "" : "disabled"}>↑</button>
        ${PG.confirm === cKey ? `<button class="btn sm danger" data-act="pg-delsess" data-s="${si}">Delete?</button>` : `<button class="btn sm ghost" data-act="pg-confirm" data-k="${cKey}">Delete</button>`}</div></div>
    ${rep ? `<div class="pg-acts" style="justify-content:flex-start">${repeatForm()}</div>` : ""}
    <div class="tablewrap"><table class="pg-rows"><thead><tr><th>Group</th><th>Exercise</th><th>Sets</th><th>Reps</th><th>Weight</th><th>Note</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pg-row"><button class="btn sm" data-act="pg-addrow" data-s="${si}">+ Exercise</button>
      <input class="pg-in" data-pg="sess" data-s="${si}" data-f="notes" value="${esc(s.notes || "")}" placeholder="Session note for the client (optional)" style="flex:1"></div>
  </section>`;
}

/* ---------- progress: measurements, body fat, lifts, log history ---------- */
function renderProgress(c){
  const meas = PG.meas[c.id], logs = PG.logs[c.id];
  if (!meas || !logs) return `<div class="card"><div class="empty">Loading…</div></div>`;
  if (c.shared){ const H = liftHistory(logs), names = Object.keys(H); if (!PG.lift || !H[PG.lift]) PG.lift = names[0] || "";
    return `<section class="card"><div class="card-h"><h2>Lifts over time</h2>${names.length ? `<select class="pg-in" data-pg="lift" aria-label="Exercise">${names.map(n => `<option ${n === PG.lift ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>` : ""}</div>${names.length ? lineChart((H[PG.lift] || []).map(x => ({ date: x.date, value: x.weight }))) : `<div class="empty">Nothing logged yet.</div>`}<p class="small muted">Bodyweight and body fat stay with ${esc(c.ownerName || "the trainer who shared this")}.</p></section>`; }
  const sex = c.sex || "", by = c.birthYear || "";
  const rows = meas.slice().sort((a, b) => String(a.taken_on).localeCompare(String(b.taken_on)));
  const bfOf = m => m.body_fat != null ? Number(m.body_fat) : bodyFat4(m, sex, ageOn(by, m.taken_on));
  const wPts = rows.filter(m => num(m.weight) != null).map(m => ({ date: String(m.taken_on).slice(0, 10), value: Number(m.weight), label: m.source === "client" ? "logged by client" : "" }));
  const bPts = rows.map(m => ({ date: String(m.taken_on).slice(0, 10), value: bfOf(m) })).filter(p => p.value != null);
  const H = liftHistory(logs), names = Object.keys(H).sort((a, b) => H[b].length - H[a].length || a.localeCompare(b));
  if (!PG.lift || !H[PG.lift]) PG.lift = names[0] || "";
  const lift = H[PG.lift] || [];
  const prev = bfOf({ triceps: valIn("pg-m-tri"), abdomen: valIn("pg-m-abd"), suprailiac: valIn("pg-m-sup"), thigh: valIn("pg-m-thi"), taken_on: today() });
  const byDay = {};
  for (const l of logs){ const k = String(l.logged_on).slice(0, 10) + "|" + l.session_id; const e = byDay[k] || (byDay[k] = { day: String(l.logged_on).slice(0, 10), session: l.session_id, sets: 0, done: 0, client: false, ex: new Set() }); e.sets++; if (l.done) e.done++; if (l.source === "client") e.client = true; e.ex.add(l.ex_name); }
  const sessName = sid => { for (const p of PG.progs || []) for (const w of p.weeks || []) for (const s of w.sessions || []) if (s.id === sid) return (w.label ? w.label + " · " : "") + s.name; return "Session"; };
  const hist = Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 15);
  return `<div class="grid2">
    <section class="card"><div class="card-h"><h2>Bodyweight</h2><span class="small muted">${wPts.length ? `latest ${wPts[wPts.length - 1].value}` : ""}</span></div>${lineChart(wPts, { unit: "" })}</section>
    <section class="card"><div class="card-h"><h2>Body fat (4-site)</h2><span class="small muted">${bPts.length ? `latest ${bPts[bPts.length - 1].value}%` : ""}</span></div>${lineChart(bPts, { unit: "%" })}
      ${!sex || !by ? `<p class="small muted">Add ${esc(c.name.split(" ")[0])}'s sex and birth year below so body fat can be calculated.</p>` : ""}</section>
  </div>
  <section class="card"><div class="card-h"><h2>Add a measurement</h2><span class="small muted">Jackson-Pollock 4-site, skinfolds in mm</span></div>
    <div class="pg-grid">
      <div class="field"><label for="pg-m-date">Date</label><input id="pg-m-date" type="date" value="${today()}"></div>
      <div class="field"><label for="pg-m-w">Weight</label><input id="pg-m-w" type="number" step="0.1" inputmode="decimal"></div>
      <div class="field"><label for="pg-m-tri">Triceps</label><input id="pg-m-tri" type="number" step="0.5" inputmode="decimal" data-pg="calc"></div>
      <div class="field"><label for="pg-m-abd">Abdomen (navel)</label><input id="pg-m-abd" type="number" step="0.5" inputmode="decimal" data-pg="calc"></div>
      <div class="field"><label for="pg-m-sup">Suprailiac</label><input id="pg-m-sup" type="number" step="0.5" inputmode="decimal" data-pg="calc"></div>
      <div class="field"><label for="pg-m-thi">Thigh</label><input id="pg-m-thi" type="number" step="0.5" inputmode="decimal" data-pg="calc"></div>
      <div class="field"><label for="pg-sex">Sex</label><select id="pg-sex" data-pg="who"><option value="">–</option><option value="female" ${sex === "female" ? "selected" : ""}>Female</option><option value="male" ${sex === "male" ? "selected" : ""}>Male</option></select></div>
      <div class="field"><label for="pg-by">Birth year</label><input id="pg-by" type="number" min="1920" max="2020" value="${esc(by)}" data-pg="who"></div>
    </div>
    <div class="pg-row"><button class="btn primary" data-act="pg-addmeas">Save measurement</button><span class="small" id="pg-bf">${prev != null ? `Body fat ≈ <b>${prev}%</b>` : "Body fat appears when all four sites, sex and birth year are filled in."}</span></div>
  </section>
  <section class="card"><div class="card-h"><h2>Lifts over time</h2>${names.length ? `<select class="pg-in" data-pg="lift" aria-label="Exercise">${names.map(n => `<option ${n === PG.lift ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>` : ""}</div>
    ${names.length ? lineChart(lift.map(x => ({ date: x.date, value: x.weight, label: x.reps ? x.reps + " reps" : "" })), { unit: "", decimals: 1 }) + `<p class="small muted">Heaviest logged set each day.</p>` : `<div class="empty">Logged weights show up here. Use “Log” on a session, or have ${esc(c.name.split(" ")[0])} log homework from their link.</div>`}
    ${names.length > 1 ? `<div class="tablewrap"><table><thead><tr><th>Exercise</th><th class="num">First</th><th class="num">Latest</th><th class="num">Best</th><th>Last logged</th></tr></thead><tbody>${names.slice(0, 12).map(n => { const h = H[n], best = Math.max(...h.map(x => x.weight)); return `<tr><td>${esc(n)}</td><td class="num">${h[0].weight}</td><td class="num">${h[h.length - 1].weight}</td><td class="num" style="font-weight:600">${best}</td><td class="small">${fmtDay(h[h.length - 1].date)}</td></tr>`; }).join("")}</tbody></table></div>` : ""}
  </section>
  <div class="grid2">
    <section class="card"><h2>Measurements</h2>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th class="num">Weight</th><th class="num">Sum (mm)</th><th class="num">Body fat</th><th></th></tr></thead><tbody>
      ${rows.slice().reverse().map(m => { const S4 = [m.triceps, m.abdomen, m.suprailiac, m.thigh].map(num); const sum = S4.every(x => x != null) ? S4.reduce((a, b) => a + b, 0) : null; const bf = bfOf(m);
        return `<tr><td>${fmtDay(m.taken_on)}${m.source === "client" ? ` <span class="tag">client</span>` : ""}</td><td class="num">${m.weight ?? "–"}</td><td class="num">${sum ?? "–"}</td><td class="num">${bf != null ? bf + "%" : "–"}</td><td><button class="btn sm ghost" data-act="pg-delmeas" data-id="${esc(m.id)}" aria-label="Delete">✕</button></td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty">No measurements yet.</div>`}</section>
    <section class="card"><h2>Recent logs</h2>${hist.length ? `<div class="list">${hist.map(h => `<div><span><b>${fmtDay(h.day)}</b> · ${esc(sessName(h.session))}${h.client ? ` <span class="tag">client</span>` : ""}</span><span class="small muted">${h.done}/${h.sets} sets</span></div>`).join("")}</div>` : `<div class="empty">Nothing logged yet.</div>`}</section>
  </div>`;
}
const valIn = id => { const el = document.getElementById(id); return el ? el.value : ""; };

/* ---------- library ---------- */
function renderLibrary(){
  const q = PG.libQ.trim().toLowerCase();
  const list = (PG.lib || []).filter(e => !q || [e.name, e.muscle, e.equipment].join(" ").toLowerCase().includes(q)).sort((a, b) => (a.muscle || "~").localeCompare(b.muscle || "~") || a.name.localeCompare(b.name));
  const groups = {}; for (const e of list) (groups[e.muscle || "Other"] = groups[e.muscle || "Other"] || []).push(e);
  return `<section class="card"><div class="card-h"><h2>Exercise library</h2><span class="small muted">${(PG.lib || []).length} exercises · ${(PG.lib || []).filter(e => e.videoUrl || e.videoPath).length} with video</span></div>
    <div class="pg-row"><input class="pg-in" id="pg-libq" data-pg="libq" placeholder="Search by name, muscle or equipment" value="${esc(PG.libQ)}" style="flex:1"><button class="btn primary" data-act="pg-exnew">+ Exercise</button></div>
    ${Object.keys(groups).length ? Object.entries(groups).map(([g, es]) => `<h3>${esc(g)}</h3><div class="list">${es.map(e => `<div><span><a href="#" data-act="pg-exedit" data-id="${esc(e.id)}" style="font-weight:600;color:var(--ink);text-decoration:none">${esc(e.name)}</a> <span class="small muted">${esc([e.equipment, e.sets && e.reps ? e.sets + " × " + e.reps : ""].filter(Boolean).join(" · "))}</span></span>
      <span>${e.videoUrl || e.videoPath ? `<button class="btn sm ghost" data-act="pg-vid" data-id="${esc(e.id)}">▶ Video</button>` : `<span class="small muted">No video</span>`}</span></div>`).join("")}</div>`).join("") : `<div class="empty">No exercises match.</div>`}
  </section>`;
}

/* ---------- sheets (use the app's #modal slot) ---------- */
function sheet(title, body){
  document.getElementById("modal").innerHTML = `<div class="scrim" data-act="close-scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-h"><h2>${esc(title)}</h2><button class="btn sm" data-act="close">Close</button></div>${body}</div></div>`;
}
function exSheet(){
  const e = PG.edEx;
  sheet(e.id ? e.name || "Exercise" : "New exercise", `<div class="form">
    <div class="field full"><label for="ex-name">Name</label><input id="ex-name" value="${esc(e.name || "")}"></div>
    <div class="field"><label for="ex-muscle">Muscle group</label><input id="ex-muscle" value="${esc(e.muscle || "")}" list="ex-muscles"></div>
    <div class="field"><label for="ex-eq">Equipment</label><input id="ex-eq" value="${esc(e.equipment || "")}"></div>
    <div class="field"><label for="ex-sets">Default sets</label><input id="ex-sets" value="${esc(e.sets ?? "")}"></div>
    <div class="field"><label for="ex-reps">Default reps</label><input id="ex-reps" value="${esc(e.reps ?? "")}"></div>
    <div class="field full"><label for="ex-cues">Coaching cues</label><textarea id="ex-cues" rows="3">${esc(e.cues || "")}</textarea></div>
    <div class="field full"><label for="ex-url">Video link</label><input id="ex-url" type="url" value="${esc(e.videoUrl || "")}" placeholder="YouTube or Vimeo link (unlisted is fine)"></div>
    <div class="field full"><label for="ex-file">Or upload a video</label><input id="ex-file" type="file" accept="video/*"><span class="hint">${e.videoPath ? "A video is uploaded. Choosing a new file replaces it." : "Up to 50 MB. Short phone clips work well."}</span></div>
  </div>
  <datalist id="ex-muscles">${[...new Set((PG.lib || []).map(x => x.muscle).filter(Boolean))].map(m => `<option value="${esc(m)}">`).join("")}</datalist>
  <div id="ex-prev">${e.videoUrl ? videoEmbed(e.videoUrl) : ""}</div>
  <div class="actions"><button class="btn primary" data-act="pg-exsave">Save</button>
    ${e.id ? (PG.confirm === "delex" ? `<button class="btn danger" data-act="pg-exdel">Delete ${esc(e.name)}?</button>` : `<button class="btn danger" data-act="pg-confirm" data-k="delex">Delete</button>`) : ""}
    ${e.videoPath ? `<button class="btn ghost" data-act="pg-exrmvid">Remove uploaded video</button>` : ""}</div>`);
}
async function videoSheet(id){
  const e = (PG.lib || []).find(x => x.id === id); if (!e) return;
  let url = e.videoUrl;
  if (e.videoPath){ try { url = PG.videoUrls[e.videoPath] || await C.A.programs.videoUrl(e.videoPath) || e.localUrl; PG.videoUrls[e.videoPath] = url; } catch (x){ url = e.videoUrl; } }
  sheet(e.name, `${url ? videoEmbed(url) : `<div class="empty">No video yet.</div>`}${e.cues ? `<p>${esc(e.cues)}</p>` : ""}<p class="small muted">${esc([e.muscle, e.equipment].filter(Boolean).join(" · "))}</p>`);
}
function logSheet(){
  const p = P(), L = PG.logFor; if (!p || !L) return;
  const s = p.weeks[L.w] && p.weeks[L.w].sessions[L.s]; if (!s) return;
  const have = {}; for (const l of PG.logs[PG.clientId] || []) if (l.session_id === s.id) have[l.row_id + "|" + l.set_no] = l;
  const date = Object.values(have)[0] ? String(Object.values(have)[0].logged_on).slice(0, 10) : today();
  const rows = (s.rows || []).filter(r => r.name).map(r => { const n = setCount(r);
    return `<div class="lg-ex"><div class="lg-h"><b>${r.group ? `<span class="tag">${esc(r.group)}</span> ` : ""}${esc(r.name)}</b><span class="small muted">${esc([r.sets && r.reps ? r.sets + " × " + r.reps : r.reps, r.weight ? "@ " + r.weight : ""].filter(Boolean).join(" "))}</span></div>
      ${Array.from({ length: n }, (_, k) => { const l = have[r.id + "|" + (k + 1)] || {}; const key = r.id + "|" + (k + 1);
        return `<div class="lg-set"><span class="small muted">Set ${k + 1}</span><input class="pg-in" data-lg="${esc(key)}" data-f="reps" type="number" inputmode="numeric" placeholder="Reps" value="${esc(l.reps ?? "")}"><input class="pg-in" data-lg="${esc(key)}" data-f="weight" type="number" step="0.5" inputmode="decimal" placeholder="Weight" value="${esc(l.weight ?? "")}"><label class="check"><input type="checkbox" data-lg="${esc(key)}" data-f="done" ${l.done ? "checked" : ""}> Done</label></div>`; }).join("")}</div>`; }).join("");
  sheet("Log · " + s.name, `<div class="field"><label for="lg-date">Date</label><input id="lg-date" type="date" value="${date}"></div>${rows || `<div class="empty">Add exercises to this session first.</div>`}
    <div class="actions"><button class="btn primary" data-act="pg-logsave">Save log</button></div>`);
}
function trainerShareSheet(){
  const p = P(), c = client(PG.clientId), L = PG.shareList;
  sheet("Share with a trainer", `<p class="small">Share <b>${esc(p.name)}</b> for ${esc(c.name)} with another trainer, using the Google email they sign in to Trainer Tally with. They can open, edit and log it under <b>Shared with you</b> in their Programs. Your other clients, billing and ${esc(c.name.split(" ")[0])}'s measurements stay private.</p>
    <div class="pg-row"><input id="pg-tr-email" class="pg-in" type="email" placeholder="their Google email" style="flex:1"><button class="btn primary" data-act="pg-sharetr-add">Share</button></div>
    ${L == null ? `<p class="small muted">Loading…</p>` : L.length ? `<h3>Shared with</h3><div class="list">${L.map(x => `<div><span>${esc(x.shared_email)}</span><button class="btn sm ghost" data-act="pg-sharetr-rm" data-e="${esc(x.shared_email)}">Stop sharing</button></div>`).join("")}</div>` : `<p class="small muted">Not shared with anyone yet.</p>`}`);
}
function shareSheet(){
  const c = client(PG.clientId), l = PG.link[c.id];
  sheet("Share with " + c.name.split(" ")[0], `<p class="small">A private page with ${esc(c.name.split(" ")[0])}'s program and exercise videos. No login. They can check off sets and record reps and weight on sessions marked <b>Homework</b>, and log their bodyweight.</p>
    ${l ? `<div class="field"><label for="pg-link">Link</label><input id="pg-link" readonly value="${esc(l.url)}"></div>
      <div class="actions"><button class="btn primary" data-act="pg-linkcopy">Copy link</button><a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">Open</a><button class="btn danger" data-act="pg-linkoff">Turn off link</button></div>
      <p class="small muted">Turning it off stops the link working. You can make a new one any time.</p>`
    : `<div class="actions"><button class="btn primary" data-act="pg-linkmake">Create link</button></div>`}`);
}

/* ---------- AI assistant ---------- */
const DIRS = [["strength", "Strength"], ["stability", "Stability"], ["power", "Power"], ["coordination", "Coordination"], ["endurance", "Endurance"], ["hypertrophy", "Muscle"], ["mobility", "Mobility"], ["deload", "Deload"]];
function aiSheet(){
  const X = PG.ai, c = client(PG.clientId), p = P(), first = c ? c.name.split(" ")[0] : "client";
  const title = X.mode === "create" ? "Draft a program" : X.mode === "critique" ? "Critique · " + (p ? p.name : "") : "Progress " + (X.session != null && p ? "“" + p.weeks[X.week].sessions[X.session].name + "”" : p ? p.weeks[X.week].label : "");
  let body = "";
  const flags = f => (f || []).length ? `<div class="ai-flags"><h3>⚠ Check before using</h3>${f.map(x => `<div><b>${esc(x.exercise)}</b>: ${esc(x.concern)}${x.alternative ? ` <span class="muted">Try: ${esc(x.alternative)}</span>` : ""}</div>`).join("")}</div>` : "";
  const lib = libByName();
  const rowsTbl = rows => `<table class="ai-rows"><tbody>${rows.map(r => `<tr><td class="small muted">${esc(r.group || "")}</td><td>${esc(r.name)}${!lib[String(r.name).trim().toLowerCase()] ? ` <span class="pg-new">new</span>` : ""}${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ""}</td><td class="num">${esc(r.sets)} × ${esc(r.reps)}</td><td class="small">${esc(r.weight || "")}</td></tr>`).join("")}</tbody></table>`;
  const sess = s => `<div class="ai-sess"><div class="lg-h"><b>${esc(s.name)}</b>${s.homework ? `<span class="tag">homework</span>` : ""}</div>${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ""}${rowsTbl(s.rows || [])}</div>`;
  if (X.step === "form"){
    const notesLine = c && !c.shared ? (c.programNotes ? `<p class="small">Reading ${esc(first)}'s notes: <i>${esc(c.programNotes.slice(0, 160))}${c.programNotes.length > 160 ? "…" : ""}</i></p>` : `<p class="small muted">No programming notes for ${esc(first)} yet. Add injuries or limitations above the program so the assistant can flag them.</p>`) : "";
    if (X.mode === "create") body = `${notesLine}<div class="form">
        <div class="field"><label for="ai-weeks">Weeks</label><input id="ai-weeks" type="number" min="1" max="12" value="4"></div>
        <div class="field"><label for="ai-days">Sessions per week</label><input id="ai-days" type="number" min="1" max="6" value="2"></div>
        <div class="field"><label for="ai-hw">Homework per week</label><input id="ai-hw" type="number" min="0" max="4" value="1"></div>
        <div class="field"><label for="ai-eq">Equipment</label><input id="ai-eq" value="Full gym"></div>
        <div class="field full"><label for="ai-goal">Goal</label><input id="ai-goal" placeholder="e.g. get stronger, lose 15 lb, run a half marathon in May"></div>
        <div class="field full"><label for="ai-notes">Anything else</label><textarea id="ai-notes" rows="2" placeholder="Preferences, style, what's worked before"></textarea></div></div>
      <div class="actions"><button class="btn primary" data-act="pg-ai-go">✦ Draft program</button></div>`;
    else if (X.mode === "critique") body = `${notesLine}<p class="small">The assistant reviews balance, volume, exercise order, progression and fit with ${esc(first)}'s notes and logs. Nothing changes until you decide to.</p><div class="actions"><button class="btn primary" data-act="pg-ai-go">✦ Critique</button></div>`;
    else body = `${notesLine}<h3>Direction</h3><div class="ai-dirs">${DIRS.map(([k, l]) => `<button class="btn sm ${X.direction === k ? "primary" : ""}" data-act="pg-ai-dir" data-k="${k}" aria-pressed="${X.direction === k}">${l}</button>`).join("")}</div>
      <div class="field"><label for="ai-notes">Or describe it</label><input id="ai-notes" placeholder="e.g. more single-leg work, she's bored of deadlifts" value="${esc(X.notes || "")}"></div>
      <div class="actions"><button class="btn primary" data-act="pg-ai-go">✦ Progress</button></div>`;
  } else if (X.step === "loading") body = `<div class="empty"><b>Thinking…</b><span>Reading the program, ${esc(first)}'s notes and recent logs. This can take up to a minute.</span></div>`;
  else if (X.step === "error") body = `<div class="banner err"><span>${esc(X.error)}</span></div><div class="actions"><button class="btn" data-act="pg-ai-back">Back</button></div>`;
  else {
    const R = X.result;
    if (X.mode === "critique") body = `<p>${esc(R.summary)}</p>${flags(R.flags)}
      ${(R.strengths || []).length ? `<h3>Working well</h3><ul class="ai-list">${R.strengths.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <h3>Suggestions</h3><div class="list">${(R.suggestions || []).map(x => `<div style="display:block"><b>${esc(x.title)}</b> <span class="chip ${x.priority === "high" ? "owes" : x.priority === "medium" ? "low" : "info"}">${esc(x.priority)}</span>${x.where ? ` <span class="small muted">${esc(x.where)}</span>` : ""}<div class="small">${esc(x.detail)}</div></div>`).join("")}</div>
      <div class="actions"><button class="btn primary" data-act="close">Done</button><button class="btn" data-act="pg-ai-back">Run again</button></div>`;
    else if (X.mode === "create") body = `<p><b>${esc(R.name)}</b>. ${esc(R.summary)}</p>${flags(R.flags)}${(R.weeks || []).map(w => `<details ${w === R.weeks[0] ? "open" : ""}><summary><b>${esc(w.label)}</b> <span class="small muted">${(w.sessions || []).length} sessions</span></summary>${(w.sessions || []).map(sess).join("")}</details>`).join("")}
      <div class="actions"><button class="btn primary" data-act="pg-ai-accept" data-how="newprog">Use this program</button><button class="btn" data-act="pg-ai-back">Try again</button><button class="btn ghost" data-act="close">Discard</button></div>
      <p class="small muted">New exercises are added to your library when you use the program.</p>`;
    else body = `<p>${esc(R.summary)}</p>${flags(R.flags)}${(R.changes || []).length ? `<h3>Changes</h3><ul class="ai-list">${R.changes.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${(R.sessions || []).map(sess).join("")}
      <div class="actions">${X.session != null
        ? `<button class="btn primary" data-act="pg-ai-accept" data-how="nextweek">Add to next week</button><button class="btn" data-act="pg-ai-accept" data-how="replace">Replace this session</button>`
        : `<button class="btn primary" data-act="pg-ai-accept" data-how="newweek">Insert as next week</button><button class="btn" data-act="pg-ai-accept" data-how="replace">Replace this week</button>`}
        <button class="btn" data-act="pg-ai-back">Try again</button><button class="btn ghost" data-act="close">Discard</button></div>`;
  }
  sheet("✦ " + title, body);
}
async function aiRun(){
  const X = PG.ai, c = client(PG.clientId), p = P();
  const body = { action: X.mode, clientId: c.shared ? c.realId : c.id, ownerId: c.shared ? c.ownerId : undefined, programId: p ? p.id : undefined };
  if (X.mode === "create") body.brief = { weeks: valIn("ai-weeks"), daysPerWeek: valIn("ai-days"), homework: valIn("ai-hw"), equipment: valIn("ai-eq"), goal: valIn("ai-goal"), notes: valIn("ai-notes") };
  if (X.mode === "progress"){ X.notes = valIn("ai-notes"); body.week = X.week; body.session = X.session; body.direction = X.direction || ""; body.notes = X.notes; if (!X.direction && !X.notes){ C.toast("Pick a direction or describe it"); return; } }
  X.step = "loading"; aiSheet();
  try { const r = await C.A.programs.ai(body); X.result = r.result; X.step = "result"; }
  catch (e){ X.error = e.code === "ai_not_setup" ? "The AI assistant isn't switched on yet. It needs an Anthropic API key added to the app (ANTHROPIC_API_KEY in Vercel)." : (e.message || "Something went wrong. Try again."); X.step = "error"; }
  if (PG.ai === X) aiSheet();
}
/* Turn AI rows into program rows, linking library exercises and creating new ones. */
async function aiToRows(rows){
  const lib = libByName(), fresh = [];
  const out = (rows || []).map(r => {
    const key = String(r.name || "").trim().toLowerCase(); let e = lib[key];
    if (!e && r.name){ e = { id: pid("ex"), name: String(r.name).trim(), muscle: r.muscle || "", equipment: r.equipment || "", cues: r.cues || "", sets: r.sets || "", reps: r.reps || "", videoUrl: "" }; lib[key] = e; fresh.push(e); }
    return { id: pid("r"), exId: e ? e.id : null, name: e ? e.name : r.name || "", group: r.group || "", sets: String(r.sets ?? ""), reps: String(r.reps ?? ""), weight: String(r.weight ?? ""), note: r.note || "" };
  });
  if (fresh.length && !P()?.shared){ try { await C.A.programs.saveExercises(fresh); PG.lib.push(...fresh); } catch (e){} }
  return out;
}
const aiSession = async s => ({ id: pid("s"), name: s.name || "Session", homework: !!s.homework, notes: s.notes || "", rows: await aiToRows(s.rows) });
async function aiAccept(how){
  const X = PG.ai, R = X.result;
  if (X.mode === "create"){
    const weeks = []; for (const w of R.weeks || []){ const ss = []; for (const s of w.sessions || []) ss.push(await aiSession(s)); weeks.push({ id: pid("w"), label: w.label || "Week " + (weeks.length + 1), sessions: ss }); }
    const np = { id: pid("p"), ...newProgram(PG.clientId, R.name || "Program"), weeks };
    PG.progs.push(np); PG.progId = np.id; PG.week = 0; saveSoon(np);
  } else {
    const p = P(), ss = []; for (const s of R.sessions || []) ss.push(await aiSession(s));
    if (X.session != null){
      if (how === "replace") p.weeks[X.week].sessions[X.session] = ss[0];
      else { const wi = X.week + 1; if (!p.weeks[wi]) p.weeks.push({ id: pid("w"), label: "Week " + (p.weeks.length + 1), sessions: [] }); p.weeks[wi].sessions.push(...ss); PG.week = wi; }
    } else if (how === "replace") p.weeks[X.week].sessions = ss;
    else { p.weeks.splice(X.week + 1, 0, { id: pid("w"), label: "Week " + (X.week + 2), sessions: ss }); p.weeks.forEach((w, i) => { if (/^Week \d+$/.test(w.label || "")) w.label = "Week " + (i + 1); }); PG.week = X.week + 1; }
    saveSoon(p);
  }
  PG.ai = null; C.closeModal(); C.toast("Added. Edit anything you like."); redraw();
}

/* ---------- edits ---------- */
function mutate(fn, rerender = true){ const p = P(); if (!p) return; fn(p); saveSoon(p); if (rerender) redraw(); }
function fillFromLibrary(r){
  const e = libByName()[String(r.name || "").trim().toLowerCase()];
  if (e){ r.exId = e.id; r.name = e.name; if (!r.sets && e.sets) r.sets = String(e.sets); if (!r.reps && e.reps) r.reps = String(e.reps); }
  else r.exId = null;
}

async function onClick(el, e){
  const act = el.getAttribute("data-act"), si = +el.getAttribute("data-s"), ri = +el.getAttribute("data-r");
  if (act !== "pg-confirm" && !["pg-delweek", "pg-delprog", "pg-delsess", "pg-exdel"].includes(act)) PG.confirm = null;
  const p = P(), wi = PG.week;
  switch (act){
    case "pg-retry": PG.ready = null; redraw(); break;
    case "pg-todo-x": { const k = el.getAttribute("data-key"); const cur = (C.S.prof && C.S.prof.programsDismissed) || []; C.saveProfile({ programsDismissed: [...cur, k].slice(-300) }).catch(() => {}); redraw(); break; }
    case "pg-todo-open": {
      const t = todos().find(x => x.key === el.getAttribute("data-key")); if (!t) break;
      PG.clientId = t.clientId; PG.sub = "program"; PG.repeat = null; loadClient(t.clientId);
      if (t.kind === "noprogram"){ PG.progId = null; PG.week = 0; redraw(); window.scrollTo({ top: 0 }); break; }
      PG.progId = t.progId; const prog = P();
      if (prog && t.week >= prog.weeks.length){ while (prog.weeks.length <= t.week) prog.weeks.push(newWeek("Week " + (prog.weeks.length + 1))); saveSoon(prog); C.toast(`Added ${prog.weeks[t.week].label}. Paste a week or session into it.`); }
      PG.week = t.week; redraw(); window.scrollTo({ top: 0 }); break; }
    case "pg-view": PG.view = el.getAttribute("data-v"); redraw(); break;
    case "pg-open": PG.clientId = el.getAttribute("data-id"); PG.progId = null; PG.week = 0; PG.sub = "program"; PG.repeat = null; loadClient(PG.clientId); redraw(); window.scrollTo({ top: 0 }); break;
    case "pg-back": PG.clientId = null; redraw(); break;
    case "pg-sub": PG.sub = el.getAttribute("data-v"); redraw(); break;
    case "pg-new": case "pg-newprog": {
      const name = act === "pg-new" ? (valIn("pg-newname").trim() || "Program") : "New program";
      const np = { id: pid("p"), ...newProgram(PG.clientId, name) };
      PG.progs.push(np); PG.progId = np.id; PG.week = 0; saveSoon(np); redraw(); break; }
    case "pg-archive": mutate(p => p.status = p.status === "archived" ? "active" : "archived"); break;
    case "pg-confirm": PG.confirm = el.getAttribute("data-k"); PG.edEx ? exSheet() : redraw(); break;
    case "pg-delprog": { const id = PG.progId; PG.progs = PG.progs.filter(x => x.id !== id); PG.progId = null; clearTimeout(timers[id]); redraw(); C.A.programs.deleteProgram(id).then(() => C.toast("Program deleted")).catch(() => C.toast("Couldn't delete")); break; }
    case "pg-week": PG.week = +el.getAttribute("data-i"); PG.repeat = null; redraw(); break;
    case "pg-addweek": mutate(p => { p.weeks.push(newWeek("Week " + (p.weeks.length + 1))); PG.week = p.weeks.length - 1; }); break;
    case "pg-delweek": mutate(p => { p.weeks.splice(wi, 1); PG.week = Math.max(0, wi - 1); }); break;
    case "pg-copyweek": PG.clip = { type: "week", data: JSON.parse(JSON.stringify(p.weeks[wi])) }; C.toast("Week copied. Open any week or client and paste."); redraw(); break;
    case "pg-pasteweek": if (PG.clip && PG.clip.type === "week") mutate(p => { p.weeks[wi] = copyWeek(PG.clip.data, p.weeks[wi].label); }); break;
    case "pg-addsess": mutate(p => { const n = p.weeks[wi].sessions.length; p.weeks[wi].sessions.push(newSession("Day " + String.fromCharCode(65 + Math.min(n, 25)))); }); break;
    case "pg-copysess": PG.clip = { type: "session", data: JSON.parse(JSON.stringify(p.weeks[wi].sessions[si])) }; C.toast("Session copied. Paste it into any week."); redraw(); break;
    case "pg-pastesess": if (PG.clip && PG.clip.type === "session") mutate(p => p.weeks[wi].sessions.push(copySession(PG.clip.data))); break;
    case "pg-delsess": mutate(p => p.weeks[wi].sessions.splice(si, 1)); break;
    case "pg-up": if (si > 0) mutate(p => { const ss = p.weeks[wi].sessions; [ss[si - 1], ss[si]] = [ss[si], ss[si - 1]]; }); break;
    case "pg-repeat": PG.repeat = el.getAttribute("data-week") ? { week: true, n: 3 } : { s: si, n: 3 }; redraw(); break;
    case "pg-repeat-x": PG.repeat = null; redraw(); break;
    case "pg-repeat-go": {
      const n = Math.max(1, Math.min(52, parseInt(valIn("pg-rep-n"), 10) || 1)), R = PG.repeat; PG.repeat = null;
      const next = R.week ? repeatWeek(p, wi, n) : repeatSession(p, wi, R.s, n);
      p.weeks = next.weeks; saveSoon(p); redraw(); C.toast(`Copied into the next ${n} week${n === 1 ? "" : "s"}`); break; }
    case "pg-addrow": mutate(p => p.weeks[wi].sessions[si].rows.push(newRow())); break;
    case "pg-delrow": mutate(p => p.weeks[wi].sessions[si].rows.splice(ri, 1)); break;
    case "pg-log": PG.logFor = { w: wi, s: si }; logSheet(); break;
    case "pg-logsave": {
      const s = p.weeks[PG.logFor.w].sessions[PG.logFor.s], date = valIn("lg-date") || today(), byKey = {};
      document.querySelectorAll("[data-lg]").forEach(i => { const k = i.getAttribute("data-lg"); const o = byKey[k] || (byKey[k] = {}); o[i.getAttribute("data-f")] = i.type === "checkbox" ? i.checked : i.value; });
      const names = Object.fromEntries(s.rows.map(r => [r.id, r.name]));
      const rows = Object.entries(byKey).filter(([, v]) => v.done || v.reps !== "" || v.weight !== "").map(([k, v]) => { const [row_id, set] = k.split("|");
        return { program_id: p.id, session_id: s.id, row_id, set_no: +set, client_id: p.clientId, ex_name: names[row_id] || "", reps: num(v.reps), weight: num(v.weight), done: !!v.done || num(v.reps) != null, logged_on: date }; });
      try { await C.A.programs.saveLogs(rows, p.shared ? p.ownerId : undefined); C.closeModal(); C.toast("Logged"); loadClient(PG.clientId); } catch (x){ C.toast("Couldn't save the log"); }
      break; }
    case "pg-vid": videoSheet(el.getAttribute("data-id")); break;
    case "pg-exnew": PG.edEx = { name: "", sets: "", reps: "" }; PG.confirm = null; exSheet(); break;
    case "pg-exedit": PG.edEx = JSON.parse(JSON.stringify((PG.lib || []).find(x => x.id === el.getAttribute("data-id")) || {})); exSheet(); break;
    case "pg-exrmvid": { const e = PG.edEx; if (e.videoPath){ C.A.programs.deleteVideo(e.videoPath).catch(() => {}); delete e.videoPath; } exSheet(); break; }
    case "pg-exsave": {
      const e = { ...PG.edEx, name: valIn("ex-name").trim(), muscle: valIn("ex-muscle").trim(), equipment: valIn("ex-eq").trim(), sets: valIn("ex-sets").trim(), reps: valIn("ex-reps").trim(), cues: valIn("ex-cues").trim(), videoUrl: valIn("ex-url").trim() };
      if (!e.name){ C.toast("Add a name"); break; }
      if (!e.id) e.id = pid("ex");
      const f = document.getElementById("ex-file"), file = f && f.files && f.files[0];
      el.disabled = true;
      try {
        if (file){
          if (file.size > 52428800){ C.toast("That video is over 50 MB. Trim it or use a YouTube link."); el.disabled = false; break; }
          el.textContent = "Uploading…";
          const up = await C.A.programs.uploadVideo(file);
          if (e.videoPath) C.A.programs.deleteVideo(e.videoPath).catch(() => {});
          e.videoPath = up.path; if (up.localUrl) e.localUrl = up.localUrl;
        }
        delete e.localUrl;
        await C.A.programs.saveExercises([e]);
        if (file && PG.edEx.localUrl === undefined) {}
        const i = PG.lib.findIndex(x => x.id === e.id); if (i >= 0) PG.lib[i] = e; else PG.lib.push(e);
        PG.edEx = null; C.closeModal(); C.toast("Saved"); redraw();
      } catch (x){ C.toast("Couldn't save: " + (x.message || "try again")); el.disabled = false; el.textContent = "Save"; }
      break; }
    case "pg-exdel": { const id = PG.edEx.id, path = PG.edEx.videoPath; PG.lib = PG.lib.filter(x => x.id !== id); PG.edEx = null; C.closeModal(); redraw();
      C.A.programs.deleteExercise(id).then(() => { if (path) C.A.programs.deleteVideo(path).catch(() => {}); C.toast("Deleted"); }).catch(() => C.toast("Couldn't delete")); break; }
    case "pg-addmeas": {
      const c = client(PG.clientId);
      const m = { client_id: c.id, taken_on: valIn("pg-m-date") || today(), weight: num(valIn("pg-m-w")), triceps: num(valIn("pg-m-tri")), abdomen: num(valIn("pg-m-abd")), suprailiac: num(valIn("pg-m-sup")), thigh: num(valIn("pg-m-thi")), source: "trainer" };
      if ([m.weight, m.triceps, m.abdomen, m.suprailiac, m.thigh].every(v => v == null)){ C.toast("Enter a weight or skinfolds"); break; }
      m.body_fat = bodyFat4(m, c.sex, ageOn(c.birthYear, m.taken_on));
      try { await C.A.programs.saveMeasurement(m); C.toast("Measurement saved"); loadClient(c.id); } catch (x){ C.toast("Couldn't save"); }
      break; }
    case "pg-delmeas": { const id = el.getAttribute("data-id"), cid = PG.clientId; PG.meas[cid] = PG.meas[cid].filter(m => String(m.id) !== id); redraw(); C.A.programs.deleteMeasurement(id).catch(() => C.toast("Couldn't delete")); break; }
    case "pg-share": shareSheet(); break;
    case "pg-ai": PG.ai = { mode: el.getAttribute("data-mode"), step: "form", week: wi, session: el.getAttribute("data-s") != null ? si : null, direction: "", notes: "" }; aiSheet(); break;
    case "pg-ai-dir": PG.ai.notes = valIn("ai-notes"); PG.ai.direction = el.getAttribute("data-k"); aiSheet(); break;
    case "pg-ai-go": aiRun(); break;
    case "pg-ai-back": PG.ai.step = "form"; aiSheet(); break;
    case "pg-ai-accept": el.disabled = true; aiAccept(el.getAttribute("data-how")).catch(() => { el.disabled = false; C.toast("Couldn't add it"); }); break;
    case "pg-sharetr": PG.shareList = null; trainerShareSheet(); C.A.programs.sharing.list(p.id).then(l => { PG.shareList = l; trainerShareSheet(); }).catch(() => { PG.shareList = []; trainerShareSheet(); }); break;
    case "pg-sharetr-add": {
      const email = valIn("pg-tr-email").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ C.toast("Enter their Google email"); break; }
      const c = client(PG.clientId);
      try { await C.A.programs.sharing.add(p, email, c.name, (C.S.prof && C.S.prof.trainerName) || ""); PG.shareList = await C.A.programs.sharing.list(p.id); C.toast("Shared"); } catch (x){ C.toast("Couldn't share: " + (x.message || "try again")); }
      trainerShareSheet(); break; }
    case "pg-sharetr-rm": { const email = el.getAttribute("data-e"); try { await C.A.programs.sharing.remove(p.id, email); PG.shareList = (PG.shareList || []).filter(x => x.shared_email !== email); C.toast("Stopped sharing"); } catch (x){ C.toast("Couldn't remove"); } trainerShareSheet(); break; }
    case "pg-leave": { await C.A.programs.sharing.leave(p.ownerId, p.id).catch(() => {}); PG.shared = PG.shared.filter(x => x.id !== p.id); PG.clientId = null; redraw(); break; }
    case "pg-linkmake": { const id = PG.clientId; try { PG.link[id] = await C.A.programs.link.create(id); } catch (x){ C.toast("Couldn't create the link"); } shareSheet(); redraw(); break; }
    case "pg-linkoff": { const id = PG.clientId; try { await C.A.programs.link.revoke(id); PG.link[id] = false; C.toast("Link turned off"); } catch (x){ C.toast("Couldn't turn it off"); } shareSheet(); redraw(); break; }
    case "pg-linkcopy": { const t = document.getElementById("pg-link"); try { await navigator.clipboard.writeText(t.value); C.toast("Link copied"); } catch (x){ t.select(); } break; }
  }
}

function onInput(t){
  const k = t.getAttribute("data-pg"); if (!k) return false;
  const f = t.getAttribute("data-f"), si = +t.getAttribute("data-s"), ri = +t.getAttribute("data-r");
  if (k === "libq"){ PG.libQ = t.value; const pos = t.selectionStart; redraw(); const n = document.getElementById("pg-libq"); if (n){ n.focus(); try { n.setSelectionRange(pos, pos); } catch (x){} } return true; }
  if (k === "calc" || k === "who"){ updateBfPreview(); return true; }
  const p = P(); if (!p) return true;
  if (k === "prog"){ p[f] = t.value; saveSoon(p); return true; }
  if (k === "week"){ p.weeks[PG.week][f] = t.value; saveSoon(p); return true; }
  if (k === "sess" && t.type !== "checkbox"){ p.weeks[PG.week].sessions[si][f] = t.value; saveSoon(p); return true; }
  if (k === "row"){ p.weeks[PG.week].sessions[si].rows[ri][f] = t.value; saveSoon(p); return true; }
  return false;
}
function onChange(t){
  const k = t.getAttribute("data-pg"); if (!k) return false;
  const si = +t.getAttribute("data-s"), ri = +t.getAttribute("data-r");
  if (k === "progsel"){ PG.progId = t.value; PG.week = 0; redraw(); return true; }
  if (k === "cnotes"){ const c = client(PG.clientId); if (c && !c.shared && (c.programNotes || "") !== t.value){ C.saveClient({ ...c, programNotes: t.value.trim() }).then(() => C.toast("Notes saved")).catch(() => {}); } return true; }
  if (k === "lift"){ PG.lift = t.value; redraw(); return true; }
  if (k === "who"){ const c = client(PG.clientId); C.saveClient({ ...c, sex: valIn("pg-sex"), birthYear: num(valIn("pg-by")) }).catch(() => {}); return true; }
  const p = P(); if (!p) return true;
  if (k === "sess" && t.type === "checkbox"){ mutate(p => p.weeks[PG.week].sessions[si].homework = t.checked); return true; }
  if (k === "row" && t.getAttribute("data-f") === "name"){ mutate(p => fillFromLibrary(p.weeks[PG.week].sessions[si].rows[ri])); return true; }
  return true;
}
function updateBfPreview(){
  const c = client(PG.clientId), el = document.getElementById("pg-bf"); if (!c || !el) return;
  const sex = valIn("pg-sex") || c.sex, by = valIn("pg-by") || c.birthYear;
  const bf = bodyFat4({ triceps: valIn("pg-m-tri"), abdomen: valIn("pg-m-abd"), suprailiac: valIn("pg-m-sup"), thigh: valIn("pg-m-thi") }, sex, ageOn(by, valIn("pg-m-date")));
  el.innerHTML = bf != null ? `Body fat ≈ <b>${bf}%</b>` : "Body fat appears when all four sites, sex and birth year are filled in.";
}

const CSS = `
.pg-notes summary{cursor:pointer;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.pg-notes textarea{min-height:70px;resize:vertical}
.ai-dirs{display:flex;gap:6px;flex-wrap:wrap}
.ai-flags{border:1px solid color-mix(in srgb,var(--warn) 45%,var(--line));background:var(--warn-bg);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:5px;font-size:13.5px}
.ai-flags h3{color:var(--warn)}
.ai-sess{border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:8px;display:flex;flex-direction:column;gap:6px}
.ai-rows td{padding:5px 6px}.ai-list{margin:0;padding-left:18px;font-size:13.5px;display:flex;flex-direction:column;gap:3px}
.pg-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pg-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.pg-in{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 9px;min-width:0;width:100%}
.pg-row .pg-in{width:auto}
.pg-title{font-weight:700;font-size:16px;width:min(360px,100%)!important}
.pg-sname{font-weight:600;width:min(260px,100%)!important}
.pg-weeks{display:flex;gap:6px;flex-wrap:wrap}
.pg-weeks button{border:1px solid var(--line);background:var(--surface);border-radius:20px;padding:4px 12px;font-size:12.5px;font-weight:600;color:var(--ink2)}
.pg-weeks button[aria-selected="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.pg-sess.hw{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));box-shadow:inset 3px 0 0 var(--accent)}
.pg-rows td{padding:4px 4px;border-bottom:0}.pg-rows th{padding:4px}
.pg-rows td:nth-child(2){min-width:190px}.pg-rows td:nth-child(6){min-width:120px}
.pg-exname{display:flex;gap:4px;align-items:center}
.pg-new{font-size:10.5px;color:var(--muted);border:1px dashed var(--line);border-radius:5px;padding:0 4px}
.pg-repeat{display:inline-flex;gap:6px;align-items:center;font-size:13px;flex-wrap:wrap}
.pg-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
@media (max-width:700px){.pg-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pg-grid .field input,.pg-grid .field select{border:1px solid var(--line);background:var(--bg);border-radius:9px;padding:8px 10px;width:100%}
.lg-ex{border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px}
.lg-h{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.lg-set{display:grid;grid-template-columns:48px 1fr 1fr auto;gap:6px;align-items:center}
`;

function attach(ctx){ C = ctx; }
function preload(){ if (!PG.ready && !PG.loading && C && C.A.programs) load(); }
window.TallyPrograms = { attach, render, onClick, onInput, onChange, state: PG, todos, todoText, preload };
