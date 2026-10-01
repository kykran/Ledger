/* Trainer Tally · Studio side (hosted only).
 * For studio owners who rent space to trainers: every session on the studio's shared Google
 * Calendar is attributed to the trainer who booked it (the event's creator), rent is worked out
 * per trainer per month, statements go out, payments are logged, and room usage is charted.
 * Statements are saved on each trainer's row so a linked trainer sees the same numbers. */
import "./styles.css";
import * as real from "./supabase.js";
// The public demo swaps in an in-memory backend; everything else uses Supabase.
const B = window.__ttStudioBackend || real;
const { sb, api, currentSession, signInWithGoogle, storeGoogleToken, calendarCall, downloadFile } = B;
const HOME = B.homeUrl || "/";

const DAY = 86400000;
const YEAR0 = new Date().getFullYear() + "-01-01";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const METHODS = ["Venmo","Zelle","Cash","Check","Card","Other"];
const DEF = {
  name:"", calendarId:"", calendarName:"", rooms:3, open:6, close:21, days:[0,1,2,3,4,5,6],
  rent:{mode:"perSession", perSession:20, monthly:660}, historyStart:YEAR0,
  ignoreWords:["cancel","cancelled","canceled","closed","hold","maintenance","blocked"], ignoredEmails:[],
  statementTemplate:"Hi {first}! Your {studio} rent for {month} is ${amount} ({details}).{balance} Thanks!"
};
const RENT = { default:"Studio default", perSession:"Per session", monthly:"Flat monthly", none:"No rent" };
const ICON = {
  overview:'<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>',
  trainers:'<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.9-4.6 5.5-4.6s4.9 1.6 5.5 4.6M16 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.6.6 2.7 2 3 4.4"/>',
  rooms:'<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 10h17M10 10v10"/>',
  revenue:'<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 12h.01M17 12h.01"/><circle cx="12" cy="12" r="2.3"/>',
  trends:'<path d="M4 19.5h16M6.5 16l4-5 3 3 5-6.5"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  refresh:'<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.3L20 15.5M20 20v-4.5h-4.5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', cash:'<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  left:'<path d="m14.5 6-6 6 6 6"/>', right:'<path d="m9.5 6 6 6-6 6"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon:'<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>', auto:'<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>'
};
const ic = (k, extra) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"${extra||""}>${ICON[k]||""}</svg>`;

