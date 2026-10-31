/* A client's private program page: their program and videos, homework (pick one, "Do this workout", it's logged on the day they do it),
 * sessions left / booked, bodyweight and progress charts.
 * Two ways in: the program link (/p/<token>), or the client app (/c/<key>), where the client signs in once with a 4-digit code
 * and can tap any session date to flag it for the trainer. ?demo=maya&app shows the client app on sample data (any code works). */
import { sessionCards, sessionsLine } from "./sessions-view.js";
import { clientProgramView, weekZero, setCount, lineChart, LINECHART_CSS, videoEmbed, VIDEO_CSS, grpClass, GROUP_CSS, repsFor, timedPlan } from "./programs-core.js";

const $m = document.getElementById("m");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const q = new URLSearchParams(location.search);
const token = (location.pathname.match(/\/p\/([A-Za-z0-9_-]+)/) || [])[1] || q.get("t") || "";
const demo = q.get("demo");
const appKey = (location.pathname.match(/\/c\/([A-Za-z0-9_-]+)/) || [])[1] || (demo && q.has("app") ? "demo" : "");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const fmt = d => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); };
const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
document.head.insertAdjacentHTML("beforeend", `<style>${LINECHART_CSS}${VIDEO_CSS}${GROUP_CSS}.ex.g{border-left:4px solid var(--g);padding-left:10px;margin-left:-2px}</style>`);

let V = null, demoStore = null, SI = null;
const st = { prog: 0, week: null, tab: "program", open: {}, draft: {}, lift: "", doing: null, flag: null };
const flagMap = () => Object.fromEntries((V.flags || []).map(f => [f.at, f]));

