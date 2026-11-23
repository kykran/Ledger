/* A client's private program page: their program and videos, homework (pick one, "Do this workout", it's logged on the day they do it),
 * sessions left / booked, bodyweight and progress charts.
 * Two ways in: the program link (/p/<token>), or the client app (/c/<key>), where the client signs in once with a 4-digit code
 * and can tap any session date to flag it for the trainer. ?demo=maya&app shows the client app on sample data (any code works). */
import { sessionCards, sessionsLine } from "./sessions-view.js";
import { clientProgramView, sessionForDate, askWorkout, swapOptions, SWAP_REASONS, adaptRows, EQUIPMENT, findSession, weekZero, setCount, lineChart, LINECHART_CSS, videoEmbed, VIDEO_CSS, grpClass, GROUP_CSS, repsFor, timedPlan } from "./programs-core.js";

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
const st = { prog: 0, week: null, tab: "program", open: {}, draft: {}, lift: "", doing: null, doingOn: null, flag: null, view: "list", calOpen: null, vary: false, plain: false, swaps: {}, swap: null };
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
    <div class="seg" role="group" aria-label="View">${[["program", "Program"], ["calendar", "Calendar"], ["metrics", "Metrics"], ...(V.sessions ? [["billing", "Billing"]] : [])].map(([k, l]) => `<button data-act="tab" data-k="${k}" aria-pressed="${st.tab === k}">${l}</button>`).join("")}</div>`;
  const sessions = () => `<div class="sv">${appKey ? `<p class="note" style="margin:0">Something look wrong? Tap the date and let ${esc(V.trainer || "your trainer")} know.</p>` : ""}${sessionCards(V.sessions, { tap: !!appKey, flags: appKey ? flagMap() : {}, due: true })}</div>`;
  const body = st.tab === "metrics" ? renderProgress() : st.tab === "billing" && V.sessions ? sessions() : st.tab === "calendar" ? renderCalendar() : renderProgram();
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

function renderProgram(){
  if (!V.programs.length) return `<div class="card"><div class="empty">Your trainer hasn't added a program yet.</div></div>`;
  const p = V.programs[Math.min(st.prog, V.programs.length - 1)];
  if (st.week == null) st.week = currentWeek(p);
  const wk = p.weeks[Math.min(st.week, p.weeks.length - 1)];
  const pick = V.programs.length > 1 ? `<select data-act="prog" aria-label="Program">${V.programs.map((x, i) => `<option value="${i}" ${i === st.prog ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : `<h3>${esc(p.name)}</h3>`;
  const tabs = `<div class="tabs" role="tablist">${p.weeks.map((w, i) => `<button role="tab" aria-selected="${i === st.week}" data-act="week" data-i="${i}">${esc(w.label || "Week " + (i + 1))}</button>`).join("")}</div>`;
  const studio = wk ? wk.sessions.filter(s => !s.homework) : [];
  return sessionsStrip() + makeBtn() + renderHomework(p) + pick + tabs + (studio.length ? studio.map(s => renderSession(p, s)).join("") : `<div class="card"><div class="empty">${V.trainer ? `Your sessions with ${esc(V.trainer)}` : "Your sessions"} show here once they're written.</div></div>`);
}
/* Calendar: one week, a row per day. Sessions with the trainer sit on their booked days (same matching as the trainer's Calendar),
 * homework sits on the day it was done, and homework not done yet waits under the week. Tap one to open it right there. */
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
/* The full calendar: every week of the program (and any booked weeks after it), current week first in view.
 * Workouts the client added sit on their day. "+ Add" on a day suggests one from the sessions before and after it. */
