/* A client's private program page: their program and videos, homework (pick one, "Do this workout", it's logged on the day they do it),
 * sessions left / booked, bodyweight and progress charts.
 * Two ways in: the program link (/p/<token>), or the client app (/c/<key>), where the client signs in once with a 4-digit code
 * and can tap any session date to flag it for the trainer. ?demo=maya&app shows the client app on sample data (any code works). */
import { sessionCards, sessionsLine } from "./sessions-view.js";
import { clientProgramView, sessionForDate, suggestWorkout, adaptRows, EQUIPMENT, findSession, weekZero, setCount, lineChart, LINECHART_CSS, videoEmbed, VIDEO_CSS, grpClass, GROUP_CSS, repsFor, timedPlan } from "./programs-core.js";

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
const st = { prog: 0, week: null, tab: "calendar", calScroll: true, hwHist: false, histOpen: null, open: {}, draft: {}, lift: "", doing: null, doingOn: null, flag: null, view: "list", calOpen: null, vary: false, plain: false };
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
    <div class="seg" role="group" aria-label="View">${[["calendar", "Calendar"], ["homework", "Homework"], ["metrics", "Metrics"], ...(V.sessions ? [["billing", "Billing"]] : [])].map(([k, l]) => `<button data-act="tab" data-k="${k}" aria-pressed="${st.tab === k}">${l}</button>`).join("")}</div>`;
  const sessions = () => `<div class="sv">${appKey ? `<p class="note" style="margin:0">Something look wrong? Tap the date and let ${esc(V.trainer || "your trainer")} know.</p>` : ""}${sessionCards(V.sessions, { tap: !!appKey, flags: appKey ? flagMap() : {}, due: true })}</div>`;
  const body = st.tab === "metrics" ? renderProgress() : st.tab === "billing" && V.sessions ? sessions() : st.tab === "homework" ? renderHomeworkTab() : renderCalendar();
  document.body.classList.toggle("wide", st.tab === "calendar");
  $m.innerHTML = head + homeTip() + body
    + `<footer>Trainer Tally${appKey ? ` · <button class="linkbtn" data-act="signout">Sign out</button>` : ""}</footer>` + (st.flag ? flagSheet() : st.add ? addSheet() : "");
  if (st.tab === "calendar" && st.calScroll){ st.calScroll = false; const t = document.querySelector(".cal-wk.now"); if (t) t.scrollIntoView({ block: "start" }); }
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

/* Booked session dates from the billing view, used to place sessions with the trainer on the calendar. */
const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
function bookedDates(){
  const v = V.sessions; if (!v) return [];
  const all = [...(v.recent || []), ...(v.next || [])];
  if (v.pack) all.push(...v.pack.done, ...v.pack.booked);
  for (const O of v.owed || []) all.push(...O.done);
  if (v.nextPack) all.push(...v.nextPack.done, ...v.nextPack.booked);
  for (const m of v.months || []) all.push(...m.done.map(x => x.at), ...m.booked.map(x => x.at));
  return [...new Set(all)].map(x => new Date(x));
}
/* The full calendar, laid out like the trainer's: each week is a row of day boxes, every workout shows its first exercises.
 * Sessions with the trainer are solid, homework is dashed. Tap one to open it in its day (that day widens).
 * Homework not done yet waits under the week. "+ Add" on a day suggests a workout that fits around the sessions. */
function renderCalendar(){
  if (!V.programs.length) return `<div class="card"><div class="empty">Your trainer hasn't added a program yet.</div></div>`;
  const p = V.programs[Math.min(st.prog, V.programs.length - 1)];
  if (!p.startDate) return `<div class="card"><div class="empty">Nothing on the calendar yet.</div></div>`;
  const z = weekZero(p), booked = bookedDates(), last = Math.max(0, ...booked.map(b => Math.floor((b - z) / (7 * 864e5) + 0.01)));
  const n = Math.max(p.weeks.length, last + 1), cur = Math.floor((Date.now() - z) / (7 * 864e5));
  const pick = V.programs.length > 1 ? `<select data-act="prog" aria-label="Program">${V.programs.map((x, i) => `<option value="${i}" ${i === st.prog ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : "";
  const step = `<div class="cal-step" role="group" aria-label="Weeks"><button class="btn sm" data-act="calstep" data-d="-1" aria-label="Previous week">‹</button><button class="btn sm" data-act="calstep" data-d="0">This week</button><button class="btn sm" data-act="calstep" data-d="1" aria-label="Next week">›</button>
    <span class="cal-key"><i class="k-s"></i>With ${esc(V.trainer || "your trainer")}<i class="k-h"></i>On your own</span></div>`;
  return sessionsStrip() + pick + step + Array.from({ length: n }, (_, wi) => renderWeek(p, wi, booked, wi === cur)).join("");
}
const srTxt = r => r.sets && r.reps ? `${r.sets}×${r.reps}` : r.reps || r.sets || "";
function renderWeek(p, wi, booked, isNow){
  const z = weekZero(p), w = p.weeks[wi], days = Array.from({ length: 7 }, (_, i) => new Date(z.getFullYear(), z.getMonth(), z.getDate() + wi * 7 + i));
  const now = today(), sessions = w ? w.sessions || [] : [];
  const hw = sessions.filter(s => s.homework && s.rows.length && !s.byClient), mine = sessions.filter(s => s.byClient);
  const doneOn = {}; for (const l of V.logs) if (l.p === p.id) (doneOn[l.s] = doneOn[l.s] || new Set()).add(l.date);
  const card = (s, key, when, done) => st.calOpen === key
    ? `<div class="cal-open"><div class="cal-obar">${when ? `<span class="muted small">${esc(when)}</span>` : ""}<button class="btn sm" data-act="calclose" aria-label="Close ${esc(s.name)}">✕ Close</button></div>${renderSession(p, s, key)}</div>`
    : `<button class="cal-s ${s.homework ? "hw" : ""} ${done ? "done" : ""}" data-act="calgo" data-k="${esc(key)}" aria-label="Open ${esc(s.name)}">
        <span class="cal-t">${done ? `<i aria-hidden="true">✓</i>` : ""}${when ? `<span class="muted">${esc(when)}</span> ` : ""}<b>${esc(s.name)}</b></span>
        ${s.rows.slice(0, 4).map(r => `<span class="cal-ex"><span class="gchip ${grpClass(r.group)}">${esc(r.group || "·")}</span><span class="cal-n">${esc(r.name)}</span><span class="muted">${esc(srTxt(r))}</span></span>`).join("")}
        ${s.rows.length > 4 ? `<span class="muted">+${s.rows.length - 4} more</span>` : ""}</button>`;
  let anyOpen = false;
  const cells = days.map(d => {
    const k = ymd(d), its = [];
    for (const b of booked.filter(b => ymd(b) === k)){ const hit = sessionForDate(p, b, booked), t = b.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      its.push(hit && hit.weekIndex === wi ? card(hit.session, k + "|" + hit.session.id, t, doneOn[hit.session.id] && doneOn[hit.session.id].has(k))
        : `<div class="cal-s flat"><span class="cal-t"><span class="muted">${esc(t)}</span> <b>Session</b></span><span class="muted">With ${esc(V.trainer || "your trainer")}</span></div>`); }
    for (const s of hw) if (doneOn[s.id] && doneOn[s.id].has(k)) its.push(card(s, k + "|" + s.id, "", true));
    for (const s of mine) if (s.on === k) its.push(card(s, k + "|" + s.id, "", doneOn[s.id]));
    const open = !!(st.calOpen && st.calOpen.startsWith(k + "|")); if (open) anyOpen = true;
    const add = appKey && w && k >= ymd(new Date(Date.now() - 7 * 864e5)) && !open ? `<button class="cal-add" data-act="addopen" data-d="${k}" aria-label="Add a workout on ${esc(d.toDateString())}">+ Add</button>` : "";
    return `<div class="cal-d ${its.length ? "has" : ""} ${open ? "open" : ""} ${k === now ? "today" : ""} ${k < now ? "past" : ""}"><div class="cal-dn"><span>${d.toLocaleDateString("en-US", { weekday: "short" })}</span><b>${d.getDate()}</b></div>${its.join("")}${add}</div>`;
  }).join("");
  const todo = hw.filter(s => !doneOn[s.id]), todoOpen = todo.find(s => st.calOpen === "todo|" + s.id);
  return `<section class="card cal-wk ${isNow ? "now" : ""}" data-wi="${wi}"><div class="cal-h"><b>${esc(w ? w.label || "Week " + (wi + 1) : "After this program")}</b><span class="muted small">${esc(fmtR(days[0], days[6]))}</span>${isNow ? `<span class="tag">this week</span>` : ""}</div>
    <div class="cal-days ${anyOpen ? "editing" : ""}">${cells}</div>
    ${todo.length ? `<div class="cal-left ${todoOpen ? "open" : ""}"><span class="muted small">Homework this week · any day</span>${todo.map(s => card(s, "todo|" + s.id, "", false)).join("")}</div>` : ""}</section>`;
}

