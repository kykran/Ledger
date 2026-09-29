/* Trainer Tally — shared app (engine + UI).
 * Runs unchanged in two homes, through an adapter:
 *   - adapter-claude.js : inside claude.ai (db + mcp Google Calendar connector)
 *   - adapter-hosted.js : the standalone web app (Supabase + Google Calendar API proxy)
 *
 * Adapter contract
 *   name                         "claude" | "hosted"
 *   init()                       -> {status:"ready"|"signin"|"nostore", account?:{email,name}}
 *   signIn?() / signOut?()
 *   watchProfile(cb, onErr)      -> unsubscribe   cb(profileObject|null)
 *   watchClients(cb, onErr)      -> unsubscribe   cb([{id, ...client}])
 *   setProfile(obj) setClient(id, body) deleteClient(id) deleteProfile()   -> Promise
 *     rejections carry {code}: "invalid_argument" (can't write here), "quota_exceeded", other
 *   calendar                     null | {call(tool, input, {refresh}) -> payload}
 *     tools: "list_calendars" -> {calendars:[{id,summary}], nextPageToken}
 *            "list_events"    -> {events:[googleEvent], nextPageToken, summary}
 *     rejections carry {code}: needs_reauth | server_not_connected | not_in_manifest | server_unavailable | tool_error | ...
 *   saveFile({filename, data})   -> Promise (reject {code:"declined"|"unavailable"})
 *   billing?                     {status() -> {plan, label}, checkout(), portal()}
 */