function toast(msg){ const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
const logsFor = (pid, sid) => { const o = {}; for (const l of V.logs) if (l.p === pid && l.s === sid) o[l.r + "|" + l.n] = l; return o; };

function currentWeek(p){
  if (!p.startDate || !p.weeks.length) return 0;
  const i = Math.floor((Date.now() - weekZero(p).getTime()) / (7 * 86400000));
  return Math.max(0, Math.min(p.weeks.length - 1, i));
}

function render(){
  document.title = `${V.first}'s program`;
  const head = `<div><h1>Hi ${esc(V.first)}</h1><p class="sub">${V.trainer ? `Your program from ${esc(V.trainer)}` : "Your program"}</p></div>
    <div class="seg" role="group" aria-label="View">${[["program", "Program"], ...(V.sessions ? [["sessions", "Sessions"]] : []), ["progress", "Progress"]].map(([k, l]) => `<button data-act="tab" data-k="${k}" aria-pressed="${st.tab === k}">${l}</button>`).join("")}</div>`;
  const sessions = () => `<div class="sv">${appKey ? `<p class="note" style="margin:0">Something look wrong? Tap the date and let ${esc(V.trainer || "your trainer")} know.</p>` : ""}${sessionCards(V.sessions, { tap: !!appKey, flags: appKey ? flagMap() : {}, due: true })}</div>`;
  $m.innerHTML = head + homeTip() + (st.tab === "progress" ? renderProgress() : st.tab === "sessions" && V.sessions ? sessions() : renderProgram())
    + `<footer>Trainer Tally${appKey ? ` · <button class="linkbtn" data-act="signout">Sign out</button>` : ""}</footer>` + (st.flag ? flagSheet() : "");
}

/* ---------- client app: sign in, home screen tip, flagging a session ---------- */
function renderSignin(){
  const who = SI.trainer || "your trainer";
  document.title = "Sign in";
  $m.innerHTML = `<div class="card signin"><h1>Hi ${esc(SI.first || "there")}</h1>
    <p class="sub" style="margin:0">Enter the 4-digit code ${esc(who)} sent you. You only need it once on this phone.</p>
    <input id="code" class="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="4" placeholder="••••" aria-label="4-digit code" value="${esc(SI.typed || "")}">
    ${SI.err ? `<p class="note warn" role="alert" style="margin:0">${esc(SI.err)}</p>` : ""}
    <button class="btn primary wide" data-act="signin" ${SI.busy ? "disabled" : ""}>${SI.busy ? "Checking…" : "Sign in"}</button>
    <p class="note" style="margin:0;text-align:center">${SI.sent ? `A new code is on its way to ${esc(SI.sent)}.` : SI.canEmail ? `Forgot it? <button class="linkbtn" data-act="emailcode">Email me a new code</button>${SI.emailHint ? ` <span class="muted">(${esc(SI.emailHint)})</span>` : ""}` : `Forgot it? Ask ${esc(who)} for a new one.`}</p></div>
    <footer>Trainer Tally</footer>`;
  const c = document.getElementById("code"); if (c){ c.focus(); }
}
async function signin(){
  const code = (document.getElementById("code").value || "").replace(/\D/g, "");
  SI.typed = code;
  if (code.length !== 4){ SI.err = "The code is 4 digits."; return renderSignin(); }
  SI.busy = true; SI.err = ""; renderSignin();
  try {
    if (demo){ localStorage.setItem("tt-demo-in", "1"); }
    else await appPost({ action: "login", code });
    SI = null; localStorage.removeItem("tt-tip-off"); await load();
  } catch (x){ SI.busy = false; SI.err = x.message; SI.typed = ""; renderSignin(); }
}
function homeTip(){
  if (!appKey || localStorage.getItem("tt-tip-off")) return "";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return `<div class="card tip"><b>Keep this one tap away</b><span class="note">${ios ? "Tap the Share button, then <b>Add to Home Screen</b>." : "Open your browser menu, then <b>Add to Home screen</b> (or bookmark this page)."} You'll stay signed in.</span>
    <button class="btn" data-act="tipoff">Got it</button></div>`;
}
const FLAG_REASONS = ["Canceled early", "Session never happened", "Wrong date or time", "Something else"];
function flagSheet(){
  const F = st.flag, tz = V.sessions && V.sessions.timeZone || undefined, cur = flagMap()[F.at];
  const when = new Date(F.at).toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
  const body = cur && cur.resolved
    ? `<p class="note" style="margin:0">You flagged this: <b>${esc(cur.reason)}</b>${cur.note ? ` · ${esc(cur.note)}` : ""}</p><p class="note" style="margin:0"><span class="due paid">sorted</span> ${cur.reply ? esc(cur.reply) : `${esc(V.trainer || "Your trainer")} has looked at it.`}</p>
      <button class="btn wide" data-act="flagclose">Close</button>`
    : `<p class="note" style="margin:0">What's wrong with this one? ${esc(V.trainer || "Your trainer")} will see it and sort it out.</p>
      <div class="reasons" role="radiogroup" aria-label="Reason">${FLAG_REASONS.map(r => `<button role="radio" aria-checked="${F.reason === r}" data-act="flagreason" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>
      <textarea id="flag-note" rows="2" placeholder="${F.reason === "Something else" ? "What happened?" : "Add a note (optional)"}" aria-label="Note">${esc(F.note || "")}</textarea>
      <div class="row"><button class="btn" data-act="flagclose">Cancel</button>${cur ? `<button class="btn" data-act="unflag">Take it back</button>` : ""}<button class="btn primary" data-act="flagsend" style="margin-left:auto" ${F.reason && !F.busy ? "" : "disabled"}>${F.busy ? "Sending…" : cur ? "Update" : "Send"}</button></div>`;
  return `<div class="scrim" data-act="flagclose"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Flag this session"><h2>${esc(when)}</h2>${body}</div>`;
}

function renderProgram(){
  if (!V.programs.length) return `<div class="card"><div class="empty">Your trainer hasn't added a program yet.</div></div>`;
  const p = V.programs[Math.min(st.prog, V.programs.length - 1)];
  if (st.week == null) st.week = currentWeek(p);
  const wk = p.weeks[Math.min(st.week, p.weeks.length - 1)];
  const pick = V.programs.length > 1 ? `<select data-act="prog" aria-label="Program">${V.programs.map((x, i) => `<option value="${i}" ${i === st.prog ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : `<h3>${esc(p.name)}</h3>`;
  const tabs = `<div class="tabs" role="tablist">${p.weeks.map((w, i) => `<button role="tab" aria-selected="${i === st.week}" data-act="week" data-i="${i}">${esc(w.label || "Week " + (i + 1))}</button>`).join("")}</div>`;
  const studio = wk ? wk.sessions.filter(s => !s.homework) : [];
  return sessionsStrip() + renderHomework(p) + pick + tabs + (studio.length ? studio.map(s => renderSession(p, s)).join("") : `<div class="card"><div class="empty">${V.trainer ? `Your sessions with ${esc(V.trainer)}` : "Your sessions"} show here once they're written.</div></div>`);
}
/* Sessions left (or this month) and the next booking, tapping through to the Sessions tab. */
function sessionsStrip(){
  if (!V.sessions) return "";
  const L = sessionsLine(V.sessions);
  return `<button class="strip ${L.warn ? "warn" : ""}" data-act="tab" data-k="sessions"><span><b>${esc(L.text)}</b>${L.due ? ` <span class="due">${V.sessions.billing === "package" ? "package due" : "payment due"}</span>` : ""}${L.next ? `<span class="muted"> · next ${esc(L.next)}</span>` : ""}</span><span aria-hidden="true">›</span></button>`;
}
/* Homework isn't tied to a day: the client picks a workout, taps "Do this workout", and it's logged on the day they do it.
 * Shows this week's homework, or the latest week before it that has some. */
function renderHomework(p){
  const now = currentWeek(p); let list = [];
  for (let i = now; i >= 0 && !list.length; i--) list = (p.weeks[i] ? p.weeks[i].sessions : []).filter(s => s.homework && s.rows.length);
  if (!list.length) return "";
  return `<h3>Homework · on your own</h3>${list.map(s => renderSession(p, s)).join("")}<h3 style="margin-top:6px">Sessions with ${esc(V.trainer || "your trainer")}</h3>`;
}

function renderSession(p, s){
  const logged = logsFor(p.id, s.id), any = Object.values(logged);
  const doneOn = any.length ? any.map(l => l.date).sort().pop() : null;
  const draft = st.draft[s.id] || (st.draft[s.id] = {});
  const exs = s.rows.map(r => {
    const ex = r.exId && V.exercises[r.exId], open = st.open[s.id + r.id];
    const rx = [r.sets && r.reps ? `${esc(r.sets)} × ${esc(r.reps)}` : esc(r.reps || r.sets), r.weight ? `@ ${esc(r.weight)}` : ""].filter(Boolean).join(" ");
    let sets = "";
    if (s.homework && st.doing === s.id){
      sets = `<div class="sets">${Array.from({ length: setCount(r) }, (_, k) => { const key = r.id + "|" + (k + 1), l = draft[key] || {};
        return `<div class="set"><span class="lbl">Set ${k + 1}</span>
          <input type="number" inputmode="numeric" placeholder="${timedPlan(r) ? "Secs" : "Reps"}${repsFor(r, k) ? " (" + repsFor(r, k) + ")" : ""}" aria-label="Set ${k + 1} ${timedPlan(r) ? "seconds" : "reps"}" data-act="set" data-s="${s.id}" data-k="${esc(key)}" data-f="reps" value="${esc(l.reps ?? "")}">
          <input type="number" inputmode="decimal" step="0.5" placeholder="Weight${r.weight ? " (" + esc(r.weight) + ")" : ""}" aria-label="Set ${k + 1} weight" data-act="set" data-s="${s.id}" data-k="${esc(key)}" data-f="weight" value="${esc(l.weight ?? "")}">
          <button class="chk" data-act="done" data-s="${s.id}" data-k="${esc(key)}" aria-pressed="${!!l.done}" aria-label="Set ${k + 1} done">${CHECK}</button></div>`; }).join("")}</div>`;
    }
    return `<div class="ex${r.group ? " g " + grpClass(r.group) : ""}"><div class="ex-h"><button class="ex-name" data-act="open" data-k="${esc(s.id + r.id)}" aria-expanded="${!!open}">${r.group ? `<span class="gchip ${grpClass(r.group)}">${esc(r.group)}</span>` : ""}<span>${esc(r.name)}</span>${ex && (ex.video || ex.cues) ? `<span class="play">${ex.video ? "▶ video" : "cues"}</span>` : ""}</button><span class="rx">${rx}</span></div>
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
      ${open && ex ? `<div class="detail">${ex.video ? videoEmbed(ex.video) : ""}${ex.cues ? `<div class="note">${esc(ex.cues)}</div>` : ""}</div>` : ""}
      ${sets}</div>`;
  }).join("");
  const doing = s.homework && st.doing === s.id, when = d => d === today() ? "today" : fmt(d);
  // Sessions with the trainer and homework look different: a label and a coloured edge.
  const kind = s.homework ? (s.wasSession ? "Session canceled · do it on your own" : "On your own") : `With ${V.trainer || "your trainer"}${s.day != null ? " · " + DAYS[s.day] : ""}`;
  return `<section class="card ${s.homework ? "hw" : "studio"} ${doing ? "doing" : ""}" id="s-${esc(s.id)}"><span class="kind">${esc(kind)}</span><div class="sess-h"><h2>${esc(s.name)}</h2>${s.homework ? (doneOn ? `<span class="badge done">Done ${esc(when(doneOn))}</span>` : "") : doneOn ? `<span class="badge done">Done ${esc(fmt(doneOn))}</span>` : ""}</div>
    ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ""}
    ${exs || `<div class="empty">No exercises yet.</div>`}
    ${s.homework && s.rows.length ? (doing
      ? `<div class="row"><label class="lbl" for="d-${s.id}">Done on</label><input type="date" id="d-${s.id}" value="${today()}" max="${today()}"><button class="btn" data-act="stop" style="margin-left:auto">Cancel</button><button class="btn primary" data-act="save" data-s="${s.id}">Save workout</button></div>`
      : `<button class="btn primary wide" data-act="do" data-s="${s.id}">${doneOn ? "Do it again" : "Do this workout"}</button>`) : ""}
  </section>`;
}

function renderProgress(){
  const w = V.measurements.filter(m => m.weight != null).map(m => ({ date: m.date, value: m.weight }));
  const bf = V.measurements.filter(m => m.bodyFat != null).map(m => ({ date: m.date, value: m.bodyFat }));
  const H = {};
  for (const l of V.logs){ if (l.weight == null || !l.ex) continue; const day = (H[l.ex] = H[l.ex] || {}); if (!day[l.date] || l.weight > day[l.date]) day[l.date] = l.weight; }
  const names = Object.keys(H).sort((a, b) => Object.keys(H[b]).length - Object.keys(H[a]).length || a.localeCompare(b));
  if (!st.lift || !H[st.lift]) st.lift = names[0] || "";
  const lift = st.lift ? Object.entries(H[st.lift]).map(([date, value]) => ({ date, value })) : [];
  return `<section class="card"><h3>Log your weight</h3>
      <div class="row"><input type="number" id="bw" inputmode="decimal" step="0.1" placeholder="Weight" style="width:120px"><input type="date" id="bw-d" value="${today()}"><button class="btn primary" data-act="bw">Save</button></div></section>
    <section class="card"><div class="sess-h"><h2>Bodyweight</h2><span class="muted small">${w.length ? "latest " + w[w.length - 1].value : ""}</span></div>${lineChart(w)}</section>
    ${bf.length ? `<section class="card"><div class="sess-h"><h2>Body fat</h2><span class="muted small">latest ${bf[bf.length - 1].value}%</span></div>${lineChart(bf, { unit: "%" })}</section>` : ""}
    <section class="card"><div class="sess-h"><h2>Lifts</h2>${names.length ? `<select data-act="lift" aria-label="Exercise">${names.map(n => `<option ${n === st.lift ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>` : ""}</div>
      ${names.length ? lineChart(lift) + `<p class="muted small" style="margin:0">Heaviest set each day.</p>` : `<div class="empty">Weights you log show up here.</div>`}</section>`;
}

/* ---------- actions ---------- */
async function appPost(body){
  const r = await fetch("/api/client-app", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ k: appKey, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok){ if (j.signin && body.action !== "login"){ SI = { first: V && V.first, trainer: V && V.trainer }; V = null; renderSignin(); } throw new Error(j.message || "Couldn't save."); }
  return j;
}
async function post(body){
  if (demo){ demoPost(body); return { ok: true }; }
  if (appKey) return appPost(body);
  const r = await fetch("/api/program", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: token, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || "Couldn't save.");
  return j;
}
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const a = el.getAttribute("data-act");
  if (SI){
    if (a === "signin") signin();
    else if (a === "emailcode"){
      el.disabled = true;
      try { const j = demo ? { to: "m•••@example.com" } : await appPost({ action: "email" }); SI.sent = j.to || "your email"; SI.err = ""; }
      catch (x){ SI.err = x.message; }
      renderSignin();
    }
    return;
  }
  if (!V) return;
  if (a === "tipoff"){ localStorage.setItem("tt-tip-off", "1"); render(); return; }
  if (a === "signout"){ if (demo) localStorage.removeItem("tt-demo-in"); else await appPost({ action: "logout" }).catch(() => {}); V = null; st.tab = "program"; return load(); }
  if (a === "flag"){ const at = el.getAttribute("data-at"), cur = flagMap()[at]; st.flag = { at, reason: cur && !cur.resolved ? cur.reason : null, note: cur && !cur.resolved ? cur.note : "" }; render(); const sh = document.querySelector(".sheet button[data-act=flagreason]"); if (sh) sh.focus(); return; }
  if (a === "flagclose"){ st.flag = null; render(); return; }
  if (a === "flagreason"){ st.flag.note = (document.getElementById("flag-note") || {}).value || ""; st.flag.reason = el.getAttribute("data-r"); render(); const n = document.getElementById("flag-note"); if (n && st.flag.reason === "Something else") n.focus(); return; }
  if (a === "flagsend" || a === "unflag"){
    const F = st.flag; F.note = (document.getElementById("flag-note") || {}).value || ""; F.busy = true; render();
    try { await post(a === "unflag" ? { action: "unflag", session_at: F.at } : { action: "flag", session_at: F.at, reason: F.reason, note: F.note.trim() });
      st.flag = null; toast(a === "unflag" ? "Taken back" : `Sent to ${V.trainer || "your trainer"}`); await load(true); }
    catch (x){ F.busy = false; render(); toast(x.message); }
    return;
  }
  if (a === "tab"){ st.tab = el.getAttribute("data-k"); render(); }
  else if (a === "week"){ st.week = +el.getAttribute("data-i"); render(); }
  else if (a === "do"){ const sid = el.getAttribute("data-s"); st.doing = sid; st.draft[sid] = {}; render(); const c = document.getElementById("s-" + sid); if (c) c.scrollIntoView({ block: "start", behavior: "smooth" }); }
  else if (a === "stop"){ st.doing = null; render(); }
  else if (a === "open"){ const k = el.getAttribute("data-k"); st.open[k] = !st.open[k]; render(); }
  else if (a === "done"){ const s = el.getAttribute("data-s"), k = el.getAttribute("data-k"); const d = (st.draft[s][k] = st.draft[s][k] || {}); d.done = !d.done; el.setAttribute("aria-pressed", String(d.done)); }
  else if (a === "save"){
    const sid = el.getAttribute("data-s"), p = V.programs[st.prog], d = st.draft[sid] || {};
    const sets = Object.entries(d).map(([k, v]) => { const [row_id, n] = k.split("|"); return { row_id, set_no: +n, reps: v.reps ?? null, weight: v.weight ?? null, done: !!v.done || (v.reps != null && v.reps !== "") }; });
    if (!sets.length){ toast("Fill in a set first"); return; }
    el.disabled = true; el.textContent = "Saving…";
    try { await post({ action: "log", program_id: p.id, session_id: sid, logged_on: document.getElementById("d-" + sid).value, sets }); st.draft[sid] = {}; st.doing = null; toast("Workout saved. Nice work!"); await load(true); }
    catch (x){ toast(x.message); el.disabled = false; el.textContent = "Save workout"; }
  }
  else if (a === "bw"){
    const w = parseFloat(document.getElementById("bw").value); if (!isFinite(w)){ toast("Enter your weight"); return; }
    el.disabled = true;
    try { await post({ action: "weight", weight: w, taken_on: document.getElementById("bw-d").value }); toast("Saved"); await load(true); } catch (x){ toast(x.message); el.disabled = false; }
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && st.flag && V){ st.flag = null; render(); } });
document.addEventListener("input", e => {
  const el = e.target;
  if (SI && el.id === "code"){ el.value = el.value.replace(/\D/g, "").slice(0, 4); if (el.value.length === 4) signin(); return; }
  if (el.getAttribute("data-act") !== "set") return;
  const s = el.getAttribute("data-s"), k = el.getAttribute("data-k");
  const d = (st.draft[s][k] = st.draft[s][k] || {});
  d[el.getAttribute("data-f")] = el.value === "" ? null : Number(el.value);
});
document.addEventListener("change", e => {
  const a = e.target.getAttribute("data-act");
  if (a === "prog"){ st.prog = +e.target.value; st.week = null; render(); }
  if (a === "lift"){ st.lift = e.target.value; render(); }
});

/* ---------- load ---------- */
async function load(quiet){
  if (appKey && demo && !localStorage.getItem("tt-demo-in")){ SI = { first: "Maya", trainer: "Alex", canEmail: true, emailHint: "m•••@example.com" }; return renderSignin(); }
  if (demo){
    if (!demoStore){ const { buildProgramsDemo } = await import("./programs-demo.js"); demoStore = buildProgramsDemo(); }
    V = clientProgramView({ client: { name: "Maya Chen", sex: "female", birthYear: new Date().getFullYear() - 34 }, trainerName: "Alex", programs: demoStore.programs.filter(p => p.clientId === demo), exercises: demoStore.exercises, logs: demoStore.logs, measurements: demoStore.measurements });
    try { const E = await import("./engine.js"); globalThis.TallyEngine = E; const { buildDemo } = await import("./demo-data.js"), { demoModel } = await import("./demo-core.js");
      const D = buildDemo(), b = E.clientView(demoModel(D, D.profile, D.clients), demo); if (b) V.sessions = b; } catch (x){}
    if (appKey) V.flags = demoStore.flags || (demoStore.flags = []);
    return render();
  }
  try {
    const r = await fetch(appKey ? "/api/client-app?k=" + encodeURIComponent(appKey) : "/api/program?t=" + encodeURIComponent(token), { credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.signin){ SI = j; V = null; return renderSignin(); }
    if (!r.ok) throw new Error(j.message || "Couldn't load this page.");
    V = j; render();
  } catch (x){ if (!quiet) $m.innerHTML = `<div class="card"><h1 style="font-size:18px">Can't show this page</h1><p class="note">${esc(x.message)}</p></div>`; else toast(x.message); }
}
function demoPost(b){
  if (b.action === "flag" || b.action === "unflag"){ const F = demoStore.flags = demoStore.flags || [], i = F.findIndex(f => f.at === b.session_at && !f.resolved); if (i >= 0) F.splice(i, 1);
    if (b.action === "flag"){ if (b.reason === "Something else" && !b.note) throw new Error("Add a short note so your trainer knows what's up."); F.push({ at: b.session_at, reason: b.reason, note: b.note || "", resolved: false }); } }
  if (b.action === "weight") demoStore.measurements.push({ id: "c" + Date.now(), client_id: demo, taken_on: b.taken_on, weight: b.weight, source: "client" });
  if (b.action === "log") for (const s of b.sets){ const row = { program_id: b.program_id, session_id: b.session_id, row_id: s.row_id, set_no: s.set_no, client_id: demo, reps: s.reps, weight: s.weight, done: s.done, logged_on: b.logged_on, source: "client",
    ex_name: (() => { for (const p of demoStore.programs) for (const w of p.weeks) for (const x of w.sessions) for (const r of x.rows) if (r.id === s.row_id) return r.name; return ""; })() };
    const i = demoStore.logs.findIndex(l => l.program_id === row.program_id && l.session_id === row.session_id && l.row_id === row.row_id && l.set_no === row.set_no); if (i >= 0) demoStore.logs[i] = row; else demoStore.logs.push(row); }
}
load();