function renderCalendar(){
  if (!V.programs.length) return `<div class="card"><div class="empty">Your trainer hasn't added a program yet.</div></div>`;
  const p = V.programs[Math.min(st.prog, V.programs.length - 1)];
  if (!p.startDate) return `<div class="card"><div class="empty">Nothing on the calendar yet.</div></div>`;
  const z = weekZero(p), booked = bookedDates(), last = Math.max(0, ...booked.map(b => Math.floor((b - z) / (7 * 864e5) + 0.01)));
  const n = Math.max(p.weeks.length, last + 1), cur = Math.floor((Date.now() - z) / (7 * 864e5));
  const pick = V.programs.length > 1 ? `<select data-act="prog" aria-label="Program">${V.programs.map((x, i) => `<option value="${i}" ${i === st.prog ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : "";
  return pick + `<p class="note" style="margin:0">Tap a workout to open it.${appKey ? " Tap <b>+ Add</b> on a day to get a workout that fits around your sessions." : ""}</p>`
    + Array.from({ length: n }, (_, wi) => renderWeek(p, wi, booked, wi === cur)).join("");
}
function renderWeek(p, wi, booked, isNow){
  const z = weekZero(p), w = p.weeks[wi], days = Array.from({ length: 7 }, (_, i) => new Date(z.getFullYear(), z.getMonth(), z.getDate() + wi * 7 + i));
  const now = today(), sessions = w ? w.sessions || [] : [];
  const hw = sessions.filter(s => s.homework && s.rows.length && !s.byClient), mine = sessions.filter(s => s.byClient);
  const doneOn = {}; for (const l of V.logs) if (l.p === p.id) (doneOn[l.s] = doneOn[l.s] || new Set()).add(l.date);
  const item = (s, key, label) => { const open = st.calOpen === key, done = doneOn[s.id];
    return open ? `<div class="cal-open">${renderSession(p, s, key)}<button class="btn wide" data-act="calclose">Close</button></div>`
      : `<button class="cal-it ${s.homework ? "hw" : "studio"} ${s.byClient ? "mine" : ""}" data-act="calgo" data-k="${esc(key)}"><b>${esc(s.name)}${done && s.homework ? " ✓" : ""}</b><span>${esc(label)}</span></button>`; };
  const rows = days.map(d => {
    const k = ymd(d), its = [];
    for (const b of booked.filter(b => ymd(b) === k)){ const hit = sessionForDate(p, b, booked); const t = b.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      its.push(hit && hit.weekIndex === wi ? item(hit.session, k + "|" + hit.session.id, `With ${V.trainer || "your trainer"} · ${t}`) : `<div class="cal-it studio flat"><b>Session</b><span>With ${esc(V.trainer || "your trainer")} · ${esc(t)}</span></div>`); }
    for (const s of hw) if (doneOn[s.id] && doneOn[s.id].has(k)) its.push(item(s, k + "|" + s.id, "Homework · done"));
    for (const s of mine) if (s.on === k) its.push(item(s, k + "|" + s.id, doneOn[s.id] ? "Your own workout · done" : "Your own workout"));
    const add = appKey && k >= ymd(new Date(Date.now() - 7 * 864e5)) && w ? `<button class="cal-add" data-act="addopen" data-d="${k}" aria-label="Add a workout on ${esc(d.toDateString())}">+ Add</button>` : "";
    const opened = st.calOpen && st.calOpen.startsWith(k + "|");
    return `<div class="cal-day ${k === now ? "today" : ""} ${its.length ? "" : "empty"}"><div class="cal-d"><b>${d.toLocaleDateString("en-US", { weekday: "short" })}</b><span>${d.getDate()}</span></div><div class="cal-its">${its.join("")}${its.length ? (opened ? "" : add) : `<div class="cal-rest"><span class="muted small">Rest</span>${add}</div>`}</div></div>`;
  }).join("");
  const todo = hw.filter(s => !doneOn[s.id]);
  return `<section class="card cal cal-wk ${isNow ? "now" : ""}"><div class="cal-h"><b>${esc(w ? w.label || "Week " + (wi + 1) : "After this program")}</b><span class="muted small">${esc(fmtR(days[0], days[6]))}${isNow ? " · this week" : ""}</span></div>${rows}
    ${todo.length ? `<div class="cal-todo"><h3>Homework to do this week · any day</h3>${todo.map(s => item(s, "todo|" + s.id, "Homework · to do")).join("")}</div>` : ""}</section>`;
}

/* ---------- adding a workout from the calendar ---------- */
/* The trainer sessions just before and after a day, so the suggestion fits around them. */
function around(p, k){
  const booked = bookedDates().sort((a, b) => a - b), at = b => { const h = sessionForDate(p, b, booked); return h ? h.session : null; };
  const before = booked.filter(b => ymd(b) < k).reverse().map(at).find(Boolean) || null, after = booked.filter(b => ymd(b) > k).map(at).find(Boolean) || null;
  return { last: before, next: after };
}
/* Everything in the client's week around a day: sessions with the trainer (and whether they happened), homework (done or not),
 * and workouts they added. Sent with a suggestion so the new workout fills the week's gaps instead of repeating it. */
function weekContext(p, k){
  if (!p.startDate) return [];
  const z = weekZero(p), d0 = new Date(k + "T12:00"), wi = Math.floor((d0 - z) / (7 * 864e5) + 0.01), w = p.weeks[wi];
  const start = new Date(z.getFullYear(), z.getMonth(), z.getDate() + wi * 7), end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  const booked = bookedDates(), out = [], doneOn = {};
  for (const l of V.logs) if (l.p === p.id) (doneOn[l.s] = doneOn[l.s] || new Set()).add(l.date);
  const inWeek = x => { const y = ymd(x); return y >= ymd(start) && y < ymd(end); };
  for (const b of booked.filter(inWeek).sort((a, c) => a - c)){ const h = sessionForDate(p, b, booked); out.push({ id: h ? h.session.id : null, on: ymd(b), kind: "trainer", done: ymd(b) <= today() }); }
  for (const s of w ? w.sessions || [] : []){
    if (s.byClient){ if (s.on !== k) out.push({ id: s.id, on: s.on, kind: "added", done: !!doneOn[s.id] }); }
    else if (s.homework && s.rows.length){ const dd = [...(doneOn[s.id] || [])].filter(x => x >= ymd(start) && x < ymd(end)); out.push({ id: s.id, on: dd[0] || null, kind: "homework", done: dd.length > 0 }); }
  }
  return out.slice(0, 16);
}
async function suggest(){
  const A = st.add, p = V.programs[Math.min(st.prog, V.programs.length - 1)], { last, next } = around(p, A.date);
  A.busy = true; A.err = ""; st.swap = null; render();
  try {
    const j = await post({ action: "suggest", program_id: p.id, on_date: A.date, last_id: last && last.id, next_id: next && next.id, seed: A.seed, equipment: eqNow() || undefined, ask: A.ask || undefined, week: weekContext(p, A.date) });
    if (!j.workout) throw new Error(j.message || "Couldn't come up with one. Try again.");
    A.workout = j.workout; A.last = last && last.name; A.next = next && next.name;
  } catch (x){ A.err = x.message; }
  A.busy = false; render();
}
const QUICK = ["Legs", "Upper body", "Full body", "Core", "20 min"];
const hasWord = (t, w) => new RegExp("(^|[\\s,])" + w.replace(/ /g, "\\s+") + "($|[\\s,.])", "i").test(t || "");
function addSheet(){
  const A = st.add, when = A.date === today() ? "today" : new Date(A.date + "T12:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }), W = A.workout;
  const ask = `<div class="ask"><div class="row ask-in"><input id="ask" type="text" enterkeyhint="go" placeholder="Want something else? e.g. 30 min legs, knee is sore" aria-label="What do you want to do?" value="${esc(A.ask || "")}"><button class="btn" data-act="askgo" ${A.busy ? "disabled" : ""}>Go</button></div>
    <div class="eq-c">${QUICK.map(w => `<button class="chip" data-act="askchip" data-w="${esc(w)}" aria-pressed="${hasWord(A.ask, w)}">${esc(w)}</button>`).join("")}</div></div>`;
  const body = A.busy && !W ? `<div class="skel" style="height:160px"></div><p class="note" style="margin:0;text-align:center">${A.ask ? "Putting your workout together…" : "Putting a workout together around your sessions…"}</p>`
    : W ? `<p class="note" style="margin:0">${esc(W.why || "")}</p>
      <div class="sug">${W.rows.map((r, i) => `<div class="sug-w"><div class="sug-r"><span class="gchip ${grpClass(r.group)}">${esc(r.group)}</span><span class="sug-n"><b>${esc(r.name)}</b>${r.swappedFrom ? `<span class="small swap-t">Instead of ${esc(r.swappedFrom)}</span>` : r.note ? `<span class="muted small">${esc(r.note)}</span>` : ""}</span><span class="rx">${esc(r.sets)} × ${esc(r.reps)}${r.weight ? ` @ ${esc(r.weight)}` : ""}</span><button class="btn sm" data-act="swapopen" data-w="add" data-r="${i}" aria-expanded="${isSwap("add", i)}">Swap</button><button class="btn sm" data-act="sugdel" data-i="${i}" aria-label="Take out ${esc(r.name)}">✕</button></div>${isSwap("add", i) ? swapPanel(r) : ""}</div>`).join("")}</div>
      <div class="row"><button class="btn" data-act="addclose">Cancel</button><button class="btn" data-act="sugmore" ${A.busy ? "disabled" : ""}>${A.busy ? "Thinking…" : "Another idea"}</button><button class="btn primary" data-act="addsave" style="margin-left:auto" ${A.saving || !W.rows.length ? "disabled" : ""}>${A.saving ? "Adding…" : "Add to my calendar"}</button></div>`
    : `<div class="row"><button class="btn" data-act="addclose">Cancel</button><button class="btn primary" data-act="sugmore" style="margin-left:auto">Try again</button></div>`;
  return `<div class="scrim" data-act="addclose"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Add a workout"><h2>Workout for ${esc(when)}</h2>${eqLine()}${ask}${A.err ? `<p class="note warn" role="alert" style="margin:0">${esc(A.err)}</p>` : ""}${body}</div>`;
}
/* Program tab, client app: one button to get a workout for today. */
function makeBtn(){
  if (!appKey || !V.programs.length) return "";
  return `<button class="strip make" data-act="addopen" data-d="${today()}"><span><b>✦ Make me a workout</b><span class="muted"> · tell it what you feel like</span></span><span aria-hidden="true">›</span></button>`;
}

/* ---------- swapping one exercise ---------- */
/* st.swap = {w: "add" (a row of the workout being added) or a homework id, r: row index or id, reason, busy, options, err, note} */
const isSwap = (w, r) => !!st.swap && st.swap.w === String(w) && st.swap.r === String(r);
function swapPanel(r){
  const S = st.swap;
  const opts = S.busy ? `<div class="skel" style="height:44px"></div>`
    : S.options ? (S.options.length ? S.options.map((o, i) => `<button class="swap-o" data-act="swappick" data-i="${i}"><b>${esc(o.name)}</b><span class="rx">${esc(o.reps)}</span><span class="muted small">${esc(o.why || "")}</span></button>`).join("")
      : `<p class="note" style="margin:0">Couldn't find a good swap for this one. Skip it or ask ${esc(V.trainer || "your trainer")}.</p>`) : "";
  return `<div class="swap-p"><div class="eq-c">${SWAP_REASONS.map(([k, l]) => `<button class="chip" data-act="swapwhy" data-k="${k}" aria-pressed="${S.reason === k}">${esc(l)}</button>`).join("")}</div>
    ${S.reason === "hurts" || S.reason === "dislike" ? `<div class="row ask-in"><input id="swap-note" type="text" enterkeyhint="go" placeholder="${S.reason === "hurts" ? "What hurts? e.g. my knee" : "Tell us more (optional)"}" aria-label="Tell us more" value="${esc(S.note || "")}"><button class="btn sm" data-act="swapwhy" data-k="${S.reason}">Go</button></div>` : ""}
    ${S.err ? `<p class="note warn" role="alert" style="margin:0">${esc(S.err)}</p>` : ""}${opts}
    ${S.reason === "hurts" && S.options ? `<p class="note" style="margin:0">If it still hurts, stop and let ${esc(V.trainer || "your trainer")} know.</p>` : ""}</div>`;
}
async function fetchSwaps(row, others){
  const S = st.swap, p = V.programs[Math.min(st.prog, V.programs.length - 1)];
  S.busy = true; S.err = ""; S.options = null; render();
  try { const j = await post({ action: "swap", program_id: p.id, name: row.name, sets: row.sets, reps: row.reps, reason: S.reason, note: S.note || undefined, equipment: eqNow() || undefined, others });
    if (!Array.isArray(j.options)) throw new Error(j.message || "Couldn't find a swap. Try again.");
    if (st.swap === S) S.options = j.options; }
  catch (x){ S.err = x.message; }
  S.busy = false; render();
}
/* The row being swapped, and the other names in its workout (so a swap isn't a repeat). */
function swapTarget(){
  const S = st.swap; if (!S) return null;
  if (S.w === "add"){ const rows = st.add && st.add.workout ? st.add.workout.rows : []; return { row: rows[+S.r], others: rows.map(r => r.name) }; }
  const p = V.programs[Math.min(st.prog, V.programs.length - 1)], f = findSession(p, S.w), rows = f ? rowsFor(p, f.session) : [];
  return { row: rows.find(r => r.id === S.r), others: rows.map(r => r.name) };
}
function eqLine(){
  if (!eqUsual() || st.eqOpen) return eqPicker();
  const cur = eqNow() || [], names = EQUIPMENT.filter(([k]) => cur.includes(k) && k !== "bodyweight").map(e => e[1]);
  return `<div class="eq-h"><span class="small"><b>Equipment:</b> ${esc(names.join(", ") || "just my body")}</span><button class="linkbtn small" data-act="eqopen">Change</button></div>`;
}

const fmtR = (a, b) => a.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " – " + b.toLocaleDateString("en-US", a.getMonth() === b.getMonth() ? { day: "numeric" } : { month: "short", day: "numeric" });

/* Sessions left (or this month) and the next booking, tapping through to the Sessions tab. */
function sessionsStrip(){
  if (!V.sessions) return "";
  const L = sessionsLine(V.sessions);
  return `<button class="strip ${L.warn ? "warn" : ""}" data-act="tab" data-k="billing"><span><b>${esc(L.text)}</b>${L.due ? ` <span class="due">${V.sessions.billing === "package" ? "package due" : "payment due"}</span>` : ""}${L.next ? `<span class="muted"> · next ${esc(L.next)}</span>` : ""}</span><span aria-hidden="true">›</span></button>`;
}
/* Homework isn't tied to a day: the client picks a workout, taps "Do this workout", and it's logged on the day they do it.
 * Shows this week's homework, or the latest week before it that has some. */
function renderHomework(p){
  const now = currentWeek(p); let list = [];
  for (let i = now; i >= 0 && !list.length; i--) list = (p.weeks[i] ? p.weeks[i].sessions : []).filter(s => s.homework && s.rows.length && !s.byClient);
  if (!list.length) return `<h3>Your sessions with ${esc(V.trainer || "your trainer")}</h3>`;
  const lastOn = s => { const d = V.logs.filter(l => l.p === p.id && l.s === s.id).map(l => l.date).sort().pop(); return d || null; };
  const todo = list.filter(s => !lastOn(s)), done = list.filter(s => lastOn(s));
  const L = V.sessions ? sessionsLine(V.sessions) : null, by = L && L.next ? L.next.replace(/,? \d{1,2}:\d{2}.*$/, "") : "";
  // Homework gets its own box at the top: what's left this week, how to do it, and the ones already done folded to one line.
  const doneRow = s => st.hwShow === s.id ? renderSession(p, s)
    : `<button class="hw-done" data-act="hwshow" data-s="${esc(s.id)}"><span class="hw-tick" aria-hidden="true">✓</span><span><b>${esc(s.name)}</b><span class="muted small" style="display:block">Done ${esc(lastOn(s) === today() ? "today" : fmt(lastOn(s)))}</span></span><span class="muted small">See or redo ›</span></button>`;
  return `<section class="hwbox" aria-label="Your homework"><div class="hwbox-h"><h2>Your homework</h2><span class="pill ${todo.length ? "" : "ok"}">${todo.length ? `${done.length} of ${list.length} done` : "All done ✓"}</span></div>
    <p class="hwbox-how">${todo.length ? `Do ${todo.length === 1 ? "this" : "these"} on your own${by ? ` before ${esc(by)}` : " this week"}. Tap <b>Start</b>, fill in your sets, then <b>Save</b>.` : `Nice work. That's everything ${esc(V.trainer || "your trainer")} set for this week.`}</p>
    ${todo.map(s => renderSession(p, s)).join("")}${done.map(doneRow).join("")}</section>
    <h3 style="margin-top:6px">Your sessions with ${esc(V.trainer || "your trainer")}</h3>`;
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
  const eq = eqNow(); if (!s.homework || st.doing !== s.id || st.plain) return s.rows;
  const lib = Object.entries(V.exercises || {}).map(([id, e]) => ({ id, ...e })), times = new Set(Object.values(logsFor(p.id, s.id)).map(l => l.date)).size;
  const rows = !eq && !st.vary ? s.rows : adaptRows(s.rows, eq || EQUIPMENT.map(e => e[0]), { library: lib, vary: st.vary, seed: times });
  // Swaps the client picked by hand win.
  const mine = st.swaps[s.id] || {};
  return rows.map(r => mine[r.id] ? { ...r, ...mine[r.id], weight: "", swappedFrom: r.swappedFrom || s.rows.find(x => x.id === r.id).name } : r);
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
    }
    return `<div class="ex${r.group ? " g " + grpClass(r.group) : ""}"><div class="ex-h"><button class="ex-name" data-act="open" data-k="${esc(s.id + r.id)}" aria-expanded="${!!open}">${r.group ? `<span class="gchip ${grpClass(r.group)}">${esc(r.group)}</span>` : ""}<span>${esc(r.name)}</span>${ex && (ex.video || ex.cues) ? `<span class="play">${ex.video ? "▶ video" : "cues"}</span>` : ""}</button><span class="rx">${rx}</span>${s.homework && st.doing === s.id && appKey ? `<button class="btn sm" data-act="swapopen" data-w="${esc(s.id)}" data-r="${esc(r.id)}" aria-expanded="${isSwap(s.id, r.id)}">Swap</button>` : ""}</div>
      ${isSwap(s.id, r.id) ? swapPanel(r) : ""}
      ${r.swappedFrom ? `<div class="note swap">Instead of ${esc(r.swappedFrom)}</div>` : ""}${r.cantDo ? `<div class="note warn">Needs equipment you didn't pick. Skip it or do what you can.</div>` : ""}
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
      ${open && ex ? `<div class="detail">${ex.video ? videoEmbed(ex.video) : ""}${ex.cues ? `<div class="note">${esc(ex.cues)}</div>` : ""}</div>` : ""}
      ${sets}</div>`;
  }).join("");
  const doing = s.homework && st.doing === s.id, when = d => d === today() ? "today" : fmt(d);
  // Sessions with the trainer and homework look different: a label and a coloured edge.
  const kind = s.homework ? (s.byClient ? "Your own workout" : s.wasSession ? "Homework · session canceled, do it on your own" : "Homework · on your own") : `Session with ${V.trainer || "your trainer"}${s.day != null ? " · " + DAYS[s.day] : ""}`;
  return `<section class="card ${s.homework ? "hw" : "studio"} ${doing ? "doing" : ""}" id="s-${esc(s.id)}"><span class="kind">${esc(kind)}</span><div class="sess-h"><h2>${esc(s.name)}</h2>${s.homework ? (doneOn ? `<span class="badge done">Done ${esc(when(doneOn))}</span>` : `<span class="badge todo">To do</span>`) : doneOn ? `<span class="badge done">Done ${esc(fmt(doneOn))}</span>` : ""}</div>
    ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ""}
    ${doing && !st.doingOn ? eqPicker() + `<div class="row eq-opts">${st.again ? `<button class="chip" data-act="vary" aria-pressed="${st.vary}">Mix it up</button>` : ""}${swapped || st.plain ? `<button class="chip" data-act="plain" aria-pressed="${st.plain}">Show the original</button>` : ""}${st.vary && !st.plain ? `<span class="muted small">Same movements, different exercises from last time</span>` : ""}</div>` : ""}
    ${doing ? `<p class="muted small" style="margin:0">Fill in each set as you go and tap ✓ when it's done. Tap <b>Save workout</b> at the end.</p>` : ""}
    ${exs || `<div class="empty">No exercises yet.</div>`}
    ${s.homework && s.rows.length ? (doing
      ? `<div class="row"><label class="lbl" for="d-${s.id}">Done on</label><input type="date" id="d-${s.id}" value="${st.doingOn || today()}" max="${today()}"><button class="btn" data-act="stop" style="margin-left:auto">Cancel</button><button class="btn primary" data-act="save" data-s="${s.id}">Save workout</button></div>`
      : doneOn ? `<div class="row"><button class="btn" data-act="edit" data-s="${s.id}" data-d="${esc(calDay && any.some(l => l.date === calDay) ? calDay : doneOn)}" style="flex:1">Change what I logged</button><button class="btn primary" data-act="do" data-s="${s.id}" style="flex:1">Do it again</button></div>`
      : `<button class="btn primary wide" data-act="do" data-s="${s.id}">Start this homework</button>`) : ""}
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
  if (demo){ const r = demoPost(body); if (body.action === "suggest" || body.action === "swap") await new Promise(z => setTimeout(z, 500)); return r || { ok: true }; }
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
  if (a === "tab"){ st.tab = el.getAttribute("data-k"); st.calOpen = null; st.doing = null; st.calScroll = st.tab === "calendar"; render(); if (st.tab !== "calendar") window.scrollTo({ top: 0 }); }
  else if (a === "week"){ st.week = +el.getAttribute("data-i"); render(); }
  else if (a === "do" || a === "edit"){ const sid = el.getAttribute("data-s"); st.doing = sid; st.doingOn = a === "edit" ? el.getAttribute("data-d") : null; st.plain = false; st.swap = null; delete st.swaps[sid];
    st.again = a === "do" && Object.keys(logsFor(V.programs[st.prog].id, sid)).length > 0; st.vary = st.again;
    // Changing a logged workout starts from what was saved (one entry per set, so saving again replaces it).
    st.draft[sid] = {}; if (a === "edit"){ const L = logsFor(V.programs[st.prog].id, sid); for (const [k, l] of Object.entries(L)) st.draft[sid][k] = { reps: l.reps, weight: l.weight, done: l.done }; }
    render(); const c = document.getElementById("s-" + sid); if (c) c.scrollIntoView({ block: "start", behavior: "smooth" }); }
  else if (a === "eq"){ const k = el.getAttribute("data-k"), cur = (eqNow() || []).slice(), i = cur.indexOf(k); if (i >= 0) cur.splice(i, 1); else cur.push(k);
    await setEquipment(cur); if (st.add){ st.add.workout = null; suggest(); } else render(); }
  else if (a === "equsual"){ await setEquipment(eqNow() || [], true); toast("Saved as your usual"); render(); }
  else if (a === "vary"){ st.vary = !st.vary; render(); }
  else if (a === "plain"){ st.plain = !st.plain; render(); }
  else if (a === "hwshow"){ st.hwShow = el.getAttribute("data-s"); render(); }
  else if (a === "stop"){ delete st.swaps[st.doing]; st.doing = null; st.doingOn = null; st.swap = null; render(); }
  else if (a === "addopen"){ st.add = { date: el.getAttribute("data-d"), seed: 0, ask: "" }; st.calOpen = null; st.doing = null; st.eqOpen = false; suggest(); }
  else if (a === "askgo"){ st.add.ask = (document.getElementById("ask") || {}).value || ""; st.add.seed = 0; st.add.workout = null; suggest(); }
  else if (a === "askchip"){ const w = el.getAttribute("data-w"), A = st.add; A.ask = (document.getElementById("ask") || {}).value || A.ask || "";
    if (hasWord(A.ask, w)) A.ask = A.ask.replace(new RegExp("(^|[\\s,])" + w.replace(/ /g, "\\s+") + "(?=$|[\\s,.])", "ig"), " ");
    else { if (QUICK.slice(0, 4).includes(w)) for (const o of QUICK.slice(0, 4)) A.ask = A.ask.replace(new RegExp("(^|[\\s,])" + o.replace(/ /g, "\\s+") + "(?=$|[\\s,.])", "ig"), " "); A.ask = A.ask.trim() + " " + w; }
    A.ask = A.ask.replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/,(\s*,)+/g, ",").replace(/^[\s,]+|[\s,]+$/g, ""); A.seed = 0; A.workout = null; suggest(); }
  else if (a === "eqopen"){ st.eqOpen = true; render(); }
  else if (a === "swapopen"){ const w = el.getAttribute("data-w"), r = el.getAttribute("data-r"); st.swap = isSwap(w, r) ? null : { w, r, reason: null }; render(); }
  else if (a === "swapwhy"){ const S = st.swap, T = swapTarget(); if (!S || !T || !T.row) return; S.note = (document.getElementById("swap-note") || {}).value || S.note || ""; S.reason = el.getAttribute("data-k"); fetchSwaps(T.row, T.others); }
  else if (a === "swappick"){ const S = st.swap, T = swapTarget(), o = S && S.options && S.options[+el.getAttribute("data-i")]; if (!o || !T || !T.row) return;
    const pick = { name: o.name, exId: o.exId || null, reps: o.reps || T.row.reps, note: o.why || "" };
    if (S.w === "add"){ const rows = st.add.workout.rows, i = +S.r; rows[i] = { ...rows[i], ...pick, weight: "", swappedFrom: rows[i].swappedFrom || rows[i].name }; }
    else (st.swaps[S.w] = st.swaps[S.w] || {})[S.r] = pick;
    st.swap = null; toast("Swapped in " + o.name); render(); }
  else if (a === "addclose"){ st.add = null; render(); }
  else if (a === "sugmore"){ st.add.seed = (st.add.seed || 0) + 1; suggest(); }
  else if (a === "sugdel"){ st.add.workout.rows.splice(+el.getAttribute("data-i"), 1); st.swap = null; render(); }
  else if (a === "addsave"){
    const A = st.add, p = V.programs[Math.min(st.prog, V.programs.length - 1)]; A.saving = true; render();
    try { const j = await post({ action: "addWorkout", program_id: p.id, on_date: A.date, workout: A.workout }); st.add = null; toast("Added to your calendar"); await load(true); st.calOpen = A.date + "|" + (j.id || ""); render(); }
    catch (x){ A.saving = false; A.err = x.message; render(); }
  }
  else if (a === "mine-del"){ if (!confirm("Remove this workout from your calendar?")) return;
    try { await post({ action: "removeWorkout", session_id: el.getAttribute("data-s") }); st.calOpen = null; toast("Removed"); await load(true); } catch (x){ toast(x.message); } }
  else if (a === "calgo"){ st.calOpen = el.getAttribute("data-k"); st.doing = null; render(); const c = document.querySelector(".cal-open"); if (c) c.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
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
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && (st.flag || st.add) && V){ st.flag = null; st.add = null; st.swap = null; render(); }
  if (e.key === "Enter" && V && (e.target.id === "ask" || e.target.id === "swap-note")){ e.preventDefault(); const b = e.target.parentElement.querySelector("button"); if (b) b.click(); }
});
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
    const cws = demoStore.clientWorkouts || [], g = id => f(id) || ((cws.find(w => w.id === id) || {}).data) || null;
    return { workout: askWorkout({ ask: b.ask, last: f(b.last_id), next: f(b.next_id), week: (b.week || []).map(x => g(x.id)).filter(Boolean), library: demoStore.exercises, seed: b.seed || 0, equipment: b.equipment }), by: "planner" }; }
  if (b.action === "swap") return { options: swapOptions(b.name, { equipment: b.equipment, library: demoStore.exercises, exclude: b.others, reason: b.reason }), by: "planner" };
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