(function(){
"use strict";
const DAY = 86400000;
const YEAR0 = new Date().getFullYear() + "-01-01";
const SCHEMA = 1;
const DEFAULTS = {
  trainerName: "", myEmail: "", calendars: [], historyStart: YEAR0,
  ignoreWords: ["cancel","cancelled","canceled","free","comp","rescheduled","tentative","hold"],
  ignoredTitles: [], threshold: 3,
  rent: {mode:"none", perSession:20, monthly:660, percent:30, appliesTo:"studio"},
  defaults: {billing:"package", rate:100, packageSize:10},
  renewalTemplate: "Hi {first}! Quick heads-up: you have {left} session{s} left in your package. Your next {size}-session package is ${price}. Thanks! - {me}",
  invoiceTemplate: "Hi {first}! Your total for {month} is ${amount} ({details}). Thanks! - {me}"
};
const BILLING = {
  package: {label:"Package", long:"Prepaid package", hint:"Client buys a block of sessions up front (e.g. 10 for $1,000). Sessions count down; you get a renewal flag when they run low."},
  tab: {label:"Monthly bill", long:"Monthly bill", hint:"Put sessions on the calendar and bill at the end of the month: sessions × rate."},
  membership: {label:"Membership", long:"Monthly membership", hint:"Flat monthly fee, optionally with a session cap and an extra-session rate."},
  payg: {label:"Pay as you go", long:"Pay as you go", hint:"Client pays at each session. Nothing to chase; still counted in income."}
};
const METHODS = ["Venmo","Zelle","Cash","Check","Card","PayPal","Other"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const LEAD = new Set(["pt","session","sesh","training","personal","train","with","w","appt","appointment"]);
const TRAIL = new Set(["pt","session","sesh","training","appt"]);
const ICON = {
  overview:'<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>',
  calendar:'<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  clients:'<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.9-4.6 5.5-4.6s4.9 1.6 5.5 4.6M16 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.6.6 2.7 2 3 4.4"/>',
  billing:'<path d="M6 3.5h12v17l-2.5-1.6L13 20.5l-2.5-1.6L8 20.5l-2-1.3z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>',
  trends:'<path d="M4 19.5h16M6.5 16l4-5 3 3 5-6.5"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  refresh:'<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.3L20 15.5M20 20v-4.5h-4.5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  cash:'<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v5M17.5 9.5v5"/>',
  left:'<path d="m14.5 6-6 6 6 6"/>', right:'<path d="m9.5 6 6 6-6 6"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon:'<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  auto:'<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>'
};
const ic = (k, extra) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"${extra||""}>${ICON[k]||""}</svg>`;

let A = null; // adapter
const S = {
  prof:null, profLoaded:false, clients:[], clientsLoaded:false, account:null,
  events:[], cal:{state:"idle", done:0, total:0, error:null, at:null}, calList:null, calListErr:null, calLoading:false, detectedEmail:"",
  tab:"overview", month:null, modal:null, readOnly:false, screen:"loading", wiz:null, rerunning:false,
  confirmReset:false, day:null, trendMode:"net", restore:null, billingStatus:null
};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = (v, d=0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
const money = v => (v < -0.5 ? "-$" : "$") + Math.round(Math.abs(v)).toLocaleString();
const money2 = v => "$" + (Math.round(v*100)/100).toLocaleString(undefined,{minimumFractionDigits:0, maximumFractionDigits:2});
const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const mkey = d => d.getFullYear()+"-"+pad(d.getMonth()+1);
const parseDay = s => { const [y,m,d] = String(s||"").slice(0,10).split("-").map(Number); return new Date(y||2000, (m||1)-1, d||1); };
const mStart = k => { const [y,m] = k.split("-").map(Number); return new Date(y, m-1, 1); };
const mNext = k => { const d = mStart(k); return mkey(new Date(d.getFullYear(), d.getMonth()+1, 1)); };
const mPrev = k => { const d = mStart(k); return mkey(new Date(d.getFullYear(), d.getMonth()-1, 1)); };
const mLabel = (k, long) => { const d = mStart(k); return (long ? d.toLocaleDateString(undefined,{month:"long"}) : MONTHS[d.getMonth()]) + " " + d.getFullYear(); };
const mName = k => mStart(k).toLocaleDateString(undefined,{month:"long"});
const fmtD = d => d ? d.toLocaleDateString(undefined,{month:"short",day:"numeric"}) : "–";
const fmtT = d => d ? d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}) : "";
const sow = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; };
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
const norm = s => (s||"").toLowerCase().replace(/[’']/g,"").replace(/[^a-z0-9+&\s]/g," ").replace(/\s+/g," ").trim();
function clean(s){
  const w = norm(s).split(" ").filter(Boolean);
  while (w.length > 1 && LEAD.has(w[0])) w.shift();
  while (w.length > 1 && TRAIL.has(w[w.length-1])) w.pop();
  return w.join(" ");
}
const firstName = n => String(n||"").trim().split(/[\s+&]/)[0] || "there";
const initials = n => String(n||"?").trim().split(/[\s+&]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join("") || "?";
function hueOf(s){ let h = 0; for (const ch of String(s)) h = (h*31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
const colorOf = s => `hsl(${hueOf(s)} 52% 46%)`;
const avatar = c => `<span class="av" style="background:${colorOf(c.name)}" aria-hidden="true">${esc(initials(c.name))}</span>`;
const P = k => (S.prof && S.prof[k] !== undefined && S.prof[k] !== null) ? S.prof[k] : DEFAULTS[k];
const rentCfg = () => ({...DEFAULTS.rent, ...(P("rent")||{})});
const defs = () => ({...DEFAULTS.defaults, ...(P("defaults")||{})});
function toast(msg){ const t = document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(), 2800); }
const client = id => S.clients.find(c => c.id === id);
const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
const chk = id => { const el = document.getElementById(id); return !!(el && el.checked); };
const plain = o => JSON.parse(JSON.stringify(o));

/* ---------- theme ---------- */
const root = document.documentElement;
const hostTheme = root.getAttribute("data-theme");
function getThemePref(){ try { return localStorage.getItem("tt-theme") || "system"; } catch(e){ return "system"; } }
function applyTheme(mode){
  if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
  else if (hostTheme) root.setAttribute("data-theme", hostTheme); else root.removeAttribute("data-theme");
}
function setTheme(mode){ try { localStorage.setItem("tt-theme", mode); } catch(e){} applyTheme(mode); renderChrome(); if (S.M) drawCharts(S.M); }
applyTheme(getThemePref());

/* ---------- storage ---------- */
const chains = {};
function queued(key, fn){ const p = (chains[key] || Promise.resolve()).catch(()=>{}).then(fn); chains[key] = p; return p; }
function storeFail(err){
  if (err && err.code === "invalid_argument"){ S.readOnly = true; renderStatus(); toast("You can view this page but can't save to it"); }
  else if (err && err.code === "quota_exceeded") toast("Storage is full. Remove old clients to add more.");
  else toast("Couldn't save. Check your connection and try again.");
  throw err;
}
function saveProfile(patch){
  const next = {...(S.prof||{}), ...patch, schema:SCHEMA, updatedAt:new Date().toISOString()};
  S.prof = next; render();
  return queued("profile", () => A.setProfile(plain(next))).catch(storeFail);
}
function saveClient(c){
  const body = {...c}; delete body.id; body.updatedAt = new Date().toISOString();
  const i = S.clients.findIndex(x => x.id === c.id);
  if (i >= 0) S.clients[i] = c; else S.clients.push(c);
  render();
  return queued("c:"+c.id, () => A.setClient(c.id, plain(body))).catch(storeFail);
}
function removeClient(id){
  S.clients = S.clients.filter(c => c.id !== id); render();
  return queued("c:"+id, () => A.deleteClient(id)).catch(storeFail);
}

/* ---------- calendar ---------- */
function calErrorText(err){
  const c = err && err.code;
  const where = A && A.name === "hosted" ? "Sign out and back in to reconnect Google Calendar." : "Reconnect it in claude.ai Settings → Connectors, then press Retry.";
  if (c === "needs_reauth") return "Google Calendar access has expired. " + where;
  if (c === "server_not_connected" || c === "selection_required") return A && A.name === "hosted" ? "Google Calendar isn't connected. Sign out and back in, and allow calendar access." : "Google Calendar isn't connected to your Claude account. Add it in claude.ai Settings → Connectors, then press Retry.";
  if (c === "not_in_manifest" || c === "consent_required") return "Calendar access is turned off for this page. Allow Google Calendar when asked, then press Retry.";
  if (c === "blocked_by_policy" || c === "approval_required") return "Your organization's policy blocks calendar access here.";
  if (c === "server_unavailable" || c === "rate_limited") return "Google Calendar didn't answer in time. Press Retry in a moment.";
  if (c === "not_granted" || c === "capability_disabled") return "This view can't reach your calendar.";
  if (c === "calendar_scope") return "Trainer Tally can't see your calendar yet. Sign out, sign back in, and tick the box that allows access to Google Calendar.";
  if (c === "subscription_required") return "Your free trial has ended. Subscribe in Settings to keep counting sessions from your calendar.";
  if (c === "tool_error") return "Google Calendar returned an error: " + (err.message||"");
  return "Couldn't read the calendar" + (err && err.message ? ": " + err.message : ".");
}
const callCal = (tool, input, refresh) => A.calendar.call(tool, input, {refresh:!!refresh});
async function fetchCalendarList(){
  S.calListErr = null;
  try {
    const out = []; let token = null, g = 0;
    do { const p = await callCal("list_calendars", token ? {pageSize:250, pageToken:token} : {pageSize:250}); (p.calendars||[]).forEach(c => out.push(c)); token = p.nextPageToken || null; g++; } while (token && g < 5);
    S.calList = out.filter(c => c && c.id && !/#holiday|#contacts|#weeknum|addressbook/i.test(c.id));
    let me = P("myEmail") || (S.account && S.account.email) || "";
    if (!me){
      try { const p = await callCal("list_events", {calendarId:"primary", pageSize:1, startTime:new Date(Date.now()-DAY).toISOString(), endTime:new Date().toISOString()}); if (p.summary && /@/.test(p.summary)) me = p.summary; } catch(e){}
    }
    S.detectedEmail = me;
  } catch(err){ S.calListErr = err; }
}
function monthChunks(a, b){ const out=[]; let x = new Date(a); while (x < b){ const y = new Date(x.getFullYear(), x.getMonth()+1, 1); out.push([x, y < b ? y : b]); x = y; } return out; }
async function fetchRange(calId, a, b, refresh){
  const out = []; let token = null, g = 0;
  do {
    const input = {calendarId:calId, startTime:a.toISOString(), endTime:b.toISOString(), orderBy:"startTime", pageSize:250, eventType:["DEFAULT"]};
    if (token) input.pageToken = token;
    const p = await callCal("list_events", input, refresh);
    (p.events||[]).forEach(e => out.push(e));
    token = p.nextPageToken || null; g++;
  } while (token && g < 20);
  return out;
}
let loadSeq = 0;
async function loadCalendar(refresh){
  const cals = (P("calendars")||[]).filter(c => c.use);
  if (!A.calendar || !cals.length){ S.cal = {state:"idle", done:0, total:0}; S.events = []; renderStatus(); render(); return; }
  const seq = ++loadSeq;
  let start = parseDay(P("historyStart"));
  for (const c of S.clients){ const d = c.billingStart ? parseDay(c.billingStart) : null; if (d && d < start) start = d; for (const p of (c.packages||[])) if (p.start){ const e = new Date(p.start); if (e < start) start = new Date(e.getFullYear(), e.getMonth(), 1); } }
  const end = addDays(new Date(), 63);
  const jobs = [];
  for (const [a,b] of monthChunks(start, end)) for (const c of cals) jobs.push([c,a,b]);
  S.cal = {state:"loading", done:0, total:jobs.length, error:null, at:S.cal.at};
  renderStatus();
  const results = []; let i = 0, failed = null;
  async function worker(){ while (i < jobs.length && !failed){ const j = jobs[i++]; try { const evs = await fetchRange(j[0].id, j[1], j[2], refresh); evs.forEach(e => results.push([e, j[0]])); } catch(err){ failed = err; } S.cal.done++; if (seq === loadSeq) renderStatus(); } }
  await Promise.all([worker(),worker(),worker(),worker()]);
  if (seq !== loadSeq) return;
  if (failed){ S.cal.state = "error"; S.cal.error = failed; renderStatus(); render(); return; }
  const me = (P("myEmail")||"").toLowerCase(), seen = new Set(), evs = [];
  for (const [e, cal] of results){
    if (!e || e.status === "cancelled" || !e.start || !e.start.dateTime) continue;
    const key = cal.id + ":" + e.id; if (seen.has(key)) continue; seen.add(key);
    const creator = ((e.creator||{}).email||"").toLowerCase(), org = ((e.organizer||{}).email||"").toLowerCase();
    if (cal.mineOnly && me && creator !== me && org !== me) continue;
    evs.push({id:e.id, title:(e.summary||"").trim(), date:new Date(e.start.dateTime), cal:cal.id, calName:cal.name, studio:!!cal.studio});
  }
  evs.sort((a,b)=>a.date-b.date);
  S.events = evs; S.cal = {state:"ready", done:jobs.length, total:jobs.length, error:null, at:new Date()};
  renderStatus(); render();
}

/* ---------- engine ---------- */
function buildMatcher(){
  const list = [];
  for (const c of S.clients) for (const n of [c.name, ...(c.aliases||[])]){ const a = clean(n); if (a) list.push({a, id:c.id}); }
  list.sort((x,y)=>y.a.length-x.a.length);
  return t => { for (const {a,id} of list){ if (t === a) return id; if (t.startsWith(a+" ") && t.slice(a.length+1).split(" ").length <= 2) return id; } return null; };
}
function rentApplies(c, s){ const r = rentCfg(); return !c.noRent && (r.appliesTo === "all" || s.studio); }
function sessionRent(s, value, c){
  const r = rentCfg();
  if (!rentApplies(c, s)) return 0;
  if (r.mode === "perSession") return num(r.perSession);
  if (r.mode === "percent") return value * num(r.percent)/100;
  return 0;
}
function compute(){
  const now = new Date(), curM = mkey(now);
  const match = buildMatcher();
  const ignoreW = (P("ignoreWords")||[]).map(norm).filter(Boolean);
  const ignoredT = new Set((P("ignoredTitles")||[]).map(clean));
  const byClient = {}; S.clients.forEach(c => byClient[c.id] = []);
  const unmatched = {};
  for (const e of S.events){
    const t = clean(e.title); if (!t) continue;
    const words = norm(e.title).split(" ");
    const skip = ignoreW.some(w => words.includes(w));
    const id = match(t);
    if (!id){
      if (skip || ignoredT.has(t)) continue;
      const u = unmatched[t] || (unmatched[t] = {title:e.title, key:t, count:0, past:0, last:null, next:null});
      u.count++; if (e.date < now){ u.past++; u.last = e.date; } else if (!u.next) u.next = e.date;
      continue;
    }
    byClient[id].push({date:e.date, cal:e.cal, calName:e.calName, studio:e.studio, title:e.title, clientId:id, billable:!skip, future:e.date >= now, value:0, rent:0});
  }
  const stats = {};
  for (const c of S.clients) stats[c.id] = clientStats(c, byClient[c.id]||[], now, curM);
  const recentCut = now - 120*DAY;
  const um = Object.values(unmatched).filter(u => u.count >= 2 && ((u.last && u.last >= recentCut) || u.next)).sort((a,b)=>b.count-a.count).slice(0,40);
  return {now, curM, stats, unmatched:um, byClient};
}
function clientStats(c, list, now, curM){
  const bill = c.billing || "package";
  const all = list.filter(s => s.billable);
  const past = all.filter(s => !s.future), future = all.filter(s => s.future);
  const st = {c, bill, past, future, skipped:list.filter(s=>!s.billable), status:"ok", label:"On track", monthly:{}, balance:0, invoices:[]};
  const d56 = now - 56*DAY;
  const recent = past.filter(s => s.date >= d56);
  const first = past.length ? past[0].date : null;
  const weeks = first ? Math.min(8, Math.max(1, (now - Math.max(+first, d56)) / (7*DAY))) : 8;
  st.pace = c.active === false ? 0 : recent.length ? recent.length/weeks : future.filter(s => s.date < now + 28*DAY).length/4;
  st.rentShare = recent.length ? recent.filter(s => rentApplies(c, s)).length/recent.length : (c.noRent ? 0 : 1);
  st.last = past.length ? past[past.length-1].date : null;
  st.next = future[0] ? future[0].date : null;
  st.rate = num(c.rate, num(defs().rate, 100));

  if (bill === "package") packageStats(c, st, now);
  else if (bill === "payg"){ all.forEach(s => s.value = st.rate); st.perSession = st.rate; st.label = "Pays per session"; st.status = "info"; }
  else monthStats(c, st, now, curM);

  for (const s of all) s.rent = sessionRent(s, s.value, c);
  const bucket = k => st.monthly[k] || (st.monthly[k] = {n:0, earned:0, rent:0, collected:0});
  for (const s of past){ const m = bucket(mkey(s.date)); m.n++; m.earned += s.value; m.rent += s.rent; if (bill === "payg") m.collected += s.value; }
  if (bill === "membership") for (const inv of st.invoices) bucket(inv.month).earned = inv.amount;
  for (const p of (c.payments||[])){ const k = String(p.date||"").slice(0,7); if (k) bucket(k).collected += num(p.amount); }
  return st;
}
function packageStats(c, st, now){
  const pk = c.packages || [];
  const dSize = num(c.packageSize, num(defs().packageSize, 10)) || 10;
  const dPrice = num(c.packagePrice, st.rate * dSize);
  st.nextSize = dSize; st.nextPrice = dPrice;
  if (!pk.length){
    [...st.past, ...st.future].forEach(s => s.value = dPrice/dSize);
    st.status = "setup"; st.label = "Set package"; st.perSession = dPrice/dSize; return;
  }
  const base = new Date(pk[0].start);
  const caps = pk.map((p,i) => Math.max(0, num(p.size) - (i === 0 ? num(p.used0) : 0)));
  const used = caps.map(() => 0);
  let i = 0; const overS = [];
  for (const s of st.past){
    if (s.date < base){ s.value = num(pk[0].price)/Math.max(1,num(pk[0].size)); continue; }
    while (i < caps.length && used[i] >= caps[i]) i++;
    if (i < caps.length){ used[i]++; s.value = num(pk[i].price)/Math.max(1,num(pk[i].size)); s.pkg = i; }
    else { s.value = dPrice/dSize; s.over = true; overS.push(s); }
  }
  const cap = caps.reduce((a,b)=>a+b,0), usedT = used.reduce((a,b)=>a+b,0) + overS.length;
  st.remaining = cap - usedT;
  let cur = used.findIndex((u,j) => u < caps[j]); if (cur < 0) cur = pk.length - 1;
  const cp = pk[cur];
  st.current = {...cp, index:cur, size:num(cp.size), usedIn: used[cur] + (cur === 0 ? num(cp.used0) : 0)};
  st.perSession = num(cp.price)/Math.max(1,num(cp.size));
  st.future.forEach(s => s.value = st.perSession);
  st.unpaid = pk.map((p,j)=>({p,j})).filter(({p,j}) => !p.paidDate && (used[j] > 0 || j === cur || (j === 0 && num(p.used0) > 0)));
  st.unpaidAmt = st.unpaid.reduce((a,{p}) => a + num(p.price), 0);
  st.over = overS.length;
  const th = num(P("threshold"), 3);
  if (st.remaining < 0){ st.status = "out"; st.label = `${-st.remaining} past package`; }
  else if (st.remaining === 0){ st.status = "out"; st.label = "Out of sessions"; }
  else if (st.remaining <= th){ st.status = "low"; st.label = `${st.remaining} left`; }
  else { st.status = "ok"; st.label = `${st.remaining} left`; }
  if (st.unpaid.length && st.status !== "out"){ st.status = "owes"; st.label = "Package unpaid"; }
  st.balance = st.unpaidAmt;
  let left = st.remaining;
  if (left <= 0) st.runout = overS.length ? overS[0].date : (st.past.length ? st.past[st.past.length-1].date : now);
  else {
    for (const s of st.future){ left--; if (left <= 0){ st.runout = s.date; break; } }
    if (!st.runout && st.pace > 0){ const from = st.future.length ? st.future[st.future.length-1].date : now; st.runout = new Date(+from + left/st.pace*7*DAY); st.runoutEst = true; }
  }
}
function monthStats(c, st, now, curM){
  const bill = st.bill;
  const bs = c.billingStart ? parseDay(c.billingStart) : parseDay(P("historyStart"));
  const fee = num(c.fee), inc = num(c.included), over = num(c.overageRate, st.rate);
  const byM = {};
  for (const s of [...st.past, ...st.future]){ const k = mkey(s.date); (byM[k] = byM[k] || []).push(s); }
  for (const k in byM){
    const list = byM[k];
    if (bill === "tab") list.forEach(s => s.value = st.rate);
    else { const n = Math.max(1, list.length); const amt = fee + (inc > 0 ? Math.max(0, n - inc)*over : 0); list.forEach(s => s.value = amt/n); }
  }
  st.perSession = bill === "tab" ? st.rate : (st.pace ? fee/Math.max(1, st.pace*4.33) : fee);
  const invoices = [];
  for (let k = mkey(bs); k <= curM; k = mNext(k)){
    const list = (byM[k]||[]).filter(s => !s.future); const n = list.length;
    const sched = (byM[k]||[]).filter(s => s.future).length;
    let amount, details;
    if (bill === "tab"){ amount = n * st.rate; details = `${n} session${n===1?"":"s"} at ${money(st.rate)}`; }
    else { const extra = inc > 0 ? Math.max(0, n - inc) : 0; amount = fee + extra*over; details = `${mLabel(k,true)} membership` + (extra ? ` plus ${extra} extra session${extra===1?"":"s"} at ${money(over)}` : ""); }
    const running = k === curM && bill === "tab";
    invoices.push({month:k, n, sched, amount, details, due: bill === "membership" ? true : k < curM, running, paid:0});
  }
  let pool = (c.payments||[]).filter(p => !p.date || parseDay(p.date) >= addDays(bs,-40)).reduce((a,p)=>a+num(p.amount),0);
  st.paidTotal = pool;
  for (const inv of invoices){ const take = Math.min(pool, inv.amount); inv.paid = take; pool -= take; inv.state = inv.amount <= 0 ? "none" : take >= inv.amount - 0.5 ? "paid" : take > 0 ? "partial" : inv.running ? "running" : "open"; }
  st.credit = pool;
  st.invoices = invoices;
  const dueAmt = invoices.filter(i => i.due).reduce((a,i)=>a+i.amount,0);
  st.balance = Math.max(0, dueAmt - st.paidTotal);
  const cur = invoices.find(i => i.month === curM);
  st.running = cur && cur.running ? cur.amount : 0;
  if (st.balance > 0.5){ st.status = "owes"; st.label = "Owes " + money(st.balance); }
  else if (bill === "tab"){ st.status = "info"; st.label = cur && cur.amount ? `${money(cur.amount)} so far` : "Up to date"; }
  else { st.status = "ok"; st.label = "Paid up"; }
}
function monthTotals(M, k){
  let n=0, earned=0, rent=0, collected=0;
  for (const c of S.clients){ const m = M.stats[c.id].monthly[k]; if (m){ n += m.n; earned += m.earned; rent += m.rent; collected += m.collected; } }
  const r = rentCfg();
  const hs = mkey(parseDay(P("historyStart")));
  if (r.mode === "monthly" && k >= hs && k <= M.curM) rent += num(r.monthly);
  return {n, earned, rent, net:earned-rent, collected};
}
function projectMonth(M, k){
  const now = M.now, ms = mStart(k), me = mStart(mNext(k));
  if (me <= now) return {n:0, earned:0, rent:0, net:0};
  const horizon = addDays(now, 63);
  let n=0, earned=0, rent=0;
  const r = rentCfg();
  for (const c of S.clients){
    if (c.active === false) continue;
    const st = M.stats[c.id];
    let k2 = 0;
    for (let w = sow(now); w < me; w = addDays(w,7)){
      const we = addDays(w,7);
      const a = new Date(Math.max(+w, +ms, +now)), b = new Date(Math.min(+we, +me));
      if (b <= a) continue;
      const frac = (b - a) / (7*DAY);
      const sched = st.future.filter(s => s.date >= a && s.date < b).length;
      k2 += w >= horizon ? st.pace*frac : Math.max(sched, st.pace*frac);
    }
    n += k2;
    if (st.bill === "membership"){ if (k > M.curM) earned += num(c.fee); }
    else earned += k2 * (st.perSession || 0);
    const v = st.bill === "membership" ? (k2 ? num(c.fee)/Math.max(1,k2) : 0) : (st.perSession||0);
    if (!c.noRent){
      if (r.mode === "perSession") rent += k2 * st.rentShare * num(r.perSession);
      else if (r.mode === "percent") rent += (st.bill === "membership" && k > M.curM ? num(c.fee) * st.rentShare : k2 * v * st.rentShare) * num(r.percent)/100;
    }
  }
  if (r.mode === "monthly" && k > M.curM) rent += num(r.monthly);
  return {n, earned, rent, net:earned-rent};
}
function sessionsIn(M, a, b){
  const out = [];
  for (const c of S.clients){ const st = M.stats[c.id]; for (const s of [...st.past, ...st.future]) if (s.date >= a && s.date < b) out.push({...s, c}); }
  return out.sort((x,y)=>x.date-y.date);
}

/* ---------- chrome ---------- */
const inAppNow = () => S.screen === "data" && S.profLoaded && S.clientsLoaded && !!(S.prof && S.prof.setupDone);
const TABS = [["overview","Home","Overview"],["calendar","Calendar","Calendar"],["clients","Clients","Clients"],["billing","Billing","Billing"],["trends","Trends","Trends"],["settings","Settings","Settings"]];
const MONTH_TABS = new Set(["overview","calendar","billing","trends"]);
function renderChrome(){
  const app = $("#app");
  const inApp = inAppNow();
  app.classList.toggle("bare", !inApp);
  const M = S.M;
  const attn = inApp && M ? attention(M).length : 0, sugg = inApp && M ? M.unmatched.length : 0;
  const badge = k => k === "overview" && attn ? attn : k === "clients" && sugg ? sugg : 0;
  $("#nav").innerHTML = TABS.map(([k,l]) => `<button data-tab="${k}" ${S.tab===k?'aria-current="page"':""}>${ic(k)}<span>${l}</span>${badge(k)?`<span class="badge">${badge(k)}</span>`:""}</button>`).join("");
  $("#tabbar").innerHTML = TABS.map(([k,l]) => `<button data-tab="${k}" ${S.tab===k?'aria-current="page"':""} aria-label="${l}">${ic(k)}<span>${l}</span>${badge(k)?'<i class="dot"></i>':""}</button>`).join("");
  const pref = getThemePref();
  const themeBtn = `<div class="seg" role="group" aria-label="Appearance">${[["system","auto","Auto"],["light","sun","Light"],["dark","moon","Dark"]].map(([m,i,l])=>`<button data-act="theme" data-mode="${m}" aria-pressed="${pref===m}" title="${l}">${ic(i,' style="width:14px;height:14px"')}</button>`).join("")}</div>`;
  $("#sidefoot").innerHTML = `${themeBtn}${S.account && S.account.email ? `<span>${esc(S.account.email)}</span>` : ""}${A && A.signOut && S.account ? `<button class="btn sm ghost" data-act="signout" style="align-self:flex-start;padding-left:0">Sign out</button>` : ""}`;
  const t = TABS.find(x => x[0] === S.tab);
  $("#pagetitle").textContent = inApp ? t[2] : "Trainer Tally";
  $("#pagesub").textContent = inApp ? (S.cal.at ? `Calendar read ${fmtT(S.cal.at)}` + (P("trainerName") ? ` · ${P("trainerName")}` : "") : (P("trainerName") || "")) : "Sessions, packages and billing from your calendar";
  const ms = $("#monthsw");
  ms.hidden = !(inApp && MONTH_TABS.has(S.tab) && S.month);
  if (!ms.hidden){ const cur = M ? M.curM : S.month; ms.innerHTML = `<button data-act="mprev" aria-label="Previous month">${ic("left")}</button><span>${esc(mLabel(S.month, true))}</span><button data-act="mnext" aria-label="Next month" ${S.month>=cur?"disabled":""}>${ic("right")}</button>`; }
  $("#actions").innerHTML = inApp ? `<button class="btn icon" data-act="refresh" title="Refresh calendar" aria-label="Refresh calendar" ${S.cal.state==="loading"?"disabled":""}>${ic("refresh")}</button>
    <button class="btn" data-act="payment" ${S.readOnly?"disabled":""}>${ic("cash")}<span class="lbl">Payment</span></button>
    <button class="btn primary" data-act="new-client" ${S.readOnly?"disabled":""}>${ic("plus")}<span class="lbl">Client</span></button>` : (S.screen !== "signin" ? themeBtn : "");
}
function renderStatus(){
  renderChrome();
  let h = "";
  if (S.readOnly) h += `<div class="banner err"><span>You can see this page but it can't save your data. Ask the owner to share it with you as an Editor, then reload.</span></div>`;
  if (S.cal.state === "loading"){ const pct = S.cal.total ? Math.round(100*S.cal.done/S.cal.total) : 0; h += `<div class="banner"><span class="small">Reading your calendar…</span><div class="prog"><b style="width:${pct}%"></b></div><span class="small">${pct}%</span></div>`; }
  else if (S.cal.state === "error") h += `<div class="banner err"><span>${esc(calErrorText(S.cal.error))}</span><button class="btn sm" data-act="refresh">Retry</button></div>`;
  $("#status").innerHTML = inAppNow() ? h : "";
}
function render(){
  const main = $("#main");
  if (S.screen === "loading"){ renderChrome(); return; }
  if (S.screen === "signin"){ S.M = null; renderChrome(); main.innerHTML = renderSignIn(); return; }
  if (S.screen === "nostore"){ S.M = null; renderChrome(); main.innerHTML = `<div class="card"><div class="empty"><b>Sign in to keep your ledger</b><span>Open this page while signed in. Your clients and settings are saved privately to your account, so nobody else who opens it can see them.</span></div></div>`; return; }
  if (!S.profLoaded || !S.clientsLoaded){ renderChrome(); return; }
  if (!S.prof || !S.prof.setupDone){ S.M = null; renderChrome(); renderStatus(); main.innerHTML = renderSetup(); applyRentVisibility(); return; }
  const M = compute(); S.M = M;
  if (!S.month) S.month = M.curM;
  renderChrome(); renderStatus();
  let h = "";
  if (S.tab === "overview") h = renderOverview(M);
  else if (S.tab === "calendar") h = renderCalendar(M);
  else if (S.tab === "clients") h = renderClients(M);
  else if (S.tab === "billing") h = renderBilling(M);
  else if (S.tab === "trends") h = renderTrends(M);
  else h = renderSettings();
  main.innerHTML = h;
  drawCharts(M);
  if (S.modal) renderModal();
}

/* ---------- sign in (hosted) ---------- */
function renderSignIn(){
  return `<div class="signin"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5v14M9.5 5v14M14 5v14M18.5 5v14M3 16.5 21 7.5"/></svg></span>
    <h1>Trainer Tally</h1>
    <p class="muted">Your training business, counted from the calendar you already use. Packages, monthly bills, rent and renewals in one place.</p>
    <button class="btn primary" data-act="signin" style="padding:11px 18px;font-size:14px">Continue with Google</button>
    <p class="small muted">Trainer Tally reads your Google Calendar to count sessions. It never changes or deletes your events. <a href="/privacy.html">Privacy</a></p></div>`;
}

/* ---------- setup ---------- */
function wizDefaults(){
  return {step:1, name:P("trainerName")||(S.account && S.account.name)||"", cals:(P("calendars")||[]).map(c=>({...c})), rent:{...rentCfg()}, defaults:{...defs()}, historyStart:P("historyStart"), threshold:P("threshold")};
}
function syncWizCals(){
  const w = S.wiz; if (!S.calList || !w) return;
  const have = new Map(w.cals.map(c => [c.id, c]));
  const me = (S.detectedEmail||"").toLowerCase();
  w.cals = S.calList.map(c => { const h = have.get(c.id); return h ? {...h, name:c.summary||c.id} : {id:c.id, name:c.summary||c.id, use: c.id.toLowerCase() === me, studio:false, mineOnly:false}; });
}
function renderSetup(){
  if (!S.wiz) S.wiz = wizDefaults();
  const w = S.wiz;
  const steps = ["Your calendars","Studio rent","How clients pay"];
  let body = "";
  if (w.step === 1){
    if (A.calendar && !S.calList && !S.calListErr && !S.calLoading){ S.calLoading = true; fetchCalendarList().finally(()=>{ S.calLoading = false; syncWizCals(); render(); }); }
    let cal;
    if (!A.calendar) cal = `<div class="note">Connect Google Calendar to count sessions automatically.</div>`;
    else if (S.calListErr) cal = `<div class="banner err"><span>${esc(calErrorText(S.calListErr))}</span><button class="btn sm" data-act="cal-list">Retry</button></div>`;
    else if (!S.calList) cal = `<div class="note">Looking up your calendars… Allow Google Calendar if you're asked.</div>`;
    else cal = `<div>${w.cals.map((c,i) => `<div class="calrow">
        <input type="checkbox" id="wc-use-${i}" data-wcal="${i}" data-k="use" ${c.use?"checked":""}>
        <label for="wc-use-${i}"><b>${esc(c.name)}</b><div class="small muted">${esc(c.id.length>44?c.id.slice(0,42)+"…":c.id)}</div></label>
        ${c.use ? `<div class="opts"><label class="check"><input type="checkbox" data-wcal="${i}" data-k="studio" ${c.studio?"checked":""}> Sessions here are at the studio (rent applies)</label>
        <label class="check"><input type="checkbox" data-wcal="${i}" data-k="mineOnly" ${c.mineOnly?"checked":""}> Shared calendar: only count events I created</label></div>` : ""}
      </div>`).join("")}</div>`;
    body = `<div class="card"><h2>Which calendars hold your sessions?</h2>
      <p class="small muted">Tick every calendar you put client sessions on. Name each event after the client (for example "Maria" or "PT Maria") and the tally does the rest.</p>
      ${cal}
      <div class="form">
        <div class="field"><label for="w-name">Your name (signs your messages)</label><input id="w-name" value="${esc(w.name)}" placeholder="First name"></div>
        <div class="field"><label for="w-start">Count sessions from</label><input id="w-start" type="date" value="${esc(w.historyStart)}"><span class="hint">Earlier dates read more calendar</span></div>
      </div></div>`;
  } else if (w.step === 2){
    const r = w.rent;
    const opt = (m, t, s) => `<label><input type="radio" name="w-rent" value="${m}" ${r.mode===m?"checked":""}><span><b>${t}</b><small>${s}</small></span></label>`;
    body = `<div class="card"><h2>What do you pay the studio?</h2>
      <div class="choice">
        ${opt("none","No rent","I own the space or train at clients' homes")}
        ${opt("perSession","Per session","A set fee for every session, e.g. $20")}
        ${opt("monthly","Flat monthly","One fee for unlimited use, e.g. $660/month")}
        ${opt("percent","Revenue split","The studio keeps a percentage of each session")}
      </div>
      <div class="form">
        <div class="field" data-rent-show="perSession"><label for="w-rps">Rent per session ($)</label><input id="w-rps" type="number" min="0" step="1" value="${esc(r.perSession)}"></div>
        <div class="field" data-rent-show="monthly"><label for="w-rmo">Monthly rent ($)</label><input id="w-rmo" type="number" min="0" step="1" value="${esc(r.monthly)}"></div>
        <div class="field" data-rent-show="percent"><label for="w-rpc">Studio's share (%)</label><input id="w-rpc" type="number" min="0" max="100" step="1" value="${esc(r.percent)}"></div>
        <div class="field" data-rent-show="perSession percent"><label for="w-rapp">Charged on</label><select id="w-rapp"><option value="studio" ${r.appliesTo!=="all"?"selected":""}>Sessions on my studio calendars</option><option value="all" ${r.appliesTo==="all"?"selected":""}>Every session</option></select></div>
      </div>
      <p class="small muted">You can exempt individual clients later, for example someone you train at their home.</p></div>`;
  } else {
    const d = w.defaults;
    const opt = m => `<label><input type="radio" name="w-bill" value="${m}" ${d.billing===m?"checked":""}><span><b>${BILLING[m].long}</b><small>${BILLING[m].hint}</small></span></label>`;
    body = `<div class="card"><h2>How do most of your clients pay?</h2>
      <p class="small muted">This is the starting point for new clients. Each client can have their own arrangement.</p>
      <div class="choice">${["package","tab","membership","payg"].map(opt).join("")}</div>
      <div class="form">
        <div class="field"><label for="w-rate">Usual rate per session ($)</label><input id="w-rate" type="number" min="0" step="1" value="${esc(d.rate)}"></div>
        <div class="field"><label for="w-size">Usual package size</label><input id="w-size" type="number" min="1" step="1" value="${esc(d.packageSize)}"></div>
        <div class="field"><label for="w-th">Flag a renewal at</label><input id="w-th" type="number" min="0" step="1" value="${esc(w.threshold)}"><span class="hint">sessions left in a package</span></div>
      </div></div>`;
  }
  return `<div class="setup">
    <div><h1>Set up your tally</h1><p class="muted small">Three quick steps. Everything you enter is private to your account.</p></div>
    <div class="steps">${steps.map((s,i)=>`<span class="${w.step===i+1?"on":""}">${i+1}. ${s}</span>`).join("")}</div>
    ${body}
    <div class="actions">${w.step>1?`<button class="btn" data-act="wiz-back">Back</button>`:""}
      <button class="btn primary" data-act="wiz-next" ${w.step===1 && !(w.cals.some(c=>c.use)) ? "disabled" : ""}>${w.step===3?"Finish and read my calendar":"Next"}</button>
      ${S.rerunning ? `<button class="btn ghost" data-act="wiz-cancel">Cancel</button>` : ""}
      ${w.step===1 && !S.rerunning ? `<button class="btn ghost" data-act="restore-open">Restore from a backup</button>` : ""}
      ${A.signOut ? `<button class="btn ghost" data-act="signout" style="margin-left:auto">Sign out${S.account && S.account.email ? " (" + esc(S.account.email) + ")" : ""}</button>` : ""}</div>
  </div>`;
}
function readWizStep(){
  const w = S.wiz;
  if (w.step === 1){ w.name = val("w-name").trim(); w.historyStart = val("w-start") || YEAR0; }
  if (w.step === 2){ const m = document.querySelector('input[name="w-rent"]:checked'); w.rent = {...w.rent, mode: m ? m.value : "none", perSession:num(val("w-rps"),20), monthly:num(val("w-rmo"),0), percent:num(val("w-rpc"),0), appliesTo: val("w-rapp") || "studio"}; }
  if (w.step === 3){ const m = document.querySelector('input[name="w-bill"]:checked'); w.defaults = {billing: m ? m.value : "package", rate:num(val("w-rate"),100), packageSize:Math.max(1, Math.round(num(val("w-size"),10)))}; w.threshold = Math.max(0, Math.round(num(val("w-th"),3))); }
}
function applyRentVisibility(){
  const m = (document.querySelector('input[name="w-rent"]:checked')||{}).value || "none";
  document.querySelectorAll("[data-rent-show]").forEach(el => el.hidden = !el.getAttribute("data-rent-show").split(" ").includes(m));
}

/* ---------- overview ---------- */
function attention(M){
  const out = [];
  for (const c of S.clients){
    if (c.active === false) continue;
    const st = M.stats[c.id];
    if (st.bill === "package"){
      if (st.status === "setup") out.push({c, st, kind:"setup", rank:5});
      else if (st.status === "out") out.push({c, st, kind:"renew", rank:1});
      else if (st.status === "owes") out.push({c, st, kind:"unpaid", rank:2});
      else if (st.status === "low") out.push({c, st, kind:"renew", rank:3});
    } else if (st.status === "owes") out.push({c, st, kind:"invoice", rank:2});
  }
  return out.sort((a,b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name));
}
const chipFor = st => `<span class="chip ${st.status}">${esc(st.label)}</span>`;
function renderOverview(M){
  const k = S.month, T = monthTotals(M, k), isCur = k === M.curM, pr = isCur ? projectMonth(M, k) : {n:0, earned:0, net:0, rent:0};
  const A2 = attention(M);
  const owed = S.clients.reduce((a,c) => a + (M.stats[c.id].balance||0), 0);
  const weekS = sow(M.now);
  const weekN = S.clients.reduce((a,c)=>a + M.stats[c.id].past.filter(s=>s.date>=weekS).length, 0);
  const booked = S.clients.reduce((a,c)=>a + M.stats[c.id].future.filter(s=>s.date < addDays(weekS,7)).length, 0);
  const prevT = monthTotals(M, mPrev(k));
  if (!S.clients.length) return `<div class="card"><div class="empty"><b>No clients yet</b><span>${M.unmatched.length ? `Your calendar has ${M.unmatched.length} recurring names that look like clients.` : S.cal.state === "loading" ? "Reading your calendar…" : "Add a client, or put sessions on your calendar with the client's name as the event title."}</span>
    ${M.unmatched.length ? `<button class="btn primary" data-tab="clients">Review suggested clients</button>` : `<button class="btn primary" data-act="new-client">Add client</button>`}</div></div>`;
  const delta = prevT.net ? (T.net - prevT.net) : null;
  return `<section class="card"><div class="hero">
      <div><h3>Net to you · ${esc(mName(k))}</h3>
        <div class="big" style="margin-top:8px">${money(T.net)}${isCur && pr.net > 0 ? ` <small>→ ${money(T.net + pr.net)}</small>` : ""}</div>
        <div class="eq"><span><b>${money(T.earned)}</b> earned</span><span>−</span><span><b>${money(T.rent)}</b> studio rent</span>${delta !== null && !isCur ? `<span class="${delta>=0?"pos":"neg"}">${delta>=0?"▲":"▼"} ${money(Math.abs(delta))} vs ${esc(MONTHS[mStart(mPrev(k)).getMonth()])}</span>` : ""}${isCur && pr.net > 0 ? `<span class="muted">· projected month end</span>` : ""}</div>
      </div>
      <div class="spark" data-chart="spark"></div>
    </div></section>
  <div class="stats">
    <div class="stat"><span class="k">Sessions</span><span class="v">${T.n}${isCur && pr.n ? `<span class="muted" style="font-size:14px;font-weight:600"> +${Math.round(pr.n)}</span>` : ""}</span><span class="d">${isCur ? `${weekN} this week · ${booked} still booked` : `${(T.n/4.33).toFixed(1)} per week`}</span></div>
    <div class="stat"><span class="k">Per session</span><span class="v">${T.n ? money2(T.net/T.n) : "–"}</span><span class="d">net, after rent</span></div>
    <div class="stat"><span class="k">Collected</span><span class="v">${money(T.collected)}</span><span class="d">payments this month</span></div>
    <div class="stat"><span class="k">Outstanding</span><span class="v ${owed>0.5?"neg":""}">${money(owed)}</span><span class="d">owed across clients</span></div>
  </div>
  <div class="grid2">
    <section class="card"><div class="card-h"><h2>Needs attention</h2><span class="small muted">${A2.length ? A2.length + " client" + (A2.length===1?"":"s") : ""}</span></div>
      ${A2.length ? `<div class="alist">${A2.map(attnRow).join("")}</div>` : `<div class="empty">Everyone is paid up with sessions left.</div>`}
      ${M.unmatched.length ? `<div class="note">${M.unmatched.length} calendar name${M.unmatched.length===1?"":"s"} not matched to a client yet. <button class="btn link" data-tab="clients">Review</button></div>` : ""}
    </section>
    <section class="card"><div class="card-h"><h2>Sessions by week</h2><div class="legend"><span><i class="sw-acc"></i>Done</span><span><i class="sw-proj"></i>Booked / expected</span></div></div>
      <div class="chart" data-chart="weeks"></div>
      <dl class="kv"><dt>Average per week, last 8</dt><dd>${avgWeek(M).toFixed(1)}</dd><dt>Active clients</dt><dd>${S.clients.filter(c=>c.active!==false).length}</dd></dl>
    </section>
  </div>`;
}
function avgWeek(M){ const cut = addDays(sow(M.now), -56); let n = 0; S.clients.forEach(c => n += M.stats[c.id].past.filter(s => s.date >= cut && s.date < sow(M.now)).length); return n/8; }
function attnRow(a){
  const {c, st} = a; let meta = "", acts = "";
  if (a.kind === "renew"){
    meta = st.remaining < 0 ? `${-st.remaining} session${st.remaining===-1?"":"s"} done past the package · next ${st.nextSize}-pack ${money(st.nextPrice)}` : st.remaining === 0 ? `Package used up · last session ${fmtD(st.last)}` : `${st.remaining} left of ${st.current.size} · runs out ${st.runout ? (st.runoutEst?"around ":"") + fmtD(st.runout) : "–"}`;
    acts = `<button class="btn sm" data-act="msg" data-id="${c.id}" data-kind="renew">Message</button><button class="btn sm primary" data-act="add-pkg" data-id="${c.id}">Record renewal</button>`;
  } else if (a.kind === "unpaid"){
    meta = `${st.unpaid.length > 1 ? st.unpaid.length + " packages" : "Current package"} not marked paid · ${money(st.unpaidAmt)}`;
    acts = `<button class="btn sm" data-act="msg" data-id="${c.id}" data-kind="unpaid">Reminder</button><button class="btn sm primary" data-act="payment" data-id="${c.id}">Mark paid</button>`;
  } else if (a.kind === "invoice"){
    meta = st.invoices.filter(i => i.due && i.state !== "paid").map(i => MONTHS[mStart(i.month).getMonth()] + " " + money(i.amount - i.paid)).join(" · ");
    acts = `<button class="btn sm" data-act="msg" data-id="${c.id}" data-kind="invoice">Send bill</button><button class="btn sm primary" data-act="payment" data-id="${c.id}">Log payment</button>`;
  } else {
    meta = "Tell the tally where their current package stands";
    acts = `<button class="btn sm primary" data-act="setup-pkg" data-id="${c.id}">Set package</button>`;
  }
  return `<div class="aitem"><div class="top">${avatar(c)}<a href="#" class="n" style="font-weight:600;color:var(--ink);text-decoration:none" data-act="edit" data-id="${c.id}">${esc(c.name)}</a>${chipFor(st)}</div><div class="meta">${meta}</div><div class="rowacts">${acts}</div></div>`;
}

/* ---------- calendar ---------- */
function renderCalendar(M){
  const k = S.month, ms = mStart(k), me = mStart(mNext(k));
  const gridStart = sow(ms);
  const list = sessionsIn(M, gridStart, addDays(gridStart, 42));
  const byDay = {}; for (const s of list){ const d = ymd(s.date); (byDay[d] = byDay[d] || []).push(s); }
  const today = ymd(M.now);
  if (!S.day || S.day.slice(0,7) !== k) S.day = k === M.curM ? today : ymd(ms);
  let cells = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => `<div class="dow">${d}</div>`).join("");
  let end = addDays(gridStart, 35); if (end < me) end = addDays(gridStart, 42);
  for (let d = new Date(gridStart); d < end; d = addDays(d,1)){
    const key = ymd(d), items = byDay[key] || [], inMonth = d >= ms && d < me;
    const done = items.filter(s=>!s.future), amt = done.reduce((a,s)=>a+s.value-s.rent,0);
    const pills = items.slice(0,3).map(s => `<span class="pill" style="background:color-mix(in srgb,${colorOf(s.c.name)} ${s.future?12:22}%,transparent)">${esc(fmtT(s.date).replace(":00",""))} ${esc(firstName(s.c.name))}</span>`).join("");
    cells += `<button class="day ${inMonth?"":"out"} ${key===today?"today":""}" data-act="day" data-day="${key}" aria-pressed="${S.day===key}" aria-label="${esc(d.toDateString())}: ${items.length} sessions">
      <span class="dn"><span>${d.getDate()}</span>${items.length?`<span class="small muted">${items.length}</span>`:""}</span>
      ${items.length ? `<span class="dots">${items.slice(0,8).map(s=>`<i class="${s.future?"fut":""}" style="background:${colorOf(s.c.name)}"></i>`).join("")}</span>` : ""}
      ${pills}${items.length > 3 ? `<span class="small muted">+${items.length-3} more</span>` : ""}
      ${done.length ? `<span class="amt">${money(amt)}</span>` : ""}
    </button>`;
  }
  const dayItems = byDay[S.day] || [];
  const dd = parseDay(S.day);
  const T = monthTotals(M, k);
  return `<div class="stats">
      <div class="stat"><span class="k">Sessions in ${esc(mName(k))}</span><span class="v">${T.n}</span><span class="d">done so far</span></div>
      <div class="stat"><span class="k">Booked ahead</span><span class="v">${list.filter(s=>s.future && s.date>=ms && s.date<me).length}</span><span class="d">still on the calendar</span></div>
      <div class="stat"><span class="k">Busiest day</span><span class="v">${busiest(list.filter(s=>s.date>=ms && s.date<me))}</span><span class="d">by sessions</span></div>
      <div class="stat"><span class="k">Net</span><span class="v">${money(T.net)}</span><span class="d">after rent</span></div>
    </div>
    <div class="grid2">
      <section class="card" style="padding:12px"><div class="cal" role="grid">${cells}</div></section>
      <section class="card"><div class="card-h"><h2>${esc(dd.toLocaleDateString(undefined,{weekday:"long", month:"long", day:"numeric"}))}</h2><span class="small muted">${dayItems.length} session${dayItems.length===1?"":"s"}</span></div>
        ${dayItems.length ? `<div class="daylist">${dayItems.map(s => `<div class="row"><span class="t">${esc(fmtT(s.date))}</span>
          <span class="who">${avatar(s.c)}<span style="min-width:0"><a href="#" class="n" data-act="edit" data-id="${s.c.id}">${esc(s.c.name)}</a><div class="s">${esc(s.calName||"")}${s.rent?` · ${money2(s.rent)} rent`:""}${s.future?" · booked":""}</div></span></span>
          <span class="${s.future?"muted":""}" style="font-weight:600">${money2(s.value - s.rent)}</span></div>`).join("")}</div>` : `<div class="empty">No sessions this day.</div>`}
        ${(() => { const skipped = S.clients.flatMap(c => M.stats[c.id].skipped).filter(s => ymd(s.date) === S.day); return skipped.length ? `<p class="small muted">${skipped.length} event${skipped.length===1?"":"s"} skipped as cancelled or free: ${skipped.map(s=>esc(s.title)).join(", ")}</p>` : ""; })()}
      </section>
    </div>`;
}
function busiest(list){ if (!list.length) return "–"; const c = [0,0,0,0,0,0,0]; list.forEach(s => c[(s.date.getDay()+6)%7]++); const i = c.indexOf(Math.max(...c)); return ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i]; }

/* ---------- clients ---------- */
function punch(st){
  if (st.bill !== "package" || !st.current) return `<span class="muted small">–</span>`;
  const size = Math.max(1, st.current.size), used = Math.min(size, st.current.usedIn);
  const over = Math.max(0, -st.remaining);
  const pips = size <= 40 ? Array.from({length:size}, (_,i)=>`<i class="${i<used?"used":""}"></i>`).join("") + Array.from({length:Math.min(over,10)},()=>`<i class="over"></i>`).join("") : "";
  return `<div class="punch" aria-hidden="true">${pips}</div><div class="punchlbl">${st.remaining < 0 ? `${over} over` : `${size-used} of ${size} left`}${st.remaining > size-used ? ` · ${st.remaining} total` : ""}</div>`;
}
function renderClients(M){
  const order = {out:0, owes:1, low:2, setup:3, info:4, ok:5};
  const act = S.clients.filter(c => c.active !== false).sort((a,b) => (order[M.stats[a.id].status]-order[M.stats[b.id].status]) || a.name.localeCompare(b.name));
  const inact = S.clients.filter(c => c.active === false).sort((a,b)=>a.name.localeCompare(b.name));
  const row = c => { const st = M.stats[c.id];
    const rate = st.bill === "membership" ? `${money(num(c.fee))}/mo` : st.bill === "package" ? `${money(st.perSession||0)}/session` : `${money(st.rate)}/session`;
    const bal = st.bill === "package" ? punch(st) : st.bill === "payg" ? `<span class="small muted">Paid at session</span>` : `<div style="font-weight:600">${st.balance>0.5?money(st.balance)+" due":"Paid up"}</div>${st.running?`<div class="small muted">${money(st.running)} this month so far</div>`:""}`;
    return `<tr>
      <td><div class="who">${avatar(c)}<div style="min-width:0"><a href="#" class="n" data-act="edit" data-id="${c.id}">${esc(c.name)}</a><div class="s">${BILLING[st.bill].label} · ${rate}${c.noRent?" · no rent":""}</div></div></div></td>
      <td>${chipFor(st)}</td><td>${bal}</td>
      <td class="num">${st.pace ? st.pace.toFixed(1) : "–"}</td>
      <td class="small">${fmtD(st.last)}</td><td class="small">${fmtD(st.next)}</td>
      <td><div class="rowacts">${st.bill==="package" ? (st.status==="setup" ? `<button class="btn sm" data-act="setup-pkg" data-id="${c.id}">Set package</button>` : `<button class="btn sm" data-act="add-pkg" data-id="${c.id}">New package</button>`) : ""}
        ${st.bill!=="payg" ? `<button class="btn sm" data-act="msg" data-id="${c.id}" data-kind="${st.bill==="package"?(st.status==="owes"?"unpaid":"renew"):"invoice"}">Message</button>` : ""}
        <button class="btn sm" data-act="payment" data-id="${c.id}">Payment</button></div></td></tr>`; };
  const sugg = M.unmatched;
  return `<section class="card"><div class="card-h"><h2>Clients</h2><span class="small muted">${act.length} active</span></div>
    ${act.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Status</th><th>Package / balance</th><th class="num">Per wk</th><th>Last</th><th>Next</th><th></th></tr></thead><tbody>${act.map(row).join("")}</tbody></table></div>` : `<div class="empty">No clients yet. Add one, or pick from the names found on your calendar below.</div>`}
    ${inact.length ? `<details><summary class="small muted">${inact.length} inactive</summary><div class="tablewrap"><table><tbody>${inact.map(row).join("")}</tbody></table></div></details>` : ""}
  </section>
  <section class="card"><div class="card-h"><h2>Found on your calendar</h2><span class="small muted">Recurring event names not matched to a client</span></div>
    ${sugg.length ? `<div class="tablewrap"><table><thead><tr><th>Event name</th><th class="num">Times</th><th>Last</th><th>Next</th><th></th></tr></thead><tbody>
      ${sugg.map((u,i) => `<tr><td style="font-weight:600">${esc(u.title)}</td><td class="num">${u.count}</td><td class="small">${fmtD(u.last)}</td><td class="small">${fmtD(u.next)}</td>
      <td><div class="rowacts"><button class="btn sm primary" data-act="sugg-add" data-i="${i}">Add as client</button><button class="btn sm" data-act="sugg-link" data-i="${i}">Same as…</button><button class="btn sm" data-act="sugg-ignore" data-i="${i}">Not a client</button></div></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">${S.cal.state==="loading" ? "Reading your calendar…" : "Every recurring name on your calendar is matched or ignored."}</div>`}
  </section>`;
}

/* ---------- billing ---------- */
function renderBilling(M){
  const k = S.month, cur = M.curM;
  const monthly = S.clients.filter(c => ["tab","membership"].includes(M.stats[c.id].bill)).map(c => ({c, st:M.stats[c.id], inv:M.stats[c.id].invoices.find(i => i.month === k)})).filter(x => x.inv && (x.inv.amount > 0 || x.inv.sched));
  const pkgs = [];
  for (const c of S.clients){ const st = M.stats[c.id]; if (st.bill !== "package") continue; (c.packages||[]).forEach((p,j) => { const d = p.paidDate || p.start; if (d && String(d).slice(0,7) === k) pkgs.push({c, st, p, j}); }); }
  const payg = S.clients.filter(c => M.stats[c.id].bill === "payg").map(c => ({c, m:M.stats[c.id].monthly[k]})).filter(x => x.m && x.m.n);
  const billed = monthly.reduce((a,x)=>a+x.inv.amount,0) + pkgs.reduce((a,x)=>a+num(x.p.price),0) + payg.reduce((a,x)=>a+x.m.earned,0);
  const collected = monthTotals(M,k).collected;
  const openN = monthly.filter(x=>x.inv.due && x.inv.state!=="paid").length;
  const stateChip = inv => inv.state === "paid" ? `<span class="chip ok">Paid</span>` : inv.state === "partial" ? `<span class="chip low">Part paid</span>` : inv.state === "running" ? `<span class="chip info">In progress</span>` : `<span class="chip owes">Open</span>`;
  return `<div class="stats">
    <div class="stat"><span class="k">Billed</span><span class="v">${money(billed)}</span><span class="d">bills, packages, paid sessions</span></div>
    <div class="stat"><span class="k">Collected</span><span class="v">${money(collected)}</span><span class="d">payments dated this month</span></div>
    <div class="stat"><span class="k">Open bills</span><span class="v ${openN?"neg":""}">${openN}</span><span class="d">for ${esc(mName(k))}</span></div>
    <div class="stat"><span class="k">Packages sold</span><span class="v">${pkgs.length}</span><span class="d">${money(pkgs.reduce((a,x)=>a+num(x.p.price),0))}</span></div>
  </div>
  <section class="card"><div class="card-h"><h2>Monthly bills</h2><span class="small muted">${k===cur?"Monthly-bill clients are due at month end":"Sessions × rate, or membership fee"}</span></div>
    ${monthly.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Plan</th><th class="num">Sessions</th><th class="num">Amount</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead><tbody>
    ${monthly.map(({c,st,inv}) => `<tr><td><div class="who">${avatar(c)}<a href="#" class="n" data-act="edit" data-id="${c.id}">${esc(c.name)}</a></div></td><td class="small">${BILLING[st.bill].label}</td>
      <td class="num">${inv.n}${inv.sched?`<span class="muted"> +${inv.sched}</span>`:""}</td><td class="num" style="font-weight:600">${money(inv.amount)}</td><td class="num">${money(inv.paid)}</td><td>${stateChip(inv)}</td>
      <td><div class="rowacts"><button class="btn sm" data-act="msg" data-id="${c.id}" data-kind="invoice" data-month="${inv.month}">Bill</button>${inv.state!=="paid"?`<button class="btn sm" data-act="payment" data-id="${c.id}" data-amount="${Math.max(0,inv.amount-inv.paid)}">Log payment</button>`:""}</div></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">No monthly-bill or membership clients had sessions this month.</div>`}
  </section>
  <section class="card"><div class="card-h"><h2>Packages</h2></div>
    ${pkgs.length ? `<div class="list">${pkgs.map(({c,p}) => `<div><span class="who">${avatar(c)}<span><b>${esc(c.name)}</b> · ${num(p.size)} sessions · ${money(num(p.price))}</span></span>${p.paidDate?`<span class="chip ok">Paid ${fmtD(parseDay(p.paidDate))}</span>`:`<button class="btn sm" data-act="payment" data-id="${c.id}">Mark paid</button>`}</div>`).join("")}</div>` : `<div class="empty">No packages sold or started this month.</div>`}
  </section>
  ${payg.length ? `<section class="card"><div class="card-h"><h2>Pay as you go</h2></div><div class="list">${payg.map(({c,m}) => `<div><span class="who">${avatar(c)}<span><b>${esc(c.name)}</b> · ${m.n} session${m.n===1?"":"s"}</span></span><span style="font-weight:600">${money(m.earned)}</span></div>`).join("")}</div></section>` : ""}`;
}

/* ---------- trends ---------- */
function renderTrends(M){
  const hs = mkey(parseDay(P("historyStart")));
  const months = []; for (let k = hs; k <= M.curM; k = mNext(k)) months.push(k);
  const rows = months.map(k => ({k, ...monthTotals(M,k)}));
  const tot = rows.reduce((a,r)=>({n:a.n+r.n, earned:a.earned+r.earned, rent:a.rent+r.rent, net:a.net+r.net}), {n:0,earned:0,rent:0,net:0});
  const fut = [M.curM, mNext(M.curM), mNext(mNext(M.curM)), mNext(mNext(mNext(M.curM)))].map(k => ({k, ...projectMonth(M,k)}));
  const restYear = []; for (let k = mNext(M.curM); k.slice(0,4) === M.curM.slice(0,4); k = mNext(k)) restYear.push(k);
  const yearProj = tot.net + projectMonth(M, M.curM).net + restYear.reduce((a,k)=>a+projectMonth(M,k).net,0);
  const k = S.month;
  const per = S.clients.map(c => ({c, m:M.stats[c.id].monthly[k]})).filter(x => x.m && (x.m.n || x.m.earned)).map(x => ({...x, net:x.m.earned - x.m.rent})).sort((a,b)=>b.net-a.net);
  const totNet = per.reduce((a,x)=>a+x.net,0);
  return `<div class="stats">
      <div class="stat"><span class="k">Sessions since ${esc(mLabel(hs))}</span><span class="v">${tot.n}</span><span class="d">${months.length ? (tot.n/months.length).toFixed(0) + " per month" : ""}</span></div>
      <div class="stat"><span class="k">Net so far</span><span class="v">${money(tot.net)}</span><span class="d">${money(tot.earned)} earned · ${money(tot.rent)} rent</span></div>
      <div class="stat"><span class="k">Net per session</span><span class="v">${tot.n ? money2(tot.net/tot.n) : "–"}</span><span class="d">after studio rent</span></div>
      <div class="stat"><span class="k">${M.curM.slice(0,4)} projected</span><span class="v">${money(yearProj)}</span><span class="d">net at your current pace</span></div>
    </div>
  <section class="card"><div class="card-h"><h2>Monthly income</h2>
      <div class="seg" role="group" aria-label="Chart">${[["net","Net"],["sessions","Sessions"]].map(([m,l])=>`<button data-act="trend-mode" data-mode="${m}" aria-pressed="${S.trendMode===m}">${l}</button>`).join("")}</div></div>
    <div class="legend">${S.trendMode==="net"?`<span><i class="sw-acc"></i>Net to you</span><span><i class="sw-rent"></i>Studio rent</span>`:`<span><i class="sw-acc"></i>Sessions</span>`}<span><i class="sw-proj"></i>Projected</span></div>
    <div class="chart" data-chart="months"></div>
  </section>
  <div class="grid2">
    <section class="card"><div class="card-h"><h2>By client · ${esc(mName(k))}</h2></div>
      ${per.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th class="num">Sessions</th><th class="num">Earned</th><th class="num">Rent</th><th class="num">Net</th><th class="num">Share</th></tr></thead><tbody>
      ${per.map(x => `<tr><td><div class="who">${avatar(x.c)}<span class="n">${esc(x.c.name)}</span></div></td><td class="num">${x.m.n}</td><td class="num">${money(x.m.earned)}</td><td class="num">${money(x.m.rent)}</td><td class="num" style="font-weight:600">${money(x.net)}</td><td class="num">${totNet?Math.round(100*x.net/totNet):0}%</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No sessions this month.</div>`}
    </section>
    <section class="card"><h2>Next few months</h2>
      <div class="tablewrap"><table><thead><tr><th>Month</th><th class="num">Sessions</th><th class="num">Earned</th><th class="num">Net</th></tr></thead><tbody>
      ${fut.map((f,i) => { const done = i===0 ? monthTotals(M,f.k) : {n:0,earned:0,net:0}; return `<tr><td>${esc(mLabel(f.k))}${i===0?' <span class="small muted">(incl. done)</span>':""}</td><td class="num">${Math.round(done.n + f.n)}</td><td class="num">${money(done.earned + f.earned)}</td><td class="num" style="font-weight:600">${money(done.net + f.net)}</td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="small muted">Uses what's booked on your calendar, then each client's average over the last 8 weeks.</p>
      ${renewalForecast(M)}
    </section>
  </div>`;
}
function renewalForecast(M){
  const list = S.clients.filter(c => c.active !== false && M.stats[c.id].bill === "package" && M.stats[c.id].runout).map(c => ({c, st:M.stats[c.id]})).filter(x => x.st.runout < addDays(M.now, 45)).sort((a,b)=>a.st.runout-b.st.runout);
  if (!list.length) return "";
  return `<h3>Renewals coming up</h3><div class="list">${list.map(({c,st}) => `<div><span class="who">${avatar(c)}<span>${esc(c.name)}</span></span><span class="small">${st.remaining<=0?"now":(st.runoutEst?"~":"")+fmtD(st.runout)} · ${money(st.nextPrice)}</span></div>`).join("")}</div>`;
}

/* ---------- settings ---------- */
function renderSettings(){
  const r = rentCfg(), d = defs();
  const cals = (P("calendars")||[]).filter(c=>c.use);
  const rentTxt = r.mode === "none" ? "No studio rent" : r.mode === "perSession" ? `${money(r.perSession)} per session` : r.mode === "monthly" ? `${money(r.monthly)} flat per month` : `${r.percent}% of each session`;
  const bs = S.billingStatus;
  return `<div class="grid2"><section class="card"><div class="card-h"><h2>Setup</h2><button class="btn sm" data-act="rerun">Change setup</button></div>
    <dl class="kv"><dt>Name on messages</dt><dd>${esc(P("trainerName")||"–")}</dd>
      <dt>Calendars read</dt><dd>${cals.map(c=>esc(c.name)+(c.studio?" (studio)":"")+(c.mineOnly?" (mine only)":"")).join("<br>")||"–"}</dd>
      <dt>Studio rent</dt><dd>${esc(rentTxt)}${r.mode==="perSession"||r.mode==="percent" ? (r.appliesTo==="all"?", every session":", studio calendars") : ""}</dd>
      <dt>New clients start as</dt><dd>${BILLING[d.billing].long}, ${money(d.rate)}/session, ${d.packageSize}-pack</dd>
      <dt>Counting from</dt><dd>${esc(parseDay(P("historyStart")).toLocaleDateString(undefined,{month:"short", day:"numeric", year:"numeric"}))}</dd></dl>
  </section>
  <section class="card"><h2>Messages and matching</h2>
    <div class="form">
      <div class="field full"><label for="st-renew">Renewal message</label><textarea id="st-renew">${esc(P("renewalTemplate"))}</textarea><span class="hint">{first} {left} {size} {price} {me}</span></div>
      <div class="field full"><label for="st-inv">Monthly bill message</label><textarea id="st-inv">${esc(P("invoiceTemplate"))}</textarea><span class="hint">{first} {month} {amount} {details} {me}</span></div>
      <div class="field full"><label for="st-ign">Skip events containing these words</label><input id="st-ign" value="${esc((P("ignoreWords")||[]).join(", "))}"><span class="hint">Comma separated. A session titled "Maria cancel" won't count.</span></div>
      <div class="field"><label for="st-th">Renewal flag at</label><input id="st-th" type="number" min="0" value="${esc(P("threshold"))}"></div>
    </div>
    ${(P("ignoredTitles")||[]).length ? `<h3>Names marked "not a client"</h3><div class="list">${(P("ignoredTitles")||[]).map((t,i)=>`<div><span>${esc(t)}</span><button class="btn sm" data-act="unignore" data-i="${i}">Restore</button></div>`).join("")}</div>` : ""}
    <div class="actions"><button class="btn primary" data-act="save-settings" ${S.readOnly?"disabled":""}>Save</button></div>
  </section></div>
  <div class="grid2">
  <section class="card"><h2>Backup and export</h2>
    <p class="small muted">Download everything you've entered, or pull your sessions and payments into a spreadsheet. A backup can be restored here or in any other copy of Trainer Tally.</p>
    <div class="actions">
      <button class="btn primary" data-act="export-json">Download backup (.json)</button>
      <button class="btn" data-act="export-sessions">Sessions (.csv)</button>
      <button class="btn" data-act="export-payments">Payments (.csv)</button>
      <button class="btn" data-act="restore-open" ${S.readOnly?"disabled":""}>Restore a backup</button>
    </div>
  </section>
  <section class="card"><div class="card-h"><h2>Appearance</h2><div class="seg" role="group" aria-label="Appearance">${[["system","Auto"],["light","Light"],["dark","Dark"]].map(([m,l])=>`<button data-act="theme" data-mode="${m}" aria-pressed="${getThemePref()===m}">${l}</button>`).join("")}</div></div>
    <h2>Your data</h2><p class="small muted">Your clients, packages and payments are private to your account. Nothing is ever written to your calendar.</p>
    ${A.billing ? `<dl class="kv"><dt>Plan</dt><dd>${esc(bs ? bs.label : "Checking…")}</dd></dl><div class="actions">${bs && bs.plan === "active" ? `<button class="btn" data-act="billing-portal">Manage subscription</button>` : `<button class="btn accent" data-act="billing-checkout">Subscribe · $3/month</button>`}</div>` : ""}
    <div class="actions">${S.confirmReset ? `<span class="small">Delete every client and setting?</span><button class="btn danger" data-act="reset-yes">Delete everything</button><button class="btn" data-act="reset-no">Keep</button>` : `<button class="btn danger" data-act="reset">Delete my data</button>`}</div>
  </section></div>`;
}

/* ---------- export / restore ---------- */
function backupObject(){
  const prof = {...(S.prof||{})};
  return {app:"trainer-tally", schema:SCHEMA, exportedAt:new Date().toISOString(), profile:prof, clients:S.clients.map(c => ({...c}))};
}
const csvCell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
const csv = rows => rows.map(r => r.map(csvCell).join(",")).join("\n") + "\n";
async function offerFile(filename, data){
  try { await A.saveFile({filename, data}); }
  catch(err){
    if (err && err.code === "declined") return;
    openModal({type:"copyout", filename, data});
  }
}
function exportSessions(){
  const M = S.M; const rows = [["date","time","client","calendar","billing","status","value","rent","net","event title"]];
  for (const c of S.clients){ const st = M.stats[c.id];
    for (const s of [...st.past, ...st.future, ...st.skipped]) rows.push([ymd(s.date), fmtT(s.date), c.name, s.calName||"", BILLING[st.bill].label, !s.billable ? "skipped" : s.future ? "booked" : "done", s.billable ? (Math.round(s.value*100)/100) : 0, s.billable ? (Math.round(s.rent*100)/100) : 0, s.billable ? (Math.round((s.value-s.rent)*100)/100) : 0, s.title]); }
  rows.splice(1, rows.length, ...rows.slice(1).sort((a,b)=>String(a[0]+a[1]).localeCompare(String(b[0]+b[1]))));
  offerFile(`trainer-tally-sessions-${ymd(new Date())}.csv`, csv(rows));
}
function exportPayments(){
  const rows = [["date","client","amount","method","note"]];
  for (const c of S.clients) for (const p of (c.payments||[])) rows.push([p.date, c.name, num(p.amount), p.method||"", p.note||""]);
  rows.splice(1, rows.length, ...rows.slice(1).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  offerFile(`trainer-tally-payments-${ymd(new Date())}.csv`, csv(rows));
}
function parseBackup(text){
  let o; try { o = JSON.parse(text); } catch(e){ return {error:"That file isn't a Trainer Tally backup (it isn't valid JSON)."}; }
  if (!o || o.app !== "trainer-tally" || !o.profile || !Array.isArray(o.clients)) return {error:"That file isn't a Trainer Tally backup."};
  return {data:o};
}
async function runRestore(o){
  const prof = {...o.profile}; delete prof.id;
  await saveProfile({...prof, setupDone:true});
  for (const c of o.clients){ if (!c || !c.id || !c.name) continue; await saveClient({...c}); }
}

/* ---------- charts ---------- */
function niceStep(x){ const p = Math.pow(10, Math.floor(Math.log10(Math.max(x,1e-9)))); const f = x/p; return (f<=1?1:f<=2?2:f<=5?5:10)*p; }
function barChart(el, bars, opts){
  const W = Math.max(260, el.clientWidth || 600), H = opts.h || 190, padL = 44, padB = 22, padT = 10, padR = 4;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...bars.map(b => b.segs.reduce((a,s)=>a+Math.max(0,s.v),0)));
  const step = niceStep(max/4); const top = Math.ceil(max/step)*step;
  const slot = iw / Math.max(1, bars.length), bw = Math.max(3, Math.min(30, slot*0.6));
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}"><defs><pattern id="h-${opts.id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--accent-soft)"/><rect width="2" height="5" fill="var(--accent)"/></pattern></defs>`;
  for (let v = 0; v <= top + 1e-9; v += step){ const y = padT + ih - (v/top)*ih; s += `<line x1="${padL}" x2="${W-padR}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1" ${v?'stroke-dasharray="2 3"':""}/><text x="${padL-8}" y="${y+3.5}" text-anchor="end">${opts.fmt(v)}</text>`; }
  const every = Math.ceil(bars.length / Math.max(1, Math.floor(iw/44)));
  bars.forEach((b,i) => {
    const x = padL + slot*i + (slot-bw)/2; let y = padT + ih;
    const segs = b.segs.filter(sg => sg.v > 0);
    segs.forEach((sg, j) => { const h = (sg.v/top)*ih; y -= h; const fill = sg.proj ? `url(#h-${opts.id})` : sg.rent ? "var(--rent)" : "var(--accent)"; s += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(0,h)}" fill="${fill}" rx="${j===segs.length-1?3:0}"><title>${esc(b.tip)}</title></rect>`; });
    if (i % every === 0) s += `<text x="${x+bw/2}" y="${H-6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  el.innerHTML = s + "</svg>";
}
function sparkChart(el, M){
  const k = S.month, ms = mStart(k), days = new Date(ms.getFullYear(), ms.getMonth()+1, 0).getDate();
  const list = sessionsIn(M, ms, mStart(mNext(k)));
  const daily = Array(days).fill(0), fut = Array(days).fill(0);
  for (const s of list){ const d = s.date.getDate()-1; if (s.future) fut[d] += s.value; else daily[d] += s.value; }
  const cum = [], cumF = []; let a = 0;
  const todayIdx = k === M.curM ? M.now.getDate()-1 : days-1;
  for (let i = 0; i < days; i++){ a += daily[i]; cum.push(a); }
  const pr = k === M.curM ? projectMonth(M, k).earned : 0;
  let b = cum[todayIdx]; const rest = days - 1 - todayIdx; const booked = fut.reduce((x,y)=>x+y,0); const extra = Math.max(0, pr - booked);
  for (let i = 0; i < days; i++){ if (i < todayIdx) { cumF.push(null); continue; } if (i > todayIdx) b += fut[i] + (rest ? extra/rest : 0); cumF.push(b); }
  const W = Math.max(240, el.clientWidth || 400), H = 110, pl = 4, pr2 = 4, pt = 16, pb = 18;
  const max = Math.max(1, ...cum, ...cumF.filter(v=>v!==null));
  const X = i => pl + (W-pl-pr2) * (days===1 ? 0 : i/(days-1)), Y = v => pt + (H-pt-pb) * (1 - v/max);
  let dA = "", dL = "";
  for (let i = 0; i <= todayIdx; i++){ dL += (i?"L":"M") + X(i).toFixed(1) + " " + Y(cum[i]).toFixed(1); }
  dA = dL + `L${X(todayIdx).toFixed(1)} ${H-pb}L${X(0).toFixed(1)} ${H-pb}Z`;
  let dF = ""; for (let i = todayIdx; i < days; i++){ if (cumF[i] === null) continue; dF += (dF?"L":"M") + X(i).toFixed(1) + " " + Y(cumF[i]).toFixed(1); }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Earned so far this month">
    <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <line x1="${pl}" x2="${W-pr2}" y1="${H-pb}" y2="${H-pb}" stroke="var(--line)"/>
    <path d="${dA}" fill="url(#sg)"/><path d="${dL}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>
    ${dF && todayIdx < days-1 ? `<path d="${dF}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="4 4" opacity=".7"/>` : ""}
    <circle cx="${X(todayIdx)}" cy="${Y(cum[todayIdx])}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
    <text x="${Math.min(W-60, Math.max(4, X(todayIdx)-20))}" y="${Math.max(11, Y(cum[todayIdx])-9)}">${money(cum[todayIdx])} earned</text>
    <text x="${pl}" y="${H-4}">${MONTHS[ms.getMonth()]} 1</text><text x="${W-pr2}" y="${H-4}" text-anchor="end">${MONTHS[ms.getMonth()]} ${days}</text>
  </svg>`;
}
function drawCharts(M){
  const sp = document.querySelector('[data-chart="spark"]'); if (sp) sparkChart(sp, M);
  const wk = document.querySelector('[data-chart="weeks"]');
  if (wk){
    const bars = []; const w0 = addDays(sow(M.now), -11*7);
    for (let i = 0; i < 16; i++){
      const a = addDays(w0, i*7), b = addDays(a, 7);
      let done = 0, booked = 0;
      for (const c of S.clients){ const st = M.stats[c.id]; done += st.past.filter(s=>s.date>=a && s.date<b).length; const sch = st.future.filter(s=>s.date>=a && s.date<b).length; booked += (a >= sow(M.now)) ? (a > sow(M.now) ? Math.max(sch, st.pace) : sch) : 0; }
      bars.push({label:(a.getMonth()+1)+"/"+a.getDate(), segs:[{v:done},{v:Math.round(booked*10)/10, proj:true}], tip:`Week of ${fmtD(a)}: ${done} done` + (booked?`, ${booked.toFixed(0)} booked/expected`:"")});
    }
    barChart(wk, bars, {id:"wk", h:170, label:"Sessions per week", fmt:v=>String(Math.round(v))});
  }
  const mo = document.querySelector('[data-chart="months"]');
  if (mo){
    const hs = mkey(parseDay(P("historyStart"))); const bars = []; const sess = S.trendMode === "sessions";
    for (let k = hs; k <= M.curM; k = mNext(k)){ const T = monthTotals(M,k); const pr = k === M.curM ? projectMonth(M,k) : {net:0, n:0};
      bars.push({label:MONTHS[mStart(k).getMonth()], segs: sess ? [{v:T.n},{v:Math.round(pr.n), proj:true}] : [{v:T.net},{v:T.rent, rent:true},{v:pr.net, proj:true}], tip:`${mLabel(k)}: ${T.n} sessions, ${money(T.earned)} earned, ${money(T.rent)} rent, ${money(T.net)} net` + (pr.net?` (+${money(pr.net)} projected)`:"")}); }
    for (let k = mNext(M.curM), i = 0; i < 3; k = mNext(k), i++){ const pr = projectMonth(M,k); bars.push({label:MONTHS[mStart(k).getMonth()], segs:[{v: sess ? Math.round(pr.n) : pr.net, proj:true}], tip:`${mLabel(k)} projected: ${Math.round(pr.n)} sessions, ${money(pr.net)} net`}); }
    barChart(mo, bars, {id:"mo", h:240, label: sess ? "Sessions by month" : "Net income by month", fmt: sess ? (v=>String(Math.round(v))) : (v=> v>=1000 ? "$"+(v/1000).toFixed(v%1000?1:0)+"k" : "$"+v)});
  }
}

/* ---------- modals ---------- */
function openModal(m){ S.modal = m; renderModal(); }
function closeModal(){ S.modal = null; $("#modal").innerHTML = ""; }
function fillTpl(t, vars){ return String(t||"").replace(/\{(\w+)\}/g, (m,k) => vars[k] !== undefined ? vars[k] : m); }
function messageText(c, kind, monthK){
  const st = S.M.stats[c.id], me = P("trainerName") || "";
  if (kind === "renew"){ const left = Math.max(0, st.remaining||0); return fillTpl(P("renewalTemplate"), {first:firstName(c.name), left, s:left===1?"":"s", size:st.nextSize, price:Math.round(st.nextPrice).toLocaleString(), me}).replace(/ - $/,""); }
  if (kind === "unpaid") return `Hi ${firstName(c.name)}! Quick reminder that payment for your ${st.current ? st.current.size + "-session " : ""}package (${money(st.unpaidAmt)}) is still open. Thanks!${me?" - "+me:""}`;
  const invs = st.invoices || [];
  const inv = monthK ? invs.find(i => i.month === monthK) : ([...invs].reverse().find(i => i.due && i.state !== "paid") || invs[invs.length-1]);
  if (!inv) return "";
  let t = fillTpl(P("invoiceTemplate"), {first:firstName(c.name), month:mLabel(inv.month,true), amount:Math.round(inv.amount).toLocaleString(), details:inv.details, me});
  const otherOpen = st.balance - Math.max(0, inv.amount - inv.paid);
  if (otherOpen > 0.5) t += ` Total balance including earlier months: ${money(st.balance)}.`;
  return t.replace(/ - $/,"");
}
function renderModal(){
  const m = S.modal; if (!m) return;
  let title = "", body = "";
  const d = defs();
  if (m.type === "edit"){
    const c = m.id ? client(m.id) : {name:m.name||"", aliases:[], billing:d.billing, rate:d.rate, packageSize:d.packageSize, active:true};
    if (!c){ closeModal(); return; }
    const b = c.billing || "package";
    title = m.id ? c.name : "New client";
    body = `<div class="form">
      <div class="field full"><label for="ed-name">Name</label><input id="ed-name" value="${esc(c.name)}"><span class="hint">Match it to how the client appears on your calendar</span></div>
      <div class="field full"><label for="ed-alias">Other calendar names</label><input id="ed-alias" value="${esc((c.aliases||[]).join(", "))}"><span class="hint">Comma separated, e.g. "Mike, Michael R"</span></div>
      <div class="field full"><label for="ed-bill">How they pay</label><select id="ed-bill">${Object.keys(BILLING).map(k=>`<option value="${k}" ${b===k?"selected":""}>${BILLING[k].long}</option>`).join("")}</select><span class="hint" id="ed-bill-hint">${esc(BILLING[b].hint)}</span></div>
      <div class="field" data-bill-show="tab payg package membership"><label for="ed-rate">Rate per session ($)</label><input id="ed-rate" type="number" min="0" step="1" value="${esc(c.rate ?? "")}"></div>
      <div class="field" data-bill-show="package"><label for="ed-size">Package size</label><input id="ed-size" type="number" min="1" step="1" value="${esc(c.packageSize ?? 10)}"></div>
      <div class="field" data-bill-show="package"><label for="ed-price">Package price ($)</label><input id="ed-price" type="number" min="0" step="1" value="${esc(c.packagePrice ?? "")}" placeholder="size × rate"></div>
      <div class="field" data-bill-show="membership"><label for="ed-fee">Monthly fee ($)</label><input id="ed-fee" type="number" min="0" step="1" value="${esc(c.fee ?? "")}"></div>
      <div class="field" data-bill-show="membership"><label for="ed-inc">Sessions included</label><input id="ed-inc" type="number" min="0" step="1" value="${esc(c.included ?? 0)}"><span class="hint">0 = unlimited</span></div>
      <div class="field" data-bill-show="membership"><label for="ed-over">Extra session rate ($)</label><input id="ed-over" type="number" min="0" step="1" value="${esc(c.overageRate ?? "")}"></div>
      <div class="field" data-bill-show="tab membership"><label for="ed-bs">Billing starts</label><input id="ed-bs" type="date" value="${esc(c.billingStart || P("historyStart"))}"><span class="hint">First month you bill them here</span></div>
      <div class="field"><label for="ed-email">Email</label><input id="ed-email" type="email" value="${esc(c.email||"")}"></div>
      <div class="field"><label for="ed-phone">Phone</label><input id="ed-phone" type="tel" value="${esc(c.phone||"")}"></div>
      <label class="check full"><input type="checkbox" id="ed-norent" ${c.noRent?"checked":""}> No studio rent for this client</label>
      <label class="check full"><input type="checkbox" id="ed-active" ${c.active!==false?"checked":""}> Active</label>
    </div>
    ${m.id && b === "package" ? packageHistory(c) : ""}
    ${m.id ? paymentHistory(c) : ""}
    <div class="actions"><button class="btn primary" data-act="save-client" ${S.readOnly?"disabled":""}>Save</button>
      ${m.id ? (m.confirmDel ? `<button class="btn danger" data-act="del-yes">Delete ${esc(c.name)}</button><button class="btn" data-act="del-no">Keep</button>` : `<button class="btn danger" data-act="del">Delete</button>`) : ""}</div>`;
  } else if (m.type === "setup-pkg"){
    const c = client(m.id), st = S.M.stats[c.id];
    title = "Current package · " + c.name;
    body = `<p class="note">Tell the tally where ${esc(firstName(c.name))} stands. Give the date their current package started (sessions are counted from the calendar), or how many are left right now.</p>
    <div class="form">
      <div class="field full"><label for="sp-mode">I know</label><select id="sp-mode"><option value="start">When the package started</option><option value="left">How many sessions are left</option></select></div>
      <div class="field" data-sp="start"><label for="sp-start">Package started</label><input id="sp-start" type="date" value="${ymd(addDays(new Date(),-21))}"></div>
      <div class="field" data-sp="left" hidden><label for="sp-left">Sessions left today</label><input id="sp-left" type="number" min="0" step="1" value="${Math.max(0, Math.round(st.nextSize/2))}"></div>
      <div class="field"><label for="sp-size">Package size</label><input id="sp-size" type="number" min="1" step="1" value="${esc(st.nextSize)}"></div>
      <div class="field"><label for="sp-price">Price ($)</label><input id="sp-price" type="number" min="0" step="1" value="${esc(Math.round(st.nextPrice))}"></div>
      <label class="check full"><input type="checkbox" id="sp-paid" checked> Already paid</label>
    </div>
    <div class="actions"><button class="btn primary" data-act="save-setup-pkg" ${S.readOnly?"disabled":""}>Save</button></div>`;
  } else if (m.type === "add-pkg"){
    const c = client(m.id), st = S.M.stats[c.id];
    title = "New package · " + c.name;
    body = `<p class="note">${st.remaining < 0 ? `${-st.remaining} session${st.remaining===-1?"":"s"} already done past the last package will come out of this one.` : st.remaining > 0 ? `The ${st.remaining} session${st.remaining===1?"":"s"} left on the current package are used first.` : "Sessions from now on count against this package."}</p>
    <div class="form">
      <div class="field"><label for="ap-size">Sessions</label><input id="ap-size" type="number" min="1" step="1" value="${esc(st.nextSize)}"></div>
      <div class="field"><label for="ap-price">Price ($)</label><input id="ap-price" type="number" min="0" step="1" value="${esc(Math.round(st.nextPrice))}"></div>
      <label class="check full"><input type="checkbox" id="ap-paid" checked> Paid now</label>
      <div class="field"><label for="ap-date">Paid on</label><input id="ap-date" type="date" value="${ymd(new Date())}"></div>
      <div class="field"><label for="ap-method">Method</label><select id="ap-method">${METHODS.map(x=>`<option>${x}</option>`).join("")}</select></div>
    </div>
    <div class="actions"><button class="btn primary" data-act="save-add-pkg" ${S.readOnly?"disabled":""}>Add package</button></div>`;
  } else if (m.type === "payment"){
    const cid = m.id || (S.clients[0] && S.clients[0].id);
    const c = cid ? client(cid) : null; const st = c ? S.M.stats[c.id] : null;
    title = "Log payment";
    if (!c) body = `<div class="empty">Add a client first.</div>`;
    else {
      const unpaid = st.bill === "package" ? (st.unpaid||[]) : [];
      const amt = m.amount != null ? m.amount : st.bill === "package" ? (unpaid[0] ? num(unpaid[0].p.price) : Math.round(st.nextPrice)) : Math.round(st.balance || st.running || st.rate);
      body = `<div class="form">
        <div class="field full"><label for="pm-client">Client</label><select id="pm-client">${[...S.clients].sort((a,b)=>a.name.localeCompare(b.name)).map(x=>`<option value="${x.id}" ${x.id===c.id?"selected":""}>${esc(x.name)}</option>`).join("")}</select></div>
        ${unpaid.length ? `<div class="field full"><label for="pm-pkg">Pays for</label><select id="pm-pkg">${unpaid.map(({p,j})=>`<option value="${j}">${num(p.size)}-session package, ${money(num(p.price))}</option>`).join("")}<option value="">Something else</option></select></div>` : ""}
        <div class="field"><label for="pm-amt">Amount ($)</label><input id="pm-amt" type="number" min="0" step="1" value="${esc(amt)}"></div>
        <div class="field"><label for="pm-date">Date</label><input id="pm-date" type="date" value="${ymd(new Date())}"></div>
        <div class="field"><label for="pm-method">Method</label><select id="pm-method">${METHODS.map(x=>`<option>${x}</option>`).join("")}</select></div>
        <div class="field"><label for="pm-note">Note</label><input id="pm-note" placeholder="Optional"></div>
      </div>
      ${st.bill === "package" && !unpaid.length ? `<p class="small muted">To sell a new package, use New package on the client so its sessions are counted.</p>` : ""}
      <div class="actions"><button class="btn primary" data-act="save-payment" ${S.readOnly?"disabled":""}>Save payment</button></div>`;
    }
  } else if (m.type === "msg"){
    const c = client(m.id);
    title = "Message · " + c.name;
    if (m.text == null) m.text = messageText(c, m.kind, m.month);
    const text = m.text;
    const subj = encodeURIComponent(m.kind === "invoice" ? "Your training bill" : "Your training package");
    body = `<div class="field"><label for="msg-text">Message</label><textarea id="msg-text" rows="6">${esc(text)}</textarea></div>
      <div class="actions"><button class="btn primary" data-act="copy">Copy message</button>
        ${c.phone ? `<a class="btn" href="sms:${esc(c.phone.replace(/[^\d+]/g,""))}?&body=${encodeURIComponent(text)}">Open text</a>` : ""}
        ${c.email ? `<a class="btn" href="mailto:${esc(c.email)}?subject=${subj}&body=${encodeURIComponent(text)}">Open email</a>` : ""}</div>
      <p class="small muted">${c.phone || c.email ? `Send to ${esc([c.phone, c.email].filter(Boolean).join(" or "))}. If the buttons don't open your apps, copy the message instead.` : "Add a phone or email to the client to open your texting or mail app from here."}</p>`;
  } else if (m.type === "link"){
    const u = S.M.unmatched[m.i];
    title = "Match “" + (u ? u.title : "") + "”";
    body = `<p class="small muted">Which client is this calendar name?</p><div class="list">${[...S.clients].sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<div><span class="who">${avatar(c)}<span>${esc(c.name)}</span></span><button class="btn sm" data-act="link-to" data-id="${c.id}">Choose</button></div>`).join("") || `<div>No clients yet.</div>`}</div>`;
  } else if (m.type === "restore"){
    title = "Restore a backup";
    const r = S.restore;
    body = `<p class="small muted">Choose a Trainer Tally backup (.json). Clients in the backup are added or updated; clients that aren't in it are left alone.</p>
      <div class="field"><label for="rs-file">Backup file</label><input id="rs-file" type="file" accept=".json,application/json"></div>
      ${r && r.error ? `<div class="banner err"><span>${esc(r.error)}</span></div>` : ""}
      ${r && r.data ? `<div class="note">Backup from ${esc(new Date(r.data.exportedAt).toLocaleString())}: ${r.data.clients.length} client${r.data.clients.length===1?"":"s"}${r.data.profile.trainerName?` for ${esc(r.data.profile.trainerName)}`:""}.</div>
        <div class="actions"><button class="btn primary" data-act="restore-go" ${S.readOnly?"disabled":""}>Restore</button></div>` : ""}`;
  } else if (m.type === "copyout"){
    title = "Copy your file";
    body = `<p class="small muted">Downloads aren't available here. Copy this text and save it as <b>${esc(m.filename)}</b>.</p>
      <div class="field"><label for="co-text">${esc(m.filename)}</label><textarea id="co-text" rows="12" readonly>${esc(m.data)}</textarea></div>
      <div class="actions"><button class="btn primary" data-act="copy-out">Copy</button></div>`;
  }
  $("#modal").innerHTML = `<div class="scrim" data-act="close-scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-h"><h2>${esc(title)}</h2><button class="btn sm" data-act="close">Close</button></div>${body}</div></div>`;
  applyBillVisibility();
}
function packageHistory(c){
  const pk = c.packages||[]; if (!pk.length) return "";
  return `<h3>Packages</h3><div class="list">${pk.map((p,j)=>`<div><span>${j===0&&p.start?"From "+fmtD(new Date(p.start))+" · ":""}${num(p.size)} sessions · ${money(num(p.price))}</span><span>${p.paidDate?`<span class="chip ok">Paid</span>`:`<span class="chip owes">Unpaid</span>`} <button class="btn sm" data-act="rm-pkg" data-j="${j}">Remove</button></span></div>`).join("")}</div>
  <button class="btn sm" data-act="setup-pkg" data-id="${c.id}" style="align-self:flex-start">Reset where they stand</button>`;
}
function paymentHistory(c){
  const ps = [...(c.payments||[])].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,12);
  if (!ps.length) return "";
  return `<h3>Payments</h3><div class="list">${ps.map(p=>`<div><span>${fmtD(parseDay(p.date))} · ${esc(p.method||"")}${p.note?" · "+esc(p.note):""}</span><span style="font-weight:600">${money(num(p.amount))} <button class="btn sm" data-act="rm-pay" data-pid="${esc(p.id)}">Remove</button></span></div>`).join("")}</div>`;
}
function applyBillVisibility(){
  const sel = document.getElementById("ed-bill");
  if (sel){ const b = sel.value; document.querySelectorAll("[data-bill-show]").forEach(el => el.hidden = !el.getAttribute("data-bill-show").split(" ").includes(b)); const h = document.getElementById("ed-bill-hint"); if (h) h.textContent = BILLING[b].hint; }
  const sp = document.getElementById("sp-mode");
  if (sp) document.querySelectorAll("[data-sp]").forEach(el => el.hidden = el.getAttribute("data-sp") !== sp.value);
}

/* ---------- actions ---------- */
async function onClick(e){
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn){ e.preventDefault(); S.tab = tabBtn.getAttribute("data-tab"); S.confirmReset = false; closeModal(); render(); window.scrollTo({top:0}); return; }
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.getAttribute("data-act"), id = el.getAttribute("data-id");
  if (act === "close-scrim" && e.target !== el) return;
  if (el.tagName === "A" && el.getAttribute("href") === "#") e.preventDefault();
  const M = S.M;
  switch (act){
    case "close": case "close-scrim": closeModal(); break;
    case "theme": setTheme(el.getAttribute("data-mode")); break;
    case "signin": if (A.signIn) A.signIn(); break;
    case "signout": if (A.signOut) A.signOut(); break;
    case "refresh": loadCalendar(true); break;
    case "cal-list": S.calList = null; S.calListErr = null; render(); break;
    case "mprev": S.month = mPrev(S.month); render(); break;
    case "mnext": if (S.month < M.curM) S.month = mNext(S.month); render(); break;
    case "day": S.day = el.getAttribute("data-day"); render(); break;
    case "trend-mode": S.trendMode = el.getAttribute("data-mode"); render(); break;
    case "wiz-back": readWizStep(); S.wiz.step--; render(); break;
    case "wiz-cancel": S.wiz = null; S.rerunning = false; S.prof = {...S.prof, setupDone:true}; render(); break;
    case "rerun": S.wiz = wizDefaults(); S.calList = null; S.rerunning = true; S.prof = {...S.prof, setupDone:false}; render(); break;
    case "wiz-next": {
      readWizStep(); const w = S.wiz;
      if (w.step < 3){ w.step++; render(); break; }
      const patch = {setupDone:true, trainerName:w.name, calendars:w.cals.filter(c=>c.use).map(c=>({id:c.id, name:c.name, use:true, studio:!!c.studio, mineOnly:!!c.mineOnly})), rent:w.rent, defaults:w.defaults, threshold:w.threshold, historyStart:w.historyStart, myEmail:S.detectedEmail || P("myEmail") || ""};
      S.wiz = null; S.rerunning = false; S.tab = S.clients.length ? "overview" : "clients";
      try { await saveProfile(patch); } catch(err){ S.prof = {...S.prof, ...patch}; }
      loadCalendar(false); break;
    }
    case "new-client": openModal({type:"edit"}); break;
    case "edit": openModal({type:"edit", id}); break;
    case "del": S.modal.confirmDel = true; renderModal(); break;
    case "del-no": S.modal.confirmDel = false; renderModal(); break;
    case "del-yes": { const mid = S.modal.id; closeModal(); removeClient(mid).then(()=>toast("Client deleted")).catch(()=>{}); break; }
    case "save-client": {
      const m = S.modal, old = m.id ? client(m.id) : {};
      const name = val("ed-name").trim(); if (!name){ toast("Add a name"); break; }
      const b = val("ed-bill");
      const c = {...old, id: m.id || uid(), name, aliases: val("ed-alias").split(",").map(s=>s.trim()).filter(Boolean), billing:b,
        rate: num(val("ed-rate"), num(defs().rate, 100)), packageSize: Math.max(1, Math.round(num(val("ed-size"), 10))),
        packagePrice: val("ed-price") === "" ? null : num(val("ed-price")), fee: num(val("ed-fee")), included: Math.max(0, Math.round(num(val("ed-inc")))),
        overageRate: val("ed-over") === "" ? null : num(val("ed-over")), billingStart: val("ed-bs") || null,
        email: val("ed-email").trim(), phone: val("ed-phone").trim(), noRent: chk("ed-norent"), active: chk("ed-active"),
        packages: old.packages || [], payments: old.payments || []};
      const isNew = !m.id;
      closeModal(); saveClient(c).then(()=>toast(isNew ? "Client added" : "Saved")).catch(()=>{});
      if (isNew && b === "package") setTimeout(()=>openModal({type:"setup-pkg", id:c.id}), 50);
      if (c.billingStart && c.billingStart < P("historyStart")) loadCalendar(false);
      break;
    }
    case "setup-pkg": openModal({type:"setup-pkg", id}); break;
    case "save-setup-pkg": {
      const c = client(S.modal.id); const size = Math.max(1, Math.round(num(val("sp-size"), 10))), price = num(val("sp-price"));
      const paid = chk("sp-paid"); let p;
      if (val("sp-mode") === "left"){ const left = Math.max(0, Math.min(size, Math.round(num(val("sp-left"))))); p = {id:uid(), start:new Date().toISOString(), size, price, used0:size-left}; }
      else p = {id:uid(), start:parseDay(val("sp-start")).toISOString(), size, price, used0:0};
      if (paid) p.paidDate = ymd(new Date());
      closeModal();
      const needLoad = new Date(p.start) < parseDay(P("historyStart"));
      saveClient({...c, packages:[p], packageSize:size, packagePrice:price}).then(()=>toast("Package set")).catch(()=>{});
      if (needLoad) loadCalendar(false);
      break;
    }
    case "add-pkg": openModal({type:"add-pkg", id}); break;
    case "save-add-pkg": {
      const c = client(S.modal.id); const size = Math.max(1, Math.round(num(val("ap-size"), 10))), price = num(val("ap-price")), paid = chk("ap-paid"), date = val("ap-date") || ymd(new Date());
      const pk = [...(c.packages||[])]; const p = {id:uid(), size, price};
      if (!pk.length) p.start = new Date().toISOString();
      if (paid) p.paidDate = date;
      pk.push(p);
      const pays = [...(c.payments||[])]; if (paid) pays.push({id:uid(), date, amount:price, method:val("ap-method"), note:`${size}-session package`});
      closeModal(); saveClient({...c, packages:pk, payments:pays, packageSize:size, packagePrice:price}).then(()=>toast("Package added")).catch(()=>{});
      break;
    }
    case "rm-pkg": { const c = client(S.modal.id); const j = +el.getAttribute("data-j"); const pk = (c.packages||[]).filter((_,i)=>i!==j); if (j === 0 && pk[0] && !pk[0].start) pk[0] = {...pk[0], start:c.packages[0].start}; saveClient({...c, packages:pk}).catch(()=>{}); break; }
    case "rm-pay": { const c = client(S.modal.id); saveClient({...c, payments:(c.payments||[]).filter(p=>p.id!==el.getAttribute("data-pid"))}).catch(()=>{}); break; }
    case "payment": openModal({type:"payment", id, amount: el.getAttribute("data-amount") != null ? num(el.getAttribute("data-amount")) : null}); break;
    case "save-payment": {
      const c = client(val("pm-client")); const amt = num(val("pm-amt")); if (!c || !(amt > 0)){ toast("Enter an amount"); break; }
      const date = val("pm-date") || ymd(new Date());
      const pays = [...(c.payments||[]), {id:uid(), date, amount:amt, method:val("pm-method"), note:val("pm-note").trim()}];
      let pk = c.packages || [];
      const pj = document.getElementById("pm-pkg") ? val("pm-pkg") : "";
      if (pj !== "") pk = pk.map((p,i) => i === +pj ? {...p, paidDate:date} : p);
      closeModal(); saveClient({...c, payments:pays, packages:pk}).then(()=>toast("Payment saved")).catch(()=>{});
      break;
    }
    case "msg": openModal({type:"msg", id, kind:el.getAttribute("data-kind"), month:el.getAttribute("data-month")}); break;
    case "copy": { const t = document.getElementById("msg-text"); try { await navigator.clipboard.writeText(t.value); toast("Message copied"); } catch(err){ t.focus(); t.select(); toast("Selected. Use your device's copy."); } break; }
    case "copy-out": { const t = document.getElementById("co-text"); try { await navigator.clipboard.writeText(t.value); toast("Copied"); } catch(err){ t.focus(); t.select(); toast("Selected. Use your device's copy."); } break; }
    case "sugg-add": { const u = M.unmatched[+el.getAttribute("data-i")]; if (u) openModal({type:"edit", name:u.title.replace(/^\s*(pt|session|training)\s*[-:–]?\s*/i,"").trim()}); break; }
    case "sugg-link": openModal({type:"link", i:+el.getAttribute("data-i")}); break;
    case "link-to": { const u = M.unmatched[S.modal.i], c = client(id); closeModal(); if (u && c) saveClient({...c, aliases:[...(c.aliases||[]), u.title]}).then(()=>toast(`Matched to ${c.name}`)).catch(()=>{}); break; }
    case "sugg-ignore": { const u = M.unmatched[+el.getAttribute("data-i")]; if (u) saveProfile({ignoredTitles:[...(P("ignoredTitles")||[]), u.title]}).catch(()=>{}); break; }
    case "unignore": { const i = +el.getAttribute("data-i"); saveProfile({ignoredTitles:(P("ignoredTitles")||[]).filter((_,j)=>j!==i)}).catch(()=>{}); break; }
    case "save-settings": saveProfile({renewalTemplate:val("st-renew"), invoiceTemplate:val("st-inv"), ignoreWords:val("st-ign").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean), threshold:Math.max(0, Math.round(num(val("st-th"),3)))}).then(()=>toast("Settings saved")).catch(()=>{}); break;
    case "export-json": offerFile(`trainer-tally-backup-${ymd(new Date())}.json`, JSON.stringify(backupObject(), null, 2)); break;
    case "export-sessions": exportSessions(); break;
    case "export-payments": exportPayments(); break;
    case "restore-open": S.restore = null; openModal({type:"restore"}); break;
    case "restore-go": {
      const r = S.restore; if (!r || !r.data) break;
      closeModal(); S.wiz = null; S.rerunning = false;
      try { await runRestore(r.data); toast("Backup restored"); S.tab = "overview"; loadCalendar(false); } catch(err){}
      break;
    }
    case "billing-checkout": if (A.billing) A.billing.checkout(); break;
    case "billing-portal": if (A.billing) A.billing.portal(); break;
    case "reset": S.confirmReset = true; render(); break;
    case "reset-no": S.confirmReset = false; render(); break;
    case "reset-yes": {
      S.confirmReset = false;
      try { for (const c of [...S.clients]) await removeClient(c.id); await queued("profile", () => A.deleteProfile()); } catch(err){}
      S.prof = null; S.wiz = null; S.events = []; S.cal = {state:"idle", done:0, total:0}; render(); toast("Your data was deleted"); break;
    }
  }
}
function onChange(e){
  const t = e.target;
  if (t.id === "ed-bill" || t.id === "sp-mode") applyBillVisibility();
  if (t.name === "w-rent") applyRentVisibility();
  if (t.hasAttribute && t.hasAttribute("data-wcal")){
    const i = +t.getAttribute("data-wcal"), k = t.getAttribute("data-k");
    S.wiz.name = val("w-name") || S.wiz.name; S.wiz.historyStart = val("w-start") || S.wiz.historyStart;
    S.wiz.cals[i][k] = t.checked; render();
  }
  if (t.id === "pm-client"){ S.modal = {type:"payment", id:t.value}; renderModal(); }
  if (t.id === "rs-file" && t.files && t.files[0]){
    const f = t.files[0]; const rd = new FileReader();
    rd.onload = () => { S.restore = parseBackup(String(rd.result||"")); renderModal(); };
    rd.onerror = () => { S.restore = {error:"Couldn't read that file."}; renderModal(); };
    rd.readAsText(f);
  }
}
function onInput(e){ if (e.target.id === "msg-text" && S.modal) S.modal.text = e.target.value; }

/* ---------- boot ---------- */
async function start(adapter){
  A = adapter;
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && S.modal) closeModal(); });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => S.M && drawCharts(S.M), 150); });
  renderChrome();
  let info;
  try { info = await A.init(); } catch(e){ info = {status:"nostore"}; }
  S.account = info.account || null;
  if (info.status === "signin"){ S.screen = "signin"; render(); return; }
  if (info.status !== "ready"){ S.screen = "nostore"; render(); return; }
  S.screen = "data";
  try { const q = new URLSearchParams(location.search).get("billing"); if (q){ toast(q === "success" ? "You're subscribed. Thank you!" : "Checkout cancelled"); history.replaceState(null, "", location.pathname); if (q === "success") S.tab = "settings"; } } catch(e){}
  if (A.billing) A.billing.status().then(s => { S.billingStatus = s; if (S.tab === "settings") render(); }).catch(()=>{});
  let started = false;
  const maybeStart = () => { if (!started && S.profLoaded && S.clientsLoaded && S.prof && S.prof.setupDone){ started = true; loadCalendar(false); } };
  A.watchProfile(p => {
    if (S.rerunning) return;
    S.prof = p; S.profLoaded = true;
    render(); maybeStart();
  }, () => { S.profLoaded = true; render(); });
  A.watchClients(list => {
    S.clients = list; S.clientsLoaded = true;
    if (S.modal && S.modal.id && ["edit","setup-pkg","add-pkg","msg"].includes(S.modal.type) && !client(S.modal.id)) closeModal();
    render(); maybeStart();
  }, () => { S.clientsLoaded = true; render(); });
}
window.TrainerTally = {start, version:"2.0"};
})();