const S = { session:null, screen:"loading", studio:null, trainers:[], events:[], cal:{state:"idle", done:0, total:0, error:null, at:null},
  calList:null, calListErr:null, tab:"overview", month:null, modal:null, wiz:null, M:null, heatWeeks:8 };

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = (v, d=0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
const money = v => (v < -0.5 ? "-$" : "$") + Math.round(Math.abs(v)).toLocaleString();
const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const mkey = d => d.getFullYear()+"-"+pad(d.getMonth()+1);
const parseDay = s => { const [y,m,d] = String(s||"").slice(0,10).split("-").map(Number); return new Date(y||2000,(m||1)-1,d||1); };
const mStart = k => { const [y,m] = k.split("-").map(Number); return new Date(y, m-1, 1); };
const mNext = k => { const d = mStart(k); return mkey(new Date(d.getFullYear(), d.getMonth()+1, 1)); };
const mPrev = k => { const d = mStart(k); return mkey(new Date(d.getFullYear(), d.getMonth()-1, 1)); };
const mLabel = (k, long) => { const d = mStart(k); return (long ? d.toLocaleDateString(undefined,{month:"long"}) : MONTHS[d.getMonth()]) + " " + d.getFullYear(); };
const mName = k => mStart(k).toLocaleDateString(undefined,{month:"long"});
const fmtD = d => d ? d.toLocaleDateString(undefined,{month:"short",day:"numeric"}) : "–";
const fmtT = d => d ? d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}) : "";
const hourLabel = h => { const x = ((h+11)%12)+1; return x + (h < 12 ? "a" : "p"); };
const sow = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; };
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
const norm = s => (s||"").toLowerCase().replace(/[’']/g,"").replace(/[^a-z0-9+&\s]/g," ").replace(/\s+/g," ").trim();
const firstName = n => String(n||"").trim().split(/[\s+&]/)[0] || "there";
const initials = n => String(n||"?").trim().split(/[\s+&@.]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join("") || "?";
function hueOf(s){ let h = 0; for (const ch of String(s)) h = (h*31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
const colorOf = s => `hsl(${hueOf(s)} 52% 46%)`;
const avatar = n => `<span class="av" style="background:${colorOf(n)}" aria-hidden="true">${esc(initials(n))}</span>`;
const D = k => { const d = (S.studio && S.studio.data) || {}; return d[k] !== undefined && d[k] !== null ? d[k] : DEF[k]; };
const rentDefault = () => ({...DEF.rent, ...(D("rent")||{})});
const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
const chk = id => { const el = document.getElementById(id); return !!(el && el.checked); };
const trainer = id => S.trainers.find(t => t.id === id);
function toast(msg){ const t = document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(), 2800); }
const nameFromEmail = e => String(e||"").split("@")[0].replace(/[._-]+/g," ").replace(/\d+/g,"").trim().replace(/\b\w/g, c => c.toUpperCase()) || e;
const code8 = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = new Uint8Array(8); crypto.getRandomValues(b); return Array.from(b, x => a[x % a.length]).join(""); };

/* ---------- theme ---------- */
const root = document.documentElement;
const themePref = () => { try { return localStorage.getItem("tt-theme") || "system"; } catch(e){ return "system"; } };
function applyTheme(m){ if (m === "light" || m === "dark") root.setAttribute("data-theme", m); else root.removeAttribute("data-theme"); }
applyTheme(themePref());

/* ---------- data ---------- */
const fail = e => { toast("Couldn't save. Check your connection and try again."); throw e; };
async function saveStudio(patch){
  const data = {...(S.studio.data||{}), ...patch};
  S.studio = {...S.studio, data}; render();
  const { error } = await sb.from("studios").update({ data, updated_at:new Date().toISOString() }).eq("id", S.studio.id);
  if (error) fail(error);
}
async function saveTrainer(t){
  const body = {...t}; delete body.id;
  const i = S.trainers.findIndex(x => x.id === t.id); if (i >= 0) S.trainers[i] = t; else S.trainers.push(t);
  render();
  const { error } = await sb.from("studio_trainers").upsert({ studio_id:S.studio.id, id:t.id, data:body, updated_at:new Date().toISOString() });
  if (error) fail(error);
}
async function deleteTrainer(id){
  S.trainers = S.trainers.filter(t => t.id !== id); render();
  const { error } = await sb.from("studio_trainers").delete().eq("studio_id", S.studio.id).eq("id", id);
  if (error) fail(error);
}
async function loadStudio(){
  const { data, error } = await sb.from("studios").select("id,data").eq("owner_id", S.session.user.id).order("created_at").limit(1);
  if (error) throw error;
  S.studio = data && data[0] || null;
  if (S.studio){
    const { data: tr } = await sb.from("studio_trainers").select("id,data").eq("studio_id", S.studio.id);
    S.trainers = (tr||[]).map(r => ({id:r.id, ...r.data}));
    const { data: mem } = await sb.from("studio_members").select("trainer_id").eq("studio_id", S.studio.id);
    S.linked = new Set((mem||[]).map(m => m.trainer_id));
  }
}

/* ---------- calendar ---------- */
function calErrorText(err){
  const c = err && err.code;
  if (c === "calendar_scope") return "Google didn't give Trainer Tally permission to read your calendar. Press Allow calendar access, tick the calendar box on Google's screen, and press Continue once.";
  if (c === "needs_reauth" || c === "server_not_connected") return "Google Calendar access needs reconnecting. Sign out and back in.";
  if (c === "server_unavailable") return "Google Calendar didn't answer in time. Press Retry in a moment.";
  if (c === "tool_error") return "Google Calendar returned an error: " + (err.message||"") + " Check that your account can see the studio calendar.";
  return "Couldn't read the calendar" + (err && err.message ? ": " + err.message : ".");
}
async function fetchCalendarList(){
  S.calListErr = null;
  try { const p = await calendarCall("list_calendars", {pageSize:250}); S.calList = (p.calendars||[]).filter(c => c.id && !/#holiday|#contacts|#weeknum/i.test(c.id)); }
  catch(err){ S.calListErr = err; }
}
function monthChunks(a, b){ const out=[]; let x = new Date(a); while (x < b){ const y = new Date(x.getFullYear(), x.getMonth()+1, 1); out.push([x, y < b ? y : b]); x = y; } return out; }
let loadSeq = 0;
async function loadCalendar(refresh){
  const calId = D("calendarId"); if (!calId) return;
  const seq = ++loadSeq;
  const start = parseDay(D("historyStart")), end = addDays(new Date(), 42);
  const jobs = monthChunks(start, end);
  S.cal = {state:"loading", done:0, total:jobs.length, error:null, at:S.cal.at}; renderStatus();
  const out = []; let i = 0, failed = null;
  async function worker(){ while (i < jobs.length && !failed){ const [a,b] = jobs[i++];
    try { let token = null, g = 0; do { const inp = {calendarId:calId, startTime:a.toISOString(), endTime:b.toISOString(), orderBy:"startTime", pageSize:250, eventType:["DEFAULT"]}; if (token) inp.pageToken = token; const p = await calendarCall("list_events", inp, {refresh}); (p.events||[]).forEach(e => out.push(e)); token = p.nextPageToken || null; g++; } while (token && g < 20); }
    catch(err){ failed = err; }
    S.cal.done++; if (seq === loadSeq) renderStatus(); } }
  await Promise.all([worker(), worker(), worker()]);
  if (seq !== loadSeq) return;
  if (failed){ S.cal = {...S.cal, state:"error", error:failed}; renderStatus(); render(); return; }
  const seen = new Set(), evs = [];
  for (const e of out){
    if (!e || e.status === "cancelled" || !e.start || !e.start.dateTime || seen.has(e.id)) continue; seen.add(e.id);
    const s = new Date(e.start.dateTime), en = e.end && e.end.dateTime ? new Date(e.end.dateTime) : new Date(+s + 3600000);
    evs.push({id:e.id, title:(e.summary||"").trim(), start:s, end:en, email:(((e.creator||{}).email)||((e.organizer||{}).email)||"").toLowerCase()});
  }
  evs.sort((a,b)=>a.start-b.start);
  S.events = evs; S.cal = {state:"ready", done:jobs.length, total:jobs.length, error:null, at:new Date()};
  renderStatus(); render();
}

/* ---------- engine ---------- */
function ruleFor(t){ const r = t.rent || {mode:"default"}; return r.mode === "default" || !r.mode ? {...rentDefault(), inherited:true} : {...rentDefault(), ...r}; }
function ruleText(r){ return r.mode === "perSession" ? `${money(r.perSession)}/session` : r.mode === "monthly" ? `${money(r.monthly)}/month` : "No rent"; }
function compute(){
  const now = new Date(), curM = mkey(now);
  const ignore = (D("ignoreWords")||[]).map(norm).filter(Boolean);
  const ignoredEmails = new Set((D("ignoredEmails")||[]).map(x => x.toLowerCase()));
  const byEmail = new Map(); for (const t of S.trainers) for (const e of (t.emails||[])) byEmail.set(String(e).toLowerCase(), t.id);
  const byT = {}; S.trainers.forEach(t => byT[t.id] = []);
  const unknown = {}; const roomEvents = [];
  for (const e of S.events){
    const words = norm(e.title).split(" ");
    if (ignore.some(w => words.includes(w))) continue;
    roomEvents.push(e);
    const tid = byEmail.get(e.email);
    if (tid){ byT[tid].push({...e, future:e.start >= now}); continue; }
    if (!e.email || ignoredEmails.has(e.email)) continue;
    const u = unknown[e.email] || (unknown[e.email] = {email:e.email, count:0, last:null, titles:new Set()});
    u.count++; if (e.start < now) u.last = e.start; if (u.titles.size < 4) u.titles.add(e.title);
  }
  const hs = mkey(parseDay(D("historyStart")));
  const stats = {};
  for (const t of S.trainers){
    const list = byT[t.id] || [], past = list.filter(s => !s.future), future = list.filter(s => s.future);
    const rule = ruleFor(t);
    const firstM = t.startDate ? mkey(parseDay(t.startDate)) : (past[0] ? mkey(past[0].start) : curM);
    const from = firstM > hs ? firstM : hs;
    const months = [];
    for (let k = from; k <= curM; k = mNext(k)){
      const n = past.filter(s => mkey(s.start) === k).length;
      const booked = future.filter(s => mkey(s.start) === k).length;
      let rent = 0, details = "";
      if (t.active === false && !n){ months.push({month:k, n, booked, rent:0, details:"inactive", due:false, running:false, paid:0}); continue; }
      if (rule.mode === "perSession"){ rent = n * num(rule.perSession); details = `${n} session${n===1?"":"s"} × ${money(num(rule.perSession))}`; }
      else if (rule.mode === "monthly"){ rent = num(rule.monthly); details = `flat monthly rent, ${n} session${n===1?"":"s"}`; }
      else details = `${n} session${n===1?"":"s"}, no rent`;
      const running = k === curM && rule.mode === "perSession";
      months.push({month:k, n, booked, rent, details, due: rule.mode === "monthly" ? true : k < curM, running, paid:0});
    }
    let pool = (t.payments||[]).reduce((a,p)=>a+num(p.amount),0); const paidTotal = pool;
    for (const m of months){ const take = Math.min(pool, m.rent); m.paid = take; pool -= take; m.state = m.rent <= 0 ? "none" : take >= m.rent - 0.5 ? "paid" : take > 0 ? "partial" : m.running ? "running" : "open"; }
    const dueAmt = months.filter(m => m.due).reduce((a,m)=>a+m.rent,0);
    const balance = Math.max(0, dueAmt - paidTotal);
    const cur = months.find(m => m.month === curM);
    const d56 = now - 56*DAY, recent = past.filter(s => s.start >= d56).length;
    stats[t.id] = {t, rule, past, future, months, balance, credit:pool, cur, pace: recent/8,
      last: past.length ? past[past.length-1].start : null, next: future[0] ? future[0].start : null,
      status: balance > 0.5 ? "owes" : "ok", label: balance > 0.5 ? "Owes " + money(balance) : "Paid up"};
  }
  const collectedBy = k => S.trainers.reduce((a,t)=>a + (t.payments||[]).filter(p => String(p.date).slice(0,7) === k).reduce((x,p)=>x+num(p.amount),0), 0);
  const um = Object.values(unknown).filter(u => u.count >= 2).sort((a,b)=>b.count-a.count).map(u => ({...u, titles:[...u.titles]}));
  return {now, curM, stats, unknown:um, roomEvents, collectedBy};
}
function monthRent(M, k){ let billed = 0, n = 0; for (const t of S.trainers){ const m = M.stats[t.id].months.find(x => x.month === k); if (m){ billed += m.rent; n += m.n; } } return {billed, n, collected:M.collectedBy(k)}; }
function projectedRent(M){ // this month, booked sessions + pace for per-session trainers
  let extra = 0; const now = M.now, me = mStart(mNext(M.curM)); const daysLeft = Math.max(0, (me - now) / DAY);
  for (const t of S.trainers){ if (t.active === false) continue; const st = M.stats[t.id]; if (st.rule.mode !== "perSession") continue;
    const booked = st.future.filter(s => s.start < me).length; extra += Math.max(booked, st.pace * daysLeft / 7) * num(st.rule.perSession); }
  return extra;
}
function statementSnapshot(M, t){
  const st = M.stats[t.id];
  return { rule: ruleText(st.rule), balance: Math.round(st.balance*100)/100, credit: Math.round(st.credit*100)/100,
    months: st.months.slice(-12).map(m => ({month:m.month, n:m.n, rent:m.rent, paid:m.paid, state:m.state, details:m.details})) };
}
const stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).filter(k => v[k] !== undefined && k !== "updatedAt").sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v);
let syncing = false;
async function syncStatements(M){ // keep each trainer's saved statement current so linked trainers see the same numbers
  if (syncing || S.cal.state !== "ready") return; syncing = true;
  try { for (const t of S.trainers){
    const snap = statementSnapshot(M, t);
    if (t.statement && stable(snap) === stable(t.statement)) continue;
    const nt = {...t, statement:{...snap, updatedAt:new Date().toISOString()}}; const i = S.trainers.findIndex(x => x.id === t.id); S.trainers[i] = nt;
    const body = {...nt}; delete body.id;
    await sb.from("studio_trainers").upsert({ studio_id:S.studio.id, id:t.id, data:body, updated_at:new Date().toISOString() });
  } } finally { syncing = false; }
}
function roomUsage(M, weeks){
  const open = num(D("open"),6), close = num(D("close"),21), days = new Set(D("days")||[0,1,2,3,4,5,6]), rooms = Math.max(1, num(D("rooms"),3));
  const end = sow(M.now), start = addDays(end, -7*weeks);
  const grid = Array.from({length:7}, () => Array(24).fill(0));
  let used = 0;
  for (const e of M.roomEvents){
    if (e.start < start || e.start >= end) continue;
    let a = +e.start, b = Math.min(+e.end, +e.start + 4*3600000);
    while (a < b){ const d = new Date(a); const hEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()+1); const seg = Math.min(b, +hEnd) - a; const dow = (d.getDay()+6)%7; grid[dow][d.getHours()] += seg/3600000; a += seg; }
  }
  const cells = []; let capHours = 0;
  for (let dow = 0; dow < 7; dow++){ const jsDay = (dow+1)%7; const isOpen = days.has(jsDay);
    for (let h = open; h < close; h++){ const avg = grid[dow][h]/weeks; if (isOpen){ capHours += rooms; used += avg; } cells.push({dow, h, avg, util: isOpen ? Math.min(1.5, avg/rooms) : null}); } }
  const openCells = cells.filter(c => c.util !== null);
  const peak = [...openCells].sort((a,b)=>b.util-a.util).slice(0,3);
  const prime = openCells.filter(c => c.dow < 5 && ((c.h >= 6 && c.h < 9) || (c.h >= 17 && c.h < 20)));
  const quiet = [...prime].sort((a,b)=>a.util-b.util).slice(0,3);
  return {cells, open, close, rooms, util: capHours ? used/capHours : 0, weeklyHours: used, capHours, peak, quiet, weeks};
}

/* ---------- chrome ---------- */
const TABS = [["overview","Overview"],["trainers","Trainers"],["rooms","Room usage"],["revenue","Revenue"],["trends","Trends"],["settings","Settings"]];
const MONTH_TABS = new Set(["overview","trainers","revenue"]);
function renderChrome(){
  const inApp = S.screen === "app" && S.studio && S.studio.data && S.studio.data.setupDone;
  $("#app").classList.toggle("bare", !inApp);
  const M = S.M; const badge = k => inApp && M ? (k === "trainers" ? M.unknown.length + S.trainers.filter(t => M.stats[t.id] && M.stats[t.id].balance > 0.5).length : 0) : 0;
  $("#nav").innerHTML = TABS.map(([k,l]) => `<button data-tab="${k}" ${S.tab===k?'aria-current="page"':""}>${ic(k)}<span>${l}</span>${badge(k)?`<span class="badge">${badge(k)}</span>`:""}</button>`).join("");
  $("#tabbar").style.gridTemplateColumns = "repeat(5,1fr)";
  $("#tabbar").innerHTML = TABS.map(([k,l]) => `<button data-tab="${k}" ${S.tab===k?'aria-current="page"':""} aria-label="${l}">${ic(k)}<span>${l.split(" ")[0]}</span>${badge(k)?'<i class="dot"></i>':""}</button>`).join("");
  const pref = themePref();
  $("#sidefoot").innerHTML = `<div class="seg" role="group" aria-label="Appearance">${[["system","auto"],["light","sun"],["dark","moon"]].map(([m,i])=>`<button data-act="theme" data-mode="${m}" aria-pressed="${pref===m}">${ic(i,' style="width:14px;height:14px"')}</button>`).join("")}</div>
    <a class="btn sm" href="${HOME}" style="align-self:flex-start">← My training</a>${S.session ? `<span>${esc(S.session.user.email)}</span><button class="btn sm ghost" data-act="signout" style="align-self:flex-start;padding-left:0">Sign out</button>` : ""}`;
  $("#pagetitle").textContent = inApp ? (TABS.find(x=>x[0]===S.tab)||[])[1] : "Studio";
  $("#pagesub").textContent = inApp ? `${D("name")} · ${S.cal.at ? "calendar read " + fmtT(S.cal.at) : "studio side"}` : "Rent, trainers and room usage for studio owners";
  const ms = $("#monthsw"); ms.hidden = !(inApp && MONTH_TABS.has(S.tab) && S.month);
  if (!ms.hidden){ const cur = M ? M.curM : S.month; ms.innerHTML = `<button data-act="mprev" aria-label="Previous month">${ic("left")}</button><span>${esc(mLabel(S.month,true))}</span><button data-act="mnext" aria-label="Next month" ${S.month>=cur?"disabled":""}>${ic("right")}</button>`; }
  $("#actions").innerHTML = inApp ? `<button class="btn icon" data-act="refresh" title="Refresh calendar" aria-label="Refresh calendar" ${S.cal.state==="loading"?"disabled":""}>${ic("refresh")}</button>
    <button class="btn" data-act="payment">${ic("cash")}<span class="lbl">Payment</span></button>
    <button class="btn primary" data-act="new-trainer">${ic("plus")}<span class="lbl">Trainer</span></button>` : "";
}
function renderStatus(){
  renderChrome(); let h = "";
  if (S.cal.state === "loading"){ const pct = S.cal.total ? Math.round(100*S.cal.done/S.cal.total) : 0; h = `<div class="banner"><span class="small">Reading the studio calendar…</span><div class="prog"><b style="width:${pct}%"></b></div><span class="small">${pct}%</span></div>`; }
  else if (S.cal.state === "error") h = `<div class="banner err"><span>${esc(calErrorText(S.cal.error))}</span>${S.cal.error && S.cal.error.code === "calendar_scope" ? `<button class="btn sm primary" data-act="grant-calendar">Allow calendar access</button>` : `<button class="btn sm" data-act="refresh">Retry</button>`}</div>`;
  $("#status").innerHTML = S.screen === "app" ? h : "";
}
function render(){
  const main = $("#main");
  if (S.screen === "signin"){ renderChrome(); main.innerHTML = `<div class="signin"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5v14M9.5 5v14M14 5v14M18.5 5v14M3 16.5 21 7.5"/></svg></span><h1>Trainer Tally for studios</h1><p class="muted">See which trainers used the studio, what each owes in rent, and how full your space is, straight from your shared Google Calendar.</p><button class="btn primary" data-act="signin" style="padding:11px 18px;font-size:14px">Continue with Google</button><p class="small muted">Read-only access to your calendar. Nothing is ever changed on it. <a href="/privacy.html">Privacy</a></p></div>`; return; }
  if (S.screen === "loading"){ renderChrome(); return; }
  if (!S.studio || !(S.studio.data && S.studio.data.setupDone)){ S.M = null; renderChrome(); main.innerHTML = renderSetup(); return; }
  const M = compute(); S.M = M; if (!S.month) S.month = M.curM;
  renderChrome(); renderStatus();
  main.innerHTML = S.tab === "overview" ? renderOverview(M) : S.tab === "trainers" ? renderTrainers(M) : S.tab === "rooms" ? renderRooms(M) : S.tab === "revenue" ? renderRevenue(M) : S.tab === "trends" ? renderTrends(M) : renderSettings();
  drawCharts(M);
  if (S.modal) renderModal();
  syncStatements(M);
}

/* ---------- setup ---------- */
function renderSetup(){
  if (!S.wiz) S.wiz = {step:1, name:D("name"), calendarId:D("calendarId"), rooms:D("rooms"), open:D("open"), close:D("close"), days:[...D("days")], rent:{...rentDefault()}, historyStart:D("historyStart")};
  const w = S.wiz; let body = "";
  if (w.step === 1){
    if (!S.calList && !S.calListErr && !S.calLoading){ S.calLoading = true; fetchCalendarList().finally(()=>{ S.calLoading = false; render(); }); }
    const cals = S.calListErr ? `<div class="banner err"><span>${esc(calErrorText(S.calListErr))}</span>${S.calListErr.code === "calendar_scope" ? `<button class="btn sm primary" data-act="grant-calendar">Allow calendar access</button>` : `<button class="btn sm" data-act="cal-list">Retry</button>`}</div>` : !S.calList ? `<div class="note">Looking up your calendars…</div>` :
      `<div class="choice">${S.calList.map(c => `<label><input type="radio" name="w-cal" value="${esc(c.id)}" ${w.calendarId===c.id?"checked":""}><span><b>${esc(c.summary||c.id)}</b><small>${esc(c.id.length>40?c.id.slice(0,38)+"…":c.id)}</small></span></label>`).join("")}</div>`;
    body = `<div class="card"><h2>Your studio and its shared calendar</h2>
      <div class="field"><label for="w-name">Studio name</label><input id="w-name" value="${esc(w.name)}" placeholder="e.g. Elite Training Group"></div>
      <p class="small muted">Pick the calendar your trainers book sessions on. Each trainer should book with their own Google account, so the app knows whose session it is.</p>${cals}</div>`;
  } else if (w.step === 2){
    const hours = Array.from({length:24},(_,h)=>h);
    body = `<div class="card"><h2>Your space</h2>
      <div class="form">
        <div class="field"><label for="w-rooms">Trainers who can work at once</label><input id="w-rooms" type="number" min="1" max="50" value="${esc(w.rooms)}"><span class="hint">Used to measure how full the studio is</span></div>
        <div class="field"><label for="w-open">Opens</label><select id="w-open">${hours.map(h=>`<option value="${h}" ${+w.open===h?"selected":""}>${hourLabel(h)}m</option>`).join("")}</select></div>
        <div class="field"><label for="w-close">Closes</label><select id="w-close">${hours.map(h=>`<option value="${h+1}" ${+w.close===h+1?"selected":""}>${hourLabel((h+1)%24)}m</option>`).join("")}</select></div>
        <div class="field full"><label>Open days</label><div class="actions">${DOW.map((d,i)=>{ const js=(i+1)%7; return `<label class="check"><input type="checkbox" class="w-day" value="${js}" ${w.days.includes(js)?"checked":""}> ${d}</label>`; }).join("")}</div></div>
      </div></div>`;
  } else {
    const r = w.rent; const opt = (m,t,s) => `<label><input type="radio" name="w-rent" value="${m}" ${r.mode===m?"checked":""}><span><b>${t}</b><small>${s}</small></span></label>`;
    body = `<div class="card"><h2>How trainers pay rent</h2><p class="small muted">This is the default. You can set a different deal for any trainer.</p>
      <div class="choice">${opt("perSession","Per session","e.g. $20 for every session booked")}${opt("monthly","Flat monthly","e.g. $660 a month, unlimited use")}${opt("none","No rent","Track usage only")}</div>
      <div class="form"><div class="field"><label for="w-rps">Per-session rent ($)</label><input id="w-rps" type="number" min="0" value="${esc(r.perSession)}"></div>
        <div class="field"><label for="w-rmo">Monthly rent ($)</label><input id="w-rmo" type="number" min="0" value="${esc(r.monthly)}"></div>
        <div class="field"><label for="w-start">Count from</label><input id="w-start" type="date" value="${esc(w.historyStart)}"></div></div></div>`;
  }
  return `<div class="setup"><div><h1>Set up your studio</h1><p class="muted small">Three steps. Trainers are found automatically from who booked each session.</p></div>
    <div class="steps">${["Calendar","Space","Rent"].map((s,i)=>`<span class="${w.step===i+1?"on":""}">${i+1}. ${s}</span>`).join("")}</div>${body}
    <div class="actions">${w.step>1?`<button class="btn" data-act="wiz-back">Back</button>`:""}<button class="btn primary" data-act="wiz-next">${w.step===3?"Finish and read the calendar":"Next"}</button>
    ${S.studio && S.studio.data && S.studio.data.setupDone ? `<button class="btn ghost" data-act="wiz-cancel">Cancel</button>` : ""}<a class="btn ghost" href="${HOME}" style="margin-left:auto">← Back to my training</a></div></div>`;
}
function readWiz(){
  const w = S.wiz;
  if (w.step === 1){ w.name = val("w-name").trim(); const c = document.querySelector('input[name="w-cal"]:checked'); if (c) w.calendarId = c.value; }
  if (w.step === 2){ w.rooms = Math.max(1, Math.round(num(val("w-rooms"),3))); w.open = +val("w-open"); w.close = +val("w-close"); w.days = [...document.querySelectorAll(".w-day:checked")].map(x => +x.value); }
  if (w.step === 3){ const m = document.querySelector('input[name="w-rent"]:checked'); w.rent = {mode: m ? m.value : "perSession", perSession:num(val("w-rps"),20), monthly:num(val("w-rmo"),0)}; w.historyStart = val("w-start") || YEAR0; }
}

/* ---------- overview ---------- */
function renderOverview(M){
  const k = S.month, R = monthRent(M, k), isCur = k === M.curM, proj = isCur ? projectedRent(M) : 0;
  const owed = S.trainers.reduce((a,t)=>a + M.stats[t.id].balance, 0);
  const ru = roomUsage(M, 4);
  const owing = S.trainers.filter(t => M.stats[t.id].balance > 0.5).sort((a,b)=>M.stats[b.id].balance-M.stats[a.id].balance);
  const active = S.trainers.filter(t => t.active !== false);
  if (!S.trainers.length) return `<div class="card"><div class="empty"><b>No trainers yet</b><span>${M.unknown.length ? `${M.unknown.length} people have booked sessions on your calendar.` : S.cal.state==="loading" ? "Reading the studio calendar…" : "Once trainers book on the studio calendar, they appear here."}</span>${M.unknown.length?`<button class="btn primary" data-tab="trainers">Review trainers found</button>`:""}</div></div>`;
  return `<section class="card"><div class="hero"><div><h3>Studio rent · ${esc(mName(k))}</h3>
      <div class="big" style="margin-top:8px">${money(R.billed)}${proj > 0 ? ` <small>→ ${money(R.billed + proj)}</small>` : ""}</div>
      <div class="eq"><span><b>${R.n}</b> sessions</span><span>·</span><span><b>${money(R.collected)}</b> collected</span>${proj>0?`<span class="muted">· projected month end</span>`:""}</div></div>
      <div class="chart" data-chart="rentbars"></div></div></section>
  <div class="stats">
    <div class="stat"><span class="k">Outstanding</span><span class="v ${owed>0.5?"neg":""}">${money(owed)}</span><span class="d">owed by ${owing.length} trainer${owing.length===1?"":"s"}</span></div>
    <div class="stat"><span class="k">Active trainers</span><span class="v">${active.length}</span><span class="d">${S.trainers.filter(t=>S.linked && S.linked.has(t.id)).length} linked their account</span></div>
    <div class="stat"><span class="k">Room usage</span><span class="v">${Math.round(ru.util*100)}%</span><span class="d">of open hours, last 4 weeks</span></div>
    <div class="stat"><span class="k">Sessions / week</span><span class="v">${(S.trainers.reduce((a,t)=>a+M.stats[t.id].pace,0)).toFixed(0)}</span><span class="d">across all trainers</span></div>
  </div>
  <div class="grid2">
    <section class="card"><div class="card-h"><h2>Rent owed</h2></div>
      ${owing.length ? `<div class="alist">${owing.map(t => { const st = M.stats[t.id]; const open = st.months.filter(m => m.due && m.state !== "paid"); return `<div class="aitem"><div class="top">${avatar(t.name)}<a href="#" class="n" style="font-weight:600;color:var(--ink);text-decoration:none" data-act="edit" data-id="${t.id}">${esc(t.name)}</a><span class="chip owes">${money(st.balance)}</span></div><div class="meta">${open.map(m => MONTHS[mStart(m.month).getMonth()] + " " + money(m.rent - m.paid)).join(" · ")}</div><div class="rowacts"><button class="btn sm" data-act="msg" data-id="${t.id}">Statement</button><button class="btn sm primary" data-act="payment" data-id="${t.id}">Log payment</button></div></div>`; }).join("")}</div>` : `<div class="empty">Every trainer is paid up.</div>`}
      ${M.unknown.length ? `<div class="note">${M.unknown.length} new ${M.unknown.length===1?"person has":"people have"} booked on the calendar. <button class="btn link" data-tab="trainers">Review</button></div>` : ""}
    </section>
    <section class="card"><div class="card-h"><h2>This month by trainer</h2></div>
      <div class="tablewrap"><table><thead><tr><th>Trainer</th><th class="num">Sessions</th><th class="num">Rent</th></tr></thead><tbody>
      ${active.map(t => { const m = M.stats[t.id].months.find(x => x.month === k) || {n:0, rent:0, booked:0}; return {t, m}; }).sort((a,b)=>b.m.n-a.m.n).map(({t,m}) => `<tr><td><div class="who">${avatar(t.name)}<span class="n">${esc(t.name)}</span></div></td><td class="num">${m.n}${m.booked?`<span class="muted"> +${m.booked}</span>`:""}</td><td class="num" style="font-weight:600">${money(m.rent)}</td></tr>`).join("")}
      </tbody></table></div></section>
  </div>`;
}

/* ---------- trainers ---------- */
function renderTrainers(M){
  const k = S.month;
  const rows = S.trainers.slice().sort((a,b)=>(a.active===false)-(b.active===false) || M.stats[b.id].balance - M.stats[a.id].balance || a.name.localeCompare(b.name));
  return `<section class="card"><div class="card-h"><h2>Trainers</h2><span class="small muted">${S.trainers.filter(t=>t.active!==false).length} active</span></div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Trainer</th><th>Rent</th><th class="num">Sessions</th><th class="num">${esc(MONTHS[mStart(k).getMonth()])} rent</th><th>Balance</th><th>Account</th><th></th></tr></thead><tbody>
    ${rows.map(t => { const st = M.stats[t.id], m = st.months.find(x => x.month === k) || {n:0, rent:0, booked:0}; const linked = S.linked && S.linked.has(t.id);
      return `<tr style="${t.active===false?"opacity:.55":""}"><td><div class="who">${avatar(t.name)}<div style="min-width:0"><a href="#" class="n" data-act="edit" data-id="${t.id}">${esc(t.name)}</a><div class="s">${esc((t.emails||[]).join(", "))}</div></div></div></td>
        <td class="small">${esc(ruleText(st.rule))}${st.rule.inherited?' <span class="muted">(default)</span>':""}</td>
        <td class="num">${m.n}${m.booked?`<span class="muted"> +${m.booked}</span>`:""}</td><td class="num" style="font-weight:600">${money(m.rent)}</td>
        <td><span class="chip ${st.status}">${esc(st.label)}</span></td>
        <td class="small">${linked ? `<span class="chip ok">Linked</span>` : `<button class="btn sm" data-act="invite" data-id="${t.id}">Invite</button>`}</td>
        <td><div class="rowacts"><button class="btn sm" data-act="msg" data-id="${t.id}">Statement</button><button class="btn sm" data-act="payment" data-id="${t.id}">Payment</button></div></td></tr>`; }).join("")}
    </tbody></table></div>` : `<div class="empty">No trainers yet. Add them from the list below, or add one by hand.</div>`}
  </section>
  <section class="card"><div class="card-h"><h2>Found on the calendar</h2><span class="small muted">People who booked sessions but aren't set up as trainers</span></div>
    ${M.unknown.length ? `<div class="tablewrap"><table><thead><tr><th>Booked by</th><th class="num">Sessions</th><th>Last</th><th>Event names</th><th></th></tr></thead><tbody>
    ${M.unknown.map((u,i) => `<tr><td style="font-weight:600">${esc(u.email)}</td><td class="num">${u.count}</td><td class="small">${fmtD(u.last)}</td><td class="small muted">${esc(u.titles.join(", "))}</td>
      <td><div class="rowacts"><button class="btn sm primary" data-act="u-add" data-i="${i}">Add as trainer</button><button class="btn sm" data-act="u-link" data-i="${i}">Same as…</button><button class="btn sm" data-act="u-ignore" data-i="${i}">Ignore</button></div></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">${S.cal.state==="loading" ? "Reading the studio calendar…" : "Everyone who books on the calendar is set up."}</div>`}
  </section>`;
}

/* ---------- rooms ---------- */
function renderRooms(M){
  const ru = roomUsage(M, S.heatWeeks);
  const days = new Set(D("days")||[]);
  const color = u => u === null ? "var(--bg)" : u <= 0.001 ? "var(--surface2)" : `color-mix(in srgb, var(--accent) ${Math.round(20 + Math.min(1,u)*80)}%, var(--surface2))`;
  let grid = `<div class="heat" style="grid-template-columns:44px repeat(7,minmax(0,1fr))"><span></span>${DOW.map(d=>`<span class="hd">${d}</span>`).join("")}`;
  for (let h = ru.open; h < ru.close; h++){
    grid += `<span class="hl">${hourLabel(h)}</span>`;
    for (let dow = 0; dow < 7; dow++){ const c = ru.cells.find(x => x.dow === dow && x.h === h); const open = days.has((dow+1)%7);
      grid += `<span class="hc${c.util!==null && c.util>=1?" full":""}" style="background:${color(c.util)}" title="${DOW[dow]} ${hourLabel(h)}m: ${open ? c.avg.toFixed(1) + " of " + ru.rooms + " spots used on average" : "closed"}"></span>`; }
  }
  grid += "</div>";
  const slot = c => `${DOW[c.dow]} ${hourLabel(c.h)}m`;
  return `<div class="stats">
    <div class="stat"><span class="k">Room usage</span><span class="v">${Math.round(ru.util*100)}%</span><span class="d">of open capacity</span></div>
    <div class="stat"><span class="k">Booked hours / week</span><span class="v">${ru.weeklyHours.toFixed(0)}</span><span class="d">of ${ru.capHours.toFixed(0)} available</span></div>
    <div class="stat"><span class="k">Busiest</span><span class="v" style="font-size:18px">${ru.peak.map(slot).join("<br>") || "–"}</span><span class="d">by spots used</span></div>
    <div class="stat"><span class="k">Quiet prime time</span><span class="v" style="font-size:18px">${ru.quiet.map(slot).join("<br>") || "–"}</span><span class="d">weekday 6–9am, 5–8pm</span></div>
  </div>
  <section class="card"><div class="card-h"><h2>How full the studio is</h2>
    <div class="seg" role="group" aria-label="Period">${[4,8,12].map(w=>`<button data-act="heat-weeks" data-w="${w}" aria-pressed="${S.heatWeeks===w}">${w} wks</button>`).join("")}</div></div>
    <p class="small muted">Average spots in use each hour over the last ${ru.weeks} weeks, out of ${ru.rooms}. Darker is busier; outlined squares were at or over capacity.</p>
    <div class="tablewrap">${grid}</div>
  </section>`;
}

/* ---------- revenue ---------- */
function renderRevenue(M){
  const hs = mkey(parseDay(D("historyStart"))); const rows = []; for (let k = hs; k <= M.curM; k = mNext(k)) rows.push({k, ...monthRent(M,k)});
  const tot = rows.reduce((a,r)=>({billed:a.billed+r.billed, collected:a.collected+r.collected, n:a.n+r.n}), {billed:0, collected:0, n:0});
  const k = S.month; const per = S.trainers.map(t => ({t, m:M.stats[t.id].months.find(x => x.month === k)})).filter(x => x.m && (x.m.n || x.m.rent)).sort((a,b)=>b.m.rent-a.m.rent);
  const totM = per.reduce((a,x)=>a+x.m.rent,0);
  return `<div class="stats">
    <div class="stat"><span class="k">Rent billed since ${esc(mLabel(hs))}</span><span class="v">${money(tot.billed)}</span><span class="d">${tot.n} sessions</span></div>
    <div class="stat"><span class="k">Collected</span><span class="v">${money(tot.collected)}</span><span class="d">${tot.billed ? Math.round(100*tot.collected/tot.billed) : 0}% of billed</span></div>
    <div class="stat"><span class="k">Average month</span><span class="v">${money(rows.length ? tot.billed/rows.length : 0)}</span><span class="d">rent billed</span></div>
    <div class="stat"><span class="k">Per session</span><span class="v">${tot.n ? "$" + (tot.billed/tot.n).toFixed(2) : "–"}</span><span class="d">average rent</span></div>
  </div>
  <section class="card"><div class="card-h"><h2>Rent by month</h2><div class="legend"><span><i class="sw-acc"></i>Billed</span><span><i class="sw-rent"></i>Collected</span></div></div><div class="chart" data-chart="revbars"></div></section>
  <section class="card"><div class="card-h"><h2>By trainer · ${esc(mName(k))}</h2></div>
    ${per.length ? `<div class="tablewrap"><table><thead><tr><th>Trainer</th><th class="num">Sessions</th><th class="num">Rent</th><th class="num">Paid</th><th class="num">Share</th></tr></thead><tbody>
    ${per.map(({t,m}) => `<tr><td><div class="who">${avatar(t.name)}<span class="n">${esc(t.name)}</span></div></td><td class="num">${m.n}</td><td class="num" style="font-weight:600">${money(m.rent)}</td><td class="num">${money(m.paid)}</td><td class="num">${totM?Math.round(100*m.rent/totM):0}%</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">No rent this month.</div>`}
    <div class="actions"><button class="btn" data-act="export">Download statements (.csv)</button></div>
  </section>`;
}

/* ---------- trends ---------- */
// Per-trainer pace over time: last 4 weeks vs the 12 before, distinct clients, hours booked, share of rent.
function trainerTrend(M, t){
  const st = M.stats[t.id], now = M.now, w0 = sow(now);
  const inR = (a, b) => st.past.filter(s => s.start >= a && s.start < b);
  const weekly = Array.from({length:12}, (_, i) => { const a = addDays(w0, (i - 11) * 7); return inR(a, addDays(a, 7)).length; });
  const recent = inR(addDays(now, -28), now).length / 4;
  const first = st.past[0] ? st.past[0].start : null;
  const baseStart = new Date(Math.max(+addDays(now, -112), first ? +first : +now));
  const baseWeeks = Math.max(0, (addDays(now, -28) - baseStart) / (7*DAY));
  const base = baseWeeks >= 2 ? inR(baseStart, addDays(now, -28)).length / baseWeeks : null;
  const last30 = inR(addDays(now, -30), now);
  const clients = new Set(last30.map(s => norm(s.title)).filter(Boolean)).size;
  const hours = last30.reduce((a, s) => a + Math.max(0, ((s.end || s.start) - s.start) / 3600000), 0);
  const rent90 = st.months.filter(m => m.month >= mkey(addDays(now, -90))).reduce((a, m) => a + m.rent, 0);
  let status = "steady";
  if (!st.past.length || (first && first >= addDays(now, -42))) status = "new";
  else if (st.last && now - st.last > 14*DAY) status = "quiet";
  else if (base && recent < base * 0.75) status = "slipping";
  else if (base && recent > base * 1.25) status = "growing";
  return {t, st, weekly, recent, base, change: base ? (recent - base) / base : null, clients, hours, rent90, status};
}
function renderTrends(M){
  const rows = S.trainers.filter(t => t.active !== false).map(t => trainerTrend(M, t)).sort((a,b) => b.recent - a.recent);
  const totRent = rows.reduce((a,r)=>a+r.rent90,0), totNow = rows.reduce((a,r)=>a+r.recent,0), totBase = rows.reduce((a,r)=>a+(r.base ?? r.recent),0);
  const L = {quiet:["Gone quiet","owes"], slipping:["Slowing","low"], new:["New","info"], growing:["Growing","ok"], steady:["Steady","info"]};
  const mini = w => { const mx = Math.max(1, ...w); return `<span class="mini" aria-hidden="true">${w.map(n => `<i style="height:${Math.max(6, Math.round(100*n/mx))}%"${n?"":' class="z"'}></i>`).join("")}</span>`; };
  const topShare = rows.length && totRent ? Math.max(...rows.map(r => r.rent90)) / totRent : 0;
  return `<div class="stats">
    <div class="stat"><span class="k">Sessions / week</span><span class="v">${totNow.toFixed(0)}</span><span class="d">last 4 weeks${totBase ? ` · ${totNow >= totBase ? "+" : ""}${Math.round(100*(totNow-totBase)/totBase)}% vs before` : ""}</span></div>
    <div class="stat"><span class="k">Growing</span><span class="v">${rows.filter(r=>r.status==="growing").length}</span><span class="d">${rows.filter(r=>r.status==="slipping"||r.status==="quiet").length} slowing or quiet</span></div>
    <div class="stat"><span class="k">Clients seen</span><span class="v">${rows.reduce((a,r)=>a+r.clients,0)}</span><span class="d">across trainers, last 30 days</span></div>
    <div class="stat"><span class="k">Largest trainer</span><span class="v">${Math.round(100*topShare)}%</span><span class="d">of rent, last 90 days</span></div>
  </div>
  <section class="card"><div class="card-h"><h2>Trainer trends</h2><span class="small muted">last 4 weeks vs the 12 before</span></div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Trainer</th><th>Trend</th><th>12 weeks</th><th class="num">Per week</th><th class="num">Clients · 30d</th><th class="num">Hours · 30d</th><th class="num">Rent share · 90d</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><div class="who">${avatar(r.t.name)}<span class="n">${esc(r.t.name)}</span></div></td><td><span class="chip ${L[r.status][1]}">${L[r.status][0]}</span>${r.change != null ? `<div class="small muted">${r.base.toFixed(1)} → ${r.recent.toFixed(1)}</div>` : ""}</td><td>${mini(r.weekly)}</td>
      <td class="num" style="font-weight:600">${r.recent.toFixed(1)}</td><td class="num">${r.clients}</td><td class="num">${r.hours.toFixed(0)}</td><td class="num">${totRent ? Math.round(100*r.rent90/totRent) : 0}%</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">Add trainers to see trends.</div>`}
    <p class="small muted">Clients are counted by distinct event titles, so they're approximate. A trainer is "gone quiet" after two weeks with no sessions.</p>
  </section>`;
}

/* ---------- settings ---------- */
function renderSettings(){
  const r = rentDefault();
  return `<div class="grid2"><section class="card"><div class="card-h"><h2>Studio</h2><button class="btn sm" data-act="rerun">Change setup</button></div>
    <dl class="kv"><dt>Name</dt><dd>${esc(D("name"))}</dd><dt>Calendar</dt><dd>${esc(D("calendarName")||D("calendarId"))}</dd>
      <dt>Capacity</dt><dd>${D("rooms")} trainers at once</dd><dt>Hours</dt><dd>${hourLabel(D("open"))}m–${hourLabel(D("close")%24)}m</dd>
      <dt>Default rent</dt><dd>${esc(ruleText(r))}</dd><dt>Counting from</dt><dd>${esc(D("historyStart"))}</dd></dl></section>
  <section class="card"><h2>Statements and matching</h2><div class="form">
    <div class="field full"><label for="st-tpl">Statement message</label><textarea id="st-tpl">${esc(D("statementTemplate"))}</textarea><span class="hint">{first} {studio} {month} {amount} {details} {balance}</span></div>
    <div class="field full"><label for="st-ign">Skip events containing these words</label><input id="st-ign" value="${esc((D("ignoreWords")||[]).join(", "))}"></div></div>
    ${(D("ignoredEmails")||[]).length ? `<h3>Ignored bookers</h3><div class="list">${D("ignoredEmails").map((e,i)=>`<div><span>${esc(e)}</span><button class="btn sm" data-act="unignore" data-i="${i}">Restore</button></div>`).join("")}</div>` : ""}
    <div class="actions"><button class="btn primary" data-act="save-settings">Save</button></div></section></div>`;
}

/* ---------- charts ---------- */
function niceStep(x){ const p = Math.pow(10, Math.floor(Math.log10(Math.max(x,1e-9)))); const f = x/p; return (f<=1?1:f<=2?2:f<=5?5:10)*p; }
function bars(el, data, opts){
  const W = Math.max(260, el.clientWidth || 500), H = opts.h || 180, pl = 46, pb = 22, pt = 10, pr = 4, iw = W-pl-pr, ih = H-pt-pb;
  const max = Math.max(1, ...data.flatMap(d => d.v)); const step = niceStep(max/4), top = Math.ceil(max/step)*step;
  const slot = iw/Math.max(1,data.length), n = data[0] ? data[0].v.length : 1, bw = Math.max(3, Math.min(18, slot*0.7/n));
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}">`;
  for (let v = 0; v <= top+1e-9; v += step){ const y = pt+ih-(v/top)*ih; s += `<line x1="${pl}" x2="${W-pr}" y1="${y}" y2="${y}" stroke="var(--line)" ${v?'stroke-dasharray="2 3"':""}/><text x="${pl-8}" y="${y+3.5}" text-anchor="end">${v>=1000?"$"+(v/1000).toFixed(v%1000?1:0)+"k":"$"+v}</text>`; }
  data.forEach((d,i) => { const x0 = pl + slot*i + (slot - bw*n - 2*(n-1))/2; d.v.forEach((v,j) => { const h = (v/top)*ih; s += `<rect x="${x0 + j*(bw+2)}" y="${pt+ih-h}" width="${bw}" height="${Math.max(0,h)}" rx="2.5" fill="${j===0?"var(--accent)":"var(--rent)"}"><title>${esc(d.tip)}</title></rect>`; });
    s += `<text x="${pl + slot*i + slot/2}" y="${H-6}" text-anchor="middle">${esc(d.label)}</text>`; });
  el.innerHTML = s + "</svg>";
}
function drawCharts(M){
  const hs = mkey(parseDay(D("historyStart")));
  const rb = document.querySelector('[data-chart="rentbars"]');
  if (rb){ const d = []; let k = M.curM; for (let i = 0; i < 6; i++){ const R = monthRent(M,k); d.unshift({label:MONTHS[mStart(k).getMonth()], v:[R.billed], tip:`${mLabel(k)}: ${money(R.billed)} rent, ${R.n} sessions`}); k = mPrev(k); if (k < hs) break; } bars(rb, d, {h:130, label:"Rent by month"}); }
  const rv = document.querySelector('[data-chart="revbars"]');
  if (rv){ const d = []; for (let k = hs; k <= M.curM; k = mNext(k)){ const R = monthRent(M,k); d.push({label:MONTHS[mStart(k).getMonth()], v:[R.billed, R.collected], tip:`${mLabel(k)}: ${money(R.billed)} billed, ${money(R.collected)} collected`}); } bars(rv, d, {h:220, label:"Rent billed and collected by month"}); }
}

/* ---------- modals ---------- */
function openModal(m){ S.modal = m; renderModal(); }
function closeModal(){ S.modal = null; $("#modal").innerHTML = ""; }
function statementText(t, M){
  const st = M.stats[t.id]; const openM = [...st.months].reverse().find(m => m.due && m.state !== "paid") || st.months[st.months.length-1];
  if (!openM) return "";
  const other = st.balance - Math.max(0, openM.rent - openM.paid);
  return String(D("statementTemplate")).replace(/\{(\w+)\}/g, (x,k) => ({first:firstName(t.name), studio:D("name"), month:mLabel(openM.month,true), amount:Math.round(openM.rent).toLocaleString(), details:openM.details, balance: other > 0.5 ? ` Total balance including earlier months: ${money(st.balance)}.` : ""})[k] ?? x);
}
function renderModal(){
  const m = S.modal; if (!m) return; const M = S.M; let title = "", body = "";
  if (m.type === "edit"){
    const t = m.id ? trainer(m.id) : {name:m.name||"", emails:m.email?[m.email]:[], rent:{mode:"default"}, active:true};
    const r = t.rent || {mode:"default"};
    title = m.id ? t.name : "New trainer";
    body = `<div class="form">
      <div class="field full"><label for="ed-name">Name</label><input id="ed-name" value="${esc(t.name)}"></div>
      <div class="field full"><label for="ed-emails">Books with these Google accounts</label><input id="ed-emails" value="${esc((t.emails||[]).join(", "))}"><span class="hint">Sessions created by these emails count as theirs. Comma separated.</span></div>
      <div class="field"><label for="ed-mode">Rent</label><select id="ed-mode">${Object.entries(RENT).map(([k,l])=>`<option value="${k}" ${(r.mode||"default")===k?"selected":""}>${l}${k==="default"?" ("+esc(ruleText(rentDefault()))+")":""}</option>`).join("")}</select></div>
      <div class="field"><label for="ed-ps">Per-session ($)</label><input id="ed-ps" type="number" min="0" value="${esc(r.perSession ?? rentDefault().perSession)}"></div>
      <div class="field"><label for="ed-mo">Monthly ($)</label><input id="ed-mo" type="number" min="0" value="${esc(r.monthly ?? rentDefault().monthly)}"></div>
      <div class="field"><label for="ed-start">Rent starts</label><input id="ed-start" type="date" value="${esc(t.startDate||"")}"><span class="hint">Optional. Blank = their first session.</span></div>
      <div class="field"><label for="ed-email">Contact email</label><input id="ed-email" type="email" value="${esc(t.email||"")}"></div>
      <div class="field"><label for="ed-phone">Phone</label><input id="ed-phone" type="tel" value="${esc(t.phone||"")}"></div>
      <label class="check full"><input type="checkbox" id="ed-active" ${t.active!==false?"checked":""}> Active</label></div>
    ${m.id && (t.payments||[]).length ? `<h3>Payments</h3><div class="list">${[...t.payments].sort((a,b)=>String(b.date).localeCompare(String(a.date))).map(p=>`<div><span>${fmtD(parseDay(p.date))} · ${esc(p.method||"")}${p.note?" · "+esc(p.note):""}</span><span style="font-weight:600">${money(num(p.amount))} <button class="btn sm" data-act="rm-pay" data-pid="${esc(p.id)}">Remove</button></span></div>`).join("")}</div>` : ""}
    ${m.id && S.linked && S.linked.has(m.id) ? `<p class="small muted">Linked to ${esc(t.linkedEmail||"their Trainer Tally account")}. They see their statement in their own app.</p>` : ""}
    <div class="actions"><button class="btn primary" data-act="save-trainer">Save</button>${m.id ? (m.confirmDel ? `<button class="btn danger" data-act="del-yes">Remove ${esc(t.name)}</button><button class="btn" data-act="del-no">Keep</button>` : `<button class="btn danger" data-act="del">Remove</button>`) : ""}</div>`;
  } else if (m.type === "payment"){
    const t = trainer(m.id || (S.trainers[0]||{}).id); title = "Log rent payment";
    if (!t) body = `<div class="empty">Add a trainer first.</div>`;
    else { const st = M.stats[t.id];
      body = `<div class="form"><div class="field full"><label for="pm-t">Trainer</label><select id="pm-t">${S.trainers.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(x=>`<option value="${x.id}" ${x.id===t.id?"selected":""}>${esc(x.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="pm-amt">Amount ($)</label><input id="pm-amt" type="number" min="0" value="${Math.round(st.balance || (st.cur ? st.cur.rent : 0))}"></div>
        <div class="field"><label for="pm-date">Date</label><input id="pm-date" type="date" value="${ymd(new Date())}"></div>
        <div class="field"><label for="pm-method">Method</label><select id="pm-method">${METHODS.map(x=>`<option>${x}</option>`).join("")}</select></div>
        <div class="field"><label for="pm-note">Note</label><input id="pm-note" placeholder="Optional"></div></div>
        <p class="small muted">Balance before this payment: ${money(st.balance)}</p>
        <div class="actions"><button class="btn primary" data-act="save-payment">Save payment</button></div>`; }
  } else if (m.type === "msg"){
    const t = trainer(m.id); title = "Statement · " + t.name; if (m.text == null) m.text = statementText(t, M);
    body = `<div class="field"><label for="msg-text">Message</label><textarea id="msg-text" rows="6">${esc(m.text)}</textarea></div>
      <div class="actions"><button class="btn primary" data-act="copy">Copy</button>${t.phone?`<a class="btn" href="sms:${esc(t.phone.replace(/[^\d+]/g,""))}?&body=${encodeURIComponent(m.text)}">Open text</a>`:""}${t.email?`<a class="btn" href="mailto:${esc(t.email)}?subject=${encodeURIComponent(D("name")+" rent")}&body=${encodeURIComponent(m.text)}">Open email</a>`:""}</div>
      ${S.linked && S.linked.has(t.id) ? `<p class="small muted">${esc(firstName(t.name))} also sees this statement in their Trainer Tally.</p>` : ""}`;
  } else if (m.type === "invite"){
    const t = trainer(m.id); title = "Invite " + t.name;
    body = m.code ? `<p class="small muted">Send this to ${esc(firstName(t.name))}. They sign in to Trainer Tally with Google and join your studio, then see their rent statement in their own app. The code works once and expires in 30 days.</p>
      <div class="field"><label for="inv-link">Link</label><input id="inv-link" readonly value="${esc(location.origin + "/?join=" + m.code)}"></div>
      <div class="field"><label>Code</label><div style="font-size:24px;font-weight:700;letter-spacing:.12em">${esc(m.code)}</div></div>
      <div class="actions"><button class="btn primary" data-act="copy-invite">Copy link</button></div>` : `<div class="note">Creating an invite…</div>`;
  } else if (m.type === "link"){
    const u = M.unknown[m.i]; title = "Who is " + (u ? u.email : "") + "?";
    body = `<div class="list">${S.trainers.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(t=>`<div><span class="who">${avatar(t.name)}<span>${esc(t.name)}</span></span><button class="btn sm" data-act="link-to" data-id="${t.id}">Choose</button></div>`).join("") || "<div>No trainers yet.</div>"}</div>`;
  }
  $("#modal").innerHTML = `<div class="scrim" data-act="close-scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-h"><h2>${esc(title)}</h2><button class="btn sm" data-act="close">Close</button></div>${body}</div></div>`;
}

/* ---------- actions ---------- */
document.addEventListener("click", async e => {
  const tb = e.target.closest("[data-tab]"); if (tb){ e.preventDefault(); S.tab = tb.getAttribute("data-tab"); closeModal(); render(); window.scrollTo({top:0}); return; }
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.getAttribute("data-act"), id = el.getAttribute("data-id");
  if (act === "close-scrim" && e.target !== el) return;
  if (el.tagName === "A" && el.getAttribute("href") === "#") e.preventDefault();
  const M = S.M;
  switch (act){
    case "close": case "close-scrim": closeModal(); break;
    case "theme": try { localStorage.setItem("tt-theme", el.getAttribute("data-mode")); } catch(x){} applyTheme(el.getAttribute("data-mode")); render(); break;
    case "signin": el.disabled = true; el.textContent = "Opening Google…"; signInWithGoogle(location.pathname); break;
    case "grant-calendar": el.disabled = true; el.textContent = "Opening Google…"; signInWithGoogle(location.pathname); break;
    case "signout": await sb.auth.signOut(); location.href = HOME; break;
    case "refresh": loadCalendar(true); break;
    case "cal-list": S.calList = null; S.calListErr = null; render(); break;
    case "mprev": S.month = mPrev(S.month); render(); break;
    case "mnext": if (S.month < M.curM) S.month = mNext(S.month); render(); break;
    case "heat-weeks": S.heatWeeks = +el.getAttribute("data-w"); render(); break;
    case "wiz-back": readWiz(); S.wiz.step--; render(); break;
    case "wiz-cancel": S.wiz = null; if (S.rerun){ S.rerun = false; S.studio = {...S.studio, data:{...S.studio.data, setupDone:true}}; } render(); break;
    case "rerun": S.wiz = null; S.calList = null; S.studio = {...S.studio, data:{...S.studio.data, setupDone:false}}; S.rerun = true; render(); break;
    case "wiz-next": {
      readWiz(); const w = S.wiz;
      if (w.step === 1 && (!w.name || !w.calendarId)){ toast(!w.name ? "Add your studio's name" : "Pick the studio calendar"); break; }
      if (w.step === 2 && !w.days.length){ toast("Pick at least one open day"); break; }
      if (w.step < 3){ w.step++; render(); break; }
      const cal = (S.calList||[]).find(c => c.id === w.calendarId);
      const data = {...((S.studio && S.studio.data) || {}), name:w.name, calendarId:w.calendarId, calendarName: cal ? (cal.summary||cal.id) : (D("calendarName")||w.calendarId), rooms:w.rooms, open:w.open, close:w.close, days:w.days, rent:w.rent, historyStart:w.historyStart, setupDone:true};
      S.wiz = null; S.rerun = false;
      if (S.studio && S.studio.id){ S.studio = {...S.studio, data}; await sb.from("studios").update({data, updated_at:new Date().toISOString()}).eq("id", S.studio.id); }
      else { const { data: row, error } = await sb.from("studios").insert({owner_id:S.session.user.id, data}).select("id,data").single(); if (error){ toast("Couldn't create the studio. Try again."); break; } S.studio = row; S.trainers = []; S.linked = new Set(); }
      S.tab = "trainers"; render(); loadCalendar(false); break;
    }
    case "new-trainer": openModal({type:"edit"}); break;
    case "edit": openModal({type:"edit", id}); break;
    case "del": S.modal.confirmDel = true; renderModal(); break;
    case "del-no": S.modal.confirmDel = false; renderModal(); break;
    case "del-yes": { const tid = S.modal.id; closeModal(); deleteTrainer(tid).then(()=>toast("Trainer removed")).catch(()=>{}); break; }
    case "save-trainer": {
      const m = S.modal, old = m.id ? trainer(m.id) : {}; const name = val("ed-name").trim(); if (!name){ toast("Add a name"); break; }
      const emails = val("ed-emails").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
      const clash = emails.find(em => S.trainers.some(t => t.id !== m.id && (t.emails||[]).includes(em))); if (clash){ toast(`${clash} already belongs to another trainer`); break; }
      const mode = val("ed-mode");
      const t = {...old, id:m.id || uid(), name, emails, rent: mode === "default" ? {mode:"default"} : {mode, perSession:num(val("ed-ps")), monthly:num(val("ed-mo"))},
        startDate: val("ed-start") || null, email: val("ed-email").trim(), phone: val("ed-phone").trim(), active: chk("ed-active"), payments: old.payments || []};
      closeModal(); saveTrainer(t).then(()=>toast(m.id ? "Saved" : "Trainer added")).catch(()=>{}); break;
    }
    case "payment": openModal({type:"payment", id}); break;
    case "save-payment": { const t = trainer(val("pm-t")), amt = num(val("pm-amt")); if (!t || !(amt > 0)){ toast("Enter an amount"); break; }
      const p = {id:uid(), date:val("pm-date") || ymd(new Date()), amount:amt, method:val("pm-method"), note:val("pm-note").trim()};
      closeModal(); saveTrainer({...t, payments:[...(t.payments||[]), p]}).then(()=>toast("Payment saved")).catch(()=>{}); break; }
    case "rm-pay": { const t = trainer(S.modal.id); saveTrainer({...t, payments:(t.payments||[]).filter(p => p.id !== el.getAttribute("data-pid"))}).then(()=>renderModal()).catch(()=>{}); break; }
    case "msg": openModal({type:"msg", id}); break;
    case "copy": { const t = document.getElementById("msg-text"); try { await navigator.clipboard.writeText(t.value); toast("Copied"); } catch(x){ t.select(); } break; }
    case "invite": { openModal({type:"invite", id}); const code = code8();
      const { error } = await sb.from("studio_invites").insert({code, studio_id:S.studio.id, trainer_id:id});
      if (error){ closeModal(); toast("Couldn't create an invite. Try again."); break; }
      if (S.modal && S.modal.type === "invite") { S.modal.code = code; renderModal(); } break; }
    case "copy-invite": { const t = document.getElementById("inv-link"); try { await navigator.clipboard.writeText(t.value); toast("Invite link copied"); } catch(x){ t.select(); } break; }
    case "u-add": { const u = M.unknown[+el.getAttribute("data-i")]; if (u) openModal({type:"edit", name:nameFromEmail(u.email), email:u.email}); break; }
    case "u-link": openModal({type:"link", i:+el.getAttribute("data-i")}); break;
    case "link-to": { const u = M.unknown[S.modal.i], t = trainer(id); closeModal(); if (u && t) saveTrainer({...t, emails:[...(t.emails||[]), u.email]}).then(()=>toast(`Added to ${t.name}`)).catch(()=>{}); break; }
    case "u-ignore": { const u = M.unknown[+el.getAttribute("data-i")]; if (u) saveStudio({ignoredEmails:[...(D("ignoredEmails")||[]), u.email]}).catch(()=>{}); break; }
    case "unignore": { const i = +el.getAttribute("data-i"); saveStudio({ignoredEmails:(D("ignoredEmails")||[]).filter((_,j)=>j!==i)}).catch(()=>{}); break; }
    case "save-settings": saveStudio({statementTemplate:val("st-tpl"), ignoreWords:val("st-ign").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean)}).then(()=>toast("Saved")).catch(()=>{}); break;
    case "export": { const rows = [["trainer","month","sessions","rent","paid","status"]];
      for (const t of S.trainers) for (const m of M.stats[t.id].months) rows.push([t.name, m.month, m.n, m.rent, Math.round(m.paid*100)/100, m.state]);
      downloadFile(`${(D("name")||"studio").replace(/\W+/g,"-").toLowerCase()}-rent-${ymd(new Date())}.csv`, rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g,'""') + '"' : v).join(",")).join("\n") + "\n"); break; }
  }
});
document.addEventListener("input", e => { if (e.target.id === "msg-text" && S.modal) S.modal.text = e.target.value; });
document.addEventListener("change", e => { if (e.target.id === "pm-t"){ S.modal = {type:"payment", id:e.target.value}; renderModal(); } });
document.addEventListener("keydown", e => { if (e.key === "Escape" && S.modal) closeModal(); });
let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => S.M && drawCharts(S.M), 150); });

/* ---------- boot ---------- */
(async function boot(){
  document.title = "Trainer Tally · Studio";
  renderChrome();
  S.session = await currentSession();
  if (!S.session){ S.screen = "signin"; render(); return; }
  await storeGoogleToken(S.session);
  sb.auth.onAuthStateChange(evt => { if (evt === "SIGNED_OUT") location.href = HOME; });
  try { await loadStudio(); } catch(e){ toast("Couldn't load your studio. Refresh to try again."); }
  S.screen = "app"; render();
  if (S.studio && S.studio.data && S.studio.data.setupDone) loadCalendar(false);
})();