/* ---------- adding a workout from the calendar ---------- */
/* The trainer sessions just before and after a day, so the suggestion fits around them. */
function around(p, k){
  const booked = bookedDates().sort((a, b) => a - b), at = b => { const h = sessionForDate(p, b, booked); return h ? h.session : null; };
  const before = booked.filter(b => ymd(b) < k).reverse().map(at).find(Boolean) || null, after = booked.filter(b => ymd(b) > k).map(at).find(Boolean) || null;
  return { last: before, next: after };
}
async function suggest(){
  const A = st.add, p = V.programs[Math.min(st.prog, V.programs.length - 1)], { last, next } = around(p, A.date);
  A.busy = true; A.err = ""; render();
  try {
    const j = await post({ action: "suggest", program_id: p.id, on_date: A.date, last_id: last && last.id, next_id: next && next.id, seed: A.seed, equipment: eqNow() || undefined });
    if (!j.workout) throw new Error(j.message || "Couldn't come up with one. Try again.");
    A.workout = j.workout; A.last = last && last.name; A.next = next && next.name;
  } catch (x){ A.err = x.message; }
  A.busy = false; render();
}
function addSheet(){
  const A = st.add, when = new Date(A.date + "T12:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }), W = A.workout;
  const body = A.busy && !W ? `<div class="skel" style="height:160px"></div><p class="note" style="margin:0;text-align:center">Putting a workout together around your sessions…</p>`
    : W ? `<p class="note" style="margin:0">${esc(W.why || "")}</p>
      <div class="sug">${W.rows.map((r, i) => `<div class="sug-r"><span class="gchip ${grpClass(r.group)}">${esc(r.group)}</span><span class="sug-n"><b>${esc(r.name)}</b>${r.note ? `<span class="muted small">${esc(r.note)}</span>` : ""}</span><span class="rx">${esc(r.sets)} × ${esc(r.reps)}</span><button class="btn sm" data-act="sugdel" data-i="${i}" aria-label="Take out ${esc(r.name)}">✕</button></div>`).join("")}</div>
      <div class="row"><button class="btn" data-act="addclose">Cancel</button><button class="btn" data-act="sugmore" ${A.busy ? "disabled" : ""}>${A.busy ? "Thinking…" : "Another idea"}</button><button class="btn primary" data-act="addsave" style="margin-left:auto" ${A.saving || !W.rows.length ? "disabled" : ""}>${A.saving ? "Adding…" : "Add to my calendar"}</button></div>`
    : `<div class="row"><button class="btn" data-act="addclose">Cancel</button><button class="btn primary" data-act="sugmore" style="margin-left:auto">Try again</button></div>`;
  return `<div class="scrim" data-act="addclose"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Add a workout"><h2>Workout for ${esc(when)}</h2>${eqPicker()}${A.err ? `<p class="note warn" role="alert" style="margin:0">${esc(A.err)}</p>` : ""}${body}</div>`;
}

const fmtR = (a, b) => a.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " – " + b.toLocaleDateString("en-US", a.getMonth() === b.getMonth() ? { day: "numeric" } : { month: "short", day: "numeric" });

/* Sessions left (or this month) and the next booking, tapping through to the Sessions tab. */
function sessionsStrip(){
  if (!V.sessions) return "";
  const L = sessionsLine(V.sessions);
  return `<button class="strip ${L.warn ? "warn" : ""}" data-act="tab" data-k="billing"><span><b>${esc(L.text)}</b>${L.due ? ` <span class="due">${V.sessions.billing === "package" ? "package due" : "payment due"}</span>` : ""}${L.next ? `<span class="muted"> · next ${esc(L.next)}</span>` : ""}</span><span aria-hidden="true">›</span></button>`;
}
/* Homework tab: just the next one to do. Homework from this week (or the latest week that has some) comes first,
 * then workouts the client added, soonest first. History lists every homework done, newest first; tap one to see or change it. */
function homeworkQueue(p){
  const done = new Set(V.logs.filter(l => l.p === p.id).map(l => l.s)), now = currentWeek(p), t = today();
  let set = [];
  for (let i = now; i >= 0 && !set.length; i--) set = (p.weeks[i] ? p.weeks[i].sessions : []).filter(s => s.homework && s.rows.length && !s.byClient);
  const mine = p.weeks.flatMap(w => w.sessions || []).filter(s => s.byClient && s.on >= t).sort((a, b) => a.on.localeCompare(b.on));
  return [...set, ...mine].filter(s => !done.has(s.id));
}
function renderHomeworkTab(){
  if (!V.programs.length) return `<div class="card"><div class="empty">Your trainer hasn't added a program yet.</div></div>`;
  const p = V.programs[Math.min(st.prog, V.programs.length - 1)];
  const seg = `<div class="seg sm" role="group" aria-label="Homework" style="align-self:flex-start"><button data-act="hwview" data-k="next" aria-pressed="${!st.hwHist}">Next up</button><button data-act="hwview" data-k="hist" aria-pressed="${!!st.hwHist}">History</button></div>`;
  if (st.hwHist){
    const by = {}; for (const l of V.logs) if (l.p === p.id){ const k = l.date + "|" + l.s; (by[k] = by[k] || []).push(l); }
    const all = p.weeks.flatMap(w => w.sessions || []), find = id => all.find(s => s.id === id);
    const list = Object.keys(by).map(k => { const [date, sid] = k.split("|"); return { k, date, s: find(sid), n: by[k].length }; }).filter(x => x.s && x.s.homework).sort((a, b) => b.date.localeCompare(a.date));
    if (!list.length) return seg + `<div class="card"><div class="empty">Homework you do shows up here.</div></div>`;
    return seg + list.map(x => st.histOpen === x.k
      ? `<div class="cal-open"><div class="cal-obar"><span class="muted small">${esc(fmt(x.date))}</span><button class="btn sm" data-act="histopen" data-k="" aria-label="Close">✕ Close</button></div>${renderSession(p, x.s, x.k)}</div>`
      : `<button class="hist" data-act="histopen" data-k="${esc(x.k)}"><span class="hist-d">${esc(new Date(x.date + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }))}</span><b>${esc(x.s.name)}</b><span class="muted small">${x.n} set${x.n === 1 ? "" : "s"}</span><span aria-hidden="true">›</span></button>`).join("");
  }
  const q = homeworkQueue(p), next = q[0];
  if (!next) return seg + `<div class="card"><div class="empty">You're all caught up. ${appKey ? `Add a workout from the <button class="linkbtn" data-act="tab" data-k="calendar">Calendar</button>, or do one again from History.` : ""}</div></div>`;
  return seg + renderSession(p, next) + (q.length > 1 ? `<p class="muted small" style="margin:0;text-align:center">${q.length - 1} more after this one</p>` : "");
}

/* ---------- equipment ---------- */
/* The client's usual equipment is saved with their app; a different pick just for today stays on this device for the day. null = never picked. */
const eqDayKey = () => "tt-eq-" + today();
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (x){ return null; } };
const eqUsual = () => demo ? lsGet("tt-eq-usual") : (V.prefs && Array.isArray(V.prefs.equipment) ? V.prefs.equipment : null);
const eqNow = () => lsGet(eqDayKey()) || eqUsual();
const sameSet = (a, b) => (a || []).slice().sort().join() === (b || []).slice().sort().join();
function eqPicker(){
  const cur = eqNow() || [], usual = eqUsual(), today_ = lsGet(eqDayKey());
  return `<div class="eq"><div class="eq-h"><b>Equipment you have today</b>${usual && today_ && !sameSet(today_, usual) ? `<button class="linkbtn small" data-act="equsual">Make this my usual</button>` : usual ? `<span class="muted small">Saved</span>` : `<span class="muted small">Pick once, we'll remember</span>`}</div>
    <div class="eq-c">${EQUIPMENT.filter(([k]) => k !== "bodyweight").map(([k, l]) => `<button class="chip" data-act="eq" data-k="${k}" aria-pressed="${cur.includes(k)}">${esc(l)}</button>`).join("")}</div></div>`;
}
async function setEquipment(list, usual){
  if (usual || !eqUsual()){ try { localStorage.removeItem(eqDayKey()); } catch (x){}
    if (demo) localStorage.setItem("tt-eq-usual", JSON.stringify(list)); else { V.prefs = { ...(V.prefs || {}), equipment: list }; post({ action: "prefs", equipment: list }).catch(x => toast(x.message)); } }
  else try { localStorage.setItem(eqDayKey(), JSON.stringify(list)); } catch (x){}
}
/* A homework's rows for today: swapped to equivalents for the equipment picked, and varied on a repeat. */
function rowsFor(p, s){
  const eq = eqNow(); if (!s.homework || st.doing !== s.id || st.plain || (!eq && !st.vary)) return s.rows;
  const lib = Object.entries(V.exercises || {}).map(([id, e]) => ({ id, ...e })), times = new Set(Object.values(logsFor(p.id, s.id)).map(l => l.date)).size;
  return adaptRows(s.rows, eq || EQUIPMENT.map(e => e[0]), { library: lib, vary: st.vary, seed: times });
}

/* calKey "YYYY-MM-DD|sid": opened from the Calendar on that day. A homework done that day can be changed there. */
function renderSession(p, s, calKey){
  const calDay = calKey && /^\d{4}-/.test(calKey) ? calKey.slice(0, 10) : null;
  const logged = logsFor(p.id, s.id), any = Object.values(logged);
  const doneOn = any.length ? any.map(l => l.date).sort().pop() : null;
  const draft = st.draft[s.id] || (st.draft[s.id] = {});
  const rows = rowsFor(p, s), swapped = rows.some(r => r.swappedFrom || r.cantDo);
  const exs = rows.map(r => {
    const ex = r.exId && V.exercises[r.exId], open = st.open[s.id + r.id];
    const rx = [r.sets && r.reps ? `${esc(r.sets)} × ${esc(r.reps)}` : esc(r.reps || r.sets), r.weight ? `@ ${esc(r.weight)}` : ""].filter(Boolean).join(" ");
    let sets = "";
    if (s.homework && st.doing === s.id){
      sets = `<div class="sets">${Array.from({ length: setCount(r) }, (_, k) => { const key = r.id + "|" + (k + 1), l = draft[key] || {};
        return `<div class="set"><span class="lbl">Set ${k + 1}</span>
          <input type="number" inputmode="numeric" placeholder="${timedPlan(r) ? "Secs" : "Reps"}${repsFor(r, k) ? " (" + repsFor(r, k) + ")" : ""}" aria-label="Set ${k + 1} ${timedPlan(r) ? "seconds" : "reps"}" data-act="set" data-s="${s.id}" data-k="${esc(key)}" data-f="reps" value="${esc(l.reps ?? "")}">
          <input type="number" inputmode="decimal" step="0.5" placeholder="Weight${r.weight ? " (" + esc(r.weight) + ")" : ""}" aria-label="Set ${k + 1} weight" data-act="set" data-s="${s.id}" data-k="${esc(key)}" data-f="weight" value="${esc(l.weight ?? "")}">
          <button class="chk" data-act="done" data-s="${s.id}" data-k="${esc(key)}" aria-pressed="${!!l.done}" aria-label="Set ${k + 1} done">${CHECK}</button></div>`; }).join("")}</div>`;
    } else if (calDay){ // what was logged that day: weight × reps
      const ls = V.logs.filter(l => l.p === p.id && l.s === s.id && l.r === r.id && l.date === calDay && (l.reps != null || l.weight != null)).sort((a, b) => a.n - b.n);
      if (ls.length) sets = `<div class="logged">${ls.map(l => `<span>${l.weight != null && l.weight !== "" ? esc(l.weight) + "×" : ""}${esc(l.reps ?? "")}${l.timed ? "s" : ""}</span>`).join("")}</div>`;
    }
    return `<div class="ex${r.group ? " g " + grpClass(r.group) : ""}"><div class="ex-h"><button class="ex-name" data-act="open" data-k="${esc(s.id + r.id)}" aria-expanded="${!!open}">${r.group ? `<span class="gchip ${grpClass(r.group)}">${esc(r.group)}</span>` : ""}<span>${esc(r.name)}</span>${ex && (ex.video || ex.cues) ? `<span class="play">${ex.video ? "▶ video" : "cues"}</span>` : ""}</button><span class="rx">${rx}</span></div>
      ${r.swappedFrom ? `<div class="note swap">Instead of ${esc(r.swappedFrom)}</div>` : ""}${r.cantDo ? `<div class="note warn">Needs equipment you didn't pick. Skip it or do what you can.</div>` : ""}
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
      ${open && ex ? `<div class="detail">${ex.video ? videoEmbed(ex.video) : ""}${ex.cues ? `<div class="note">${esc(ex.cues)}</div>` : ""}</div>` : ""}
      ${sets}</div>`;
  }).join("");
  const doing = s.homework && st.doing === s.id, when = d => d === today() ? "today" : fmt(d);
  // Sessions with the trainer and homework look different: a label and a coloured edge.
  const kind = s.homework ? (s.byClient ? "Added by you" : s.wasSession ? "Session canceled · do it on your own" : "On your own") : `With ${V.trainer || "your trainer"}${s.day != null ? " · " + DAYS[s.day] : ""}`;
  return `<section class="card ${s.homework ? "hw" : "studio"} ${doing ? "doing" : ""}" id="s-${esc(s.id)}"><span class="kind">${esc(kind)}</span><div class="sess-h"><h2>${esc(s.name)}</h2>${s.homework ? (doneOn ? `<span class="badge done">Done ${esc(when(doneOn))}</span>` : "") : doneOn ? `<span class="badge done">Done ${esc(fmt(doneOn))}</span>` : ""}</div>
    ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ""}
    ${doing && !st.doingOn ? eqPicker() + `<div class="row eq-opts">${st.again ? `<button class="chip" data-act="vary" aria-pressed="${st.vary}">Mix it up</button>` : ""}${swapped || st.plain ? `<button class="chip" data-act="plain" aria-pressed="${st.plain}">Show the original</button>` : ""}${st.vary && !st.plain ? `<span class="muted small">Same movements, different exercises from last time</span>` : ""}</div>` : ""}
    ${exs || `<div class="empty">No exercises yet.</div>`}
    ${s.homework && s.rows.length ? (doing
      ? `<div class="row"><label class="lbl" for="d-${s.id}">Done on</label><input type="date" id="d-${s.id}" value="${st.doingOn || today()}" max="${today()}"><button class="btn" data-act="stop" style="margin-left:auto">Cancel</button><button class="btn primary" data-act="save" data-s="${s.id}">Save workout</button></div>`
      : doneOn ? `<div class="row"><button class="btn" data-act="edit" data-s="${s.id}" data-d="${esc(calDay && any.some(l => l.date === calDay) ? calDay : doneOn)}" style="flex:1">Change what I logged</button><button class="btn primary" data-act="do" data-s="${s.id}" style="flex:1">Do it again</button></div>`
      : `<button class="btn primary wide" data-act="do" data-s="${s.id}">Do this workout</button>`) : ""}
    ${s.byClient && !doing ? `<button class="linkbtn small" data-act="mine-del" data-s="${s.id}" style="align-self:flex-start">Remove from my calendar</button>` : ""}
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
  if (demo){ const r = demoPost(body); if (body.action === "suggest") await new Promise(z => setTimeout(z, 500)); return r || { ok: true }; }
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
  if (a === "signout"){ if (demo) localStorage.removeItem("tt-demo-in"); else await appPost({ action: "logout" }).catch(() => {}); V = null; st.tab = "calendar"; st.calScroll = true; return load(); }
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
  if (a === "tab"){ st.tab = el.getAttribute("data-k"); st.calOpen = null; st.doing = null; st.calScroll = st.tab === "calendar"; render(); if (st.tab !== "calendar") window.scrollTo({ top: 0 }); }
  else if (a === "week"){ st.week = +el.getAttribute("data-i"); render(); }
  else if (a === "do" || a === "edit"){ const sid = el.getAttribute("data-s"); st.doing = sid; st.doingOn = a === "edit" ? el.getAttribute("data-d") : null; st.plain = false;
    st.again = a === "do" && Object.keys(logsFor(V.programs[st.prog].id, sid)).length > 0; st.vary = st.again;
    // Changing a logged workout starts from what was saved (one entry per set, so saving again replaces it).
    st.draft[sid] = {}; if (a === "edit"){ const L = logsFor(V.programs[st.prog].id, sid); for (const [k, l] of Object.entries(L)) st.draft[sid][k] = { reps: l.reps, weight: l.weight, done: l.done }; }
    render(); const c = document.getElementById("s-" + sid); if (c) c.scrollIntoView({ block: "start", behavior: "smooth" }); }
  else if (a === "eq"){ const k = el.getAttribute("data-k"), cur = (eqNow() || []).slice(), i = cur.indexOf(k); if (i >= 0) cur.splice(i, 1); else cur.push(k);
    await setEquipment(cur); if (st.add){ st.add.workout = null; suggest(); } else render(); }
  else if (a === "equsual"){ await setEquipment(eqNow() || [], true); toast("Saved as your usual"); render(); }
  else if (a === "vary"){ st.vary = !st.vary; render(); }
  else if (a === "plain"){ st.plain = !st.plain; render(); }
  else if (a === "stop"){ st.doing = null; st.doingOn = null; render(); }
  else if (a === "addopen"){ st.add = { date: el.getAttribute("data-d"), seed: 0 }; st.calOpen = null; st.doing = null; suggest(); }
  else if (a === "addclose"){ st.add = null; render(); }
  else if (a === "sugmore"){ st.add.seed = (st.add.seed || 0) + 1; suggest(); }
  else if (a === "sugdel"){ st.add.workout.rows.splice(+el.getAttribute("data-i"), 1); render(); }
  else if (a === "addsave"){
    const A = st.add, p = V.programs[Math.min(st.prog, V.programs.length - 1)]; A.saving = true; render();
    try { const j = await post({ action: "addWorkout", program_id: p.id, on_date: A.date, workout: A.workout }); st.add = null; toast("Added to your calendar"); await load(true); st.calOpen = A.date + "|" + (j.id || ""); render(); }
    catch (x){ A.saving = false; A.err = x.message; render(); }
  }
  else if (a === "mine-del"){ if (!confirm("Remove this workout from your calendar?")) return;
    try { await post({ action: "removeWorkout", session_id: el.getAttribute("data-s") }); st.calOpen = null; toast("Removed"); await load(true); } catch (x){ toast(x.message); } }
  else if (a === "calgo"){ st.calOpen = el.getAttribute("data-k"); st.doing = null; render(); const c = document.querySelector(".cal-open"); if (c) c.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  else if (a === "hwview"){ st.hwHist = el.getAttribute("data-k") === "hist"; st.histOpen = null; st.doing = null; render(); }
  else if (a === "histopen"){ st.histOpen = el.getAttribute("data-k") || null; st.doing = null; render(); }
  else if (a === "calstep"){ const secs = [...document.querySelectorAll(".cal-wk")], d = +el.getAttribute("data-d"); if (!secs.length) return;
    const top = el.closest(".cal-step").getBoundingClientRect().bottom + 4, cur = Math.max(0, secs.findIndex(x => x.getBoundingClientRect().bottom > top + 40));
    const to = d === 0 ? (document.querySelector(".cal-wk.now") || secs[0]) : secs[Math.max(0, Math.min(secs.length - 1, cur + d))]; to.scrollIntoView({ block: "start", behavior: "smooth" }); }
  else if (a === "calclose"){ st.calOpen = null; st.doing = null; render(); }
  else if (a === "open"){ const k = el.getAttribute("data-k"); st.open[k] = !st.open[k]; render(); }
  else if (a === "done"){ const s = el.getAttribute("data-s"), k = el.getAttribute("data-k"); const d = (st.draft[s][k] = st.draft[s][k] || {}); d.done = !d.done; el.setAttribute("aria-pressed", String(d.done)); }
  else if (a === "save"){
    const sid = el.getAttribute("data-s"), p = V.programs[st.prog], d = st.draft[sid] || {};
    const sets = Object.entries(d).map(([k, v]) => { const [row_id, n] = k.split("|"); return { row_id, set_no: +n, reps: v.reps ?? null, weight: v.weight ?? null, done: !!v.done || (v.reps != null && v.reps !== "") }; });
    if (!sets.length){ toast("Fill in a set first"); return; }
    const swaps = {}; for (const r of rowsFor(p, (findSession(p, sid) || {}).session || { rows: [] })) if (r.swappedFrom) swaps[r.id] = r.name;
    el.disabled = true; el.textContent = "Saving…";
    try { await post({ action: "log", program_id: p.id, session_id: sid, logged_on: document.getElementById("d-" + sid).value, sets, swaps }); st.draft[sid] = {}; st.doing = null; st.doingOn = null; if (st.calOpen) st.calOpen = null; toast("Workout saved. Nice work!"); await load(true); }
    catch (x){ toast(x.message); el.disabled = false; el.textContent = "Save workout"; }
  }
  else if (a === "bw"){
    const w = parseFloat(document.getElementById("bw").value); if (!isFinite(w)){ toast("Enter your weight"); return; }
    el.disabled = true;
    try { await post({ action: "weight", weight: w, taken_on: document.getElementById("bw-d").value }); toast("Saved"); await load(true); } catch (x){ toast(x.message); el.disabled = false; }
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && (st.flag || st.add) && V){ st.flag = null; st.add = null; render(); } });
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
    V = clientProgramView({ client: { name: "Maya Chen", sex: "female", birthYear: new Date().getFullYear() - 34 }, trainerName: "Alex", programs: demoStore.programs.filter(p => p.clientId === demo), exercises: demoStore.exercises, logs: demoStore.logs, measurements: demoStore.measurements, clientWorkouts: demoStore.clientWorkouts || [] });
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
  if (b.action === "suggest"){ const p = demoStore.programs.find(x => x.id === b.program_id), f = id => { const x = id && findSession(p, id); return x ? x.session : null; };
    return { workout: suggestWorkout({ last: f(b.last_id), next: f(b.next_id), library: demoStore.exercises, seed: b.seed || 0, equipment: b.equipment }), by: "planner" }; }
  if (b.action === "addWorkout"){ const id = "cw" + Date.now(); (demoStore.clientWorkouts = demoStore.clientWorkouts || []).push({ id, program_id: b.program_id, on_date: b.on_date, data: JSON.parse(JSON.stringify(b.workout)) }); return { ok: true, id }; }
  if (b.action === "removeWorkout"){ demoStore.clientWorkouts = (demoStore.clientWorkouts || []).filter(w => w.id !== b.session_id); return { ok: true }; }
  if (b.action === "flag" || b.action === "unflag"){ const F = demoStore.flags = demoStore.flags || [], i = F.findIndex(f => f.at === b.session_at && !f.resolved); if (i >= 0) F.splice(i, 1);
    if (b.action === "flag"){ if (b.reason === "Something else" && !b.note) throw new Error("Add a short note so your trainer knows what's up."); F.push({ at: b.session_at, reason: b.reason, note: b.note || "", resolved: false }); } }
  if (b.action === "weight") demoStore.measurements.push({ id: "c" + Date.now(), client_id: demo, taken_on: b.taken_on, weight: b.weight, source: "client" });
  if (b.action === "log") for (const s of b.sets){ const row = { program_id: b.program_id, session_id: b.session_id, row_id: s.row_id, set_no: s.set_no, client_id: demo, reps: s.reps, weight: s.weight, done: s.done, logged_on: b.logged_on, source: "client",
    ex_name: (() => { for (const p of demoStore.programs) for (const w of p.weeks) for (const x of w.sessions) for (const r of x.rows) if (r.id === s.row_id) return (b.swaps && b.swaps[r.id]) || r.name; return ""; })() };
    const i = demoStore.logs.findIndex(l => l.program_id === row.program_id && l.session_id === row.session_id && l.row_id === row.row_id && l.set_no === row.set_no); if (i >= 0) demoStore.logs[i] = row; else demoStore.logs.push(row); }
}
load();
