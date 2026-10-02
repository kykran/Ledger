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
const DEFAULTS = globalThis.TallyEngine.DEFAULTS;
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
  reconcile:'<path d="M4 6h10M4 12h16M4 18h10M17 4l3 2-3 2M17 16l3 2-3 2"/>',
  programs:'<path d="M3.5 9.5v5M6.5 7v10M17.5 7v10M20.5 9.5v5M6.5 12h11"/>',
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
  confirmReset:false, day:null, trendMode:"net", trendView:"income", restore:null, billingStatus:null, outbox:null, sim:{increase:5, mode:"amount", lose:0, ids:null}, links:{}
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
  if (c === "calendar_scope") return "Trainer Tally doesn't have permission to see your calendar yet.";
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
  if (A.events){
    S.cal = {state:"loading", done:0, total:1, error:null, at:S.cal.at, synced:true}; renderStatus();
    try {
      const onUpdate = rows => { if (seq !== loadSeq) return; S.events = E.normalizeEvents(rows, S.prof); S.cal = {...S.cal, state:"ready", at:new Date(), error:null}; renderStatus(); render(); };
      const rows = await A.events.load({refresh: !!refresh, full: refresh === "full", onUpdate});
      if (seq !== loadSeq) return;
      if (rows){ S.events = E.normalizeEvents(rows, S.prof); S.cal = {state:"ready", done:1, total:1, error:null, at:new Date(), synced:true}; renderStatus(); render(); return; }
    } catch(err){
      if (seq !== loadSeq) return;
      if (isScopeErr(err) || ["needs_reauth","server_not_connected","subscription_required"].includes(err.code)){ S.cal = {state:"error", done:0, total:1, error:err}; renderStatus(); render(); return; }
    }
    // Synced events unavailable: read the calendar directly below.
  }
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
  S.events = E.normalizeEvents(results, S.prof); S.cal = {state:"ready", done:jobs.length, total:jobs.length, error:null, at:new Date()};
  renderStatus(); render();
}

/* ---------- engine (shared with the server: src/engine.js) ---------- */
const E = globalThis.TallyEngine;
const engineData = () => ({profile:S.prof, clients:S.clients, events:S.events, now:new Date()});
const compute = () => E.compute(engineData());
const monthTotals = (M, k) => E.monthTotals(M, k);
const projectMonth = (M, k) => E.projectMonth(M, k);
const sessionsIn = (M, a, b) => E.sessionsIn(M, a, b);
const attention = M => E.attention(M);
const fillTpl = (t, v) => E.fillTpl(t, v);
const messageText = (c, kind, monthK) => E.messageText(S.M, c, kind, monthK);
const payerOf = c => S.M ? E.payerOf(S.M, c) : null;
const dependentsOf = c => S.M ? E.dependentsOf(S.M, c) : [];
const payLine = c => { const p = payerOf(c), d = dependentsOf(c); return p ? ` · paid by ${esc(p.name)}` : d.length ? ` · pays for ${esc(d.map(x=>x.name).join(", "))}` : ""; };

/* ---------- chrome ---------- */
const inAppNow = () => S.screen === "data" && S.profLoaded && S.clientsLoaded && !!(S.prof && S.prof.setupDone);
const TABS = [["overview","Home","Overview"],["calendar","Calendar","Calendar"],["clients","Clients","Clients"],["billing","Billing","Billing"],["trends","Trends","Trends"],["settings","Settings","Settings"]];
const PROGS = () => (A && A.programs && window.TallyPrograms && !(S.prof && S.prof.programsOff)) ? window.TallyPrograms : null;
const tabs = () => { const t = [...TABS.slice(0,4), ["reconcile","Reconcile","Reconcile"], ...TABS.slice(4)]; return PROGS() ? [...t.slice(0,3), ["programs","Programs","Programs"], ...t.slice(3)] : t; };
const MONTH_TABS = new Set(["overview","calendar","billing","trends"]);
function renderChrome(){
  const app = $("#app");
  const inApp = inAppNow();
  app.classList.toggle("bare", !inApp);
  const M = S.M;
  const attn = inApp && M ? attention(M).length : 0, sugg = inApp && M ? M.unmatched.length : 0;
  const recN = inApp && M ? recTodos(M).length : 0, progN = inApp && M && PROGS() ? PROGS().todos(M).filter(t => t.kind !== "noprogram").length : 0;
  const badge = k => k === "overview" && attn ? attn : k === "clients" && sugg ? sugg : k === "reconcile" && recN ? recN : k === "programs" && progN ? progN : 0;
  $("#nav").innerHTML = tabs().map(([k,l]) => `<button data-tab="${k}" ${S.tab===k?'aria-current="page"':""}>${ic(k)}<span>${l}</span>${badge(k)?`<span class="badge">${badge(k)}</span>`:""}</button>`).join("");
  $("#tabbar").style.gridTemplateColumns = `repeat(${tabs().length},1fr)`;
  $("#tabbar").innerHTML = tabs().map(([k,l]) => `<button data-tab="${k}" ${S.tab===k?'aria-current="page"':""} aria-label="${l}">${ic(k)}<span>${l}</span>${badge(k)?'<i class="dot"></i>':""}</button>`).join("");
  const pref = getThemePref();
  const themeBtn = `<div class="seg" role="group" aria-label="Appearance">${[["system","auto","Auto"],["light","sun","Light"],["dark","moon","Dark"]].map(([m,i,l])=>`<button data-act="theme" data-mode="${m}" aria-pressed="${pref===m}" title="${l}">${ic(i,' style="width:14px;height:14px"')}</button>`).join("")}</div>`;
  $("#sidefoot").innerHTML = `${themeBtn}${S.account && S.account.email ? `<span>${esc(S.account.email)}</span>` : ""}${A && A.signOut && S.account ? `<button class="btn sm ghost" data-act="signout" style="align-self:flex-start;padding-left:0">Sign out</button>` : ""}`;
  const t = tabs().find(x => x[0] === S.tab) || TABS[0];
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
  else if (S.cal.state === "error" && isScopeErr(S.cal.error) && A.grantCalendar) h += calendarPermissionCard();
  else if (S.cal.state === "error") h += `<div class="banner err"><span>${esc(calErrorText(S.cal.error))}</span><button class="btn sm" data-act="refresh">Retry</button></div>`;
  const due = pendingSignoffs();
  if (due.length && S.tab !== "billing") h += `<div class="banner"><span>${esc(due[0].ms.studioName)}'s ${esc(mLabel(due[0].m.month, true))} statement is ready for you to confirm.</span><button class="btn sm" data-act="goto-billing">Review</button></div>`;
  const held = heldCount();
  if (held && S.tab !== "settings") h += `<div class="banner"><span>${held} renewal email${held===1?" is":"s are"} drafted and waiting for your OK.</span><button class="btn sm" data-act="goto-settings" data-anchor="notices">Review</button></div>`;
  $("#status").innerHTML = inAppNow() ? h : "";
}
function render(){
  const main = $("#main");
  if (S.screen === "loading"){ renderChrome(); return; }
  if (S.screen === "signin"){ S.M = null; renderChrome(); main.innerHTML = renderSignIn(); return; }
  if (S.screen === "nostore"){ S.M = null; renderChrome(); main.innerHTML = `<div class="card"><div class="empty"><b>Sign in to keep your ledger</b><span>Open this page while signed in. Your clients and settings are saved privately to your account, so nobody else who opens it can see them.</span></div></div>`; return; }
  if (!S.profLoaded || !S.clientsLoaded){ renderChrome(); return; }
  if (S.loadError){ S.M = null; renderChrome(); main.innerHTML = `<div class="card"><div class="empty"><b>Couldn't load your data</b><span>Your clients and settings are safe. This is usually an expired sign-in or a dropped connection.</span><button class="btn primary" data-act="reload">Try again</button></div></div>`; return; }
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
  else if (S.tab === "programs" && PROGS()) h = PROGS().render();
  else if (S.tab === "reconcile") h = renderReconcile(M);
  else h = renderSettings();
  main.innerHTML = h;
  drawCharts(M);
  if (S.modal) renderModal();
  if (S.tour == null && !S.tourSeen && S.prof && !S.prof.tourDone){ S.tourSeen = true; if (S.tab !== "overview"){ S.tab = "overview"; return render(); } S.tour = 0; }
  renderTour();
}

/* ---------- sign in (hosted) ---------- */
function calendarPermissionCard(){
  return `<div class="card" style="gap:12px"><h2>One more step: allow calendar access</h2>
    <p class="small">You're signed in, but Google didn't give Trainer Tally permission to read your calendar. That box is easy to miss.</p>
    <ol class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">
      <li>Press <b>Allow calendar access</b> below.</li>
      <li>If Google says the app isn't verified, press <b>Continue</b>.</li>
      <li>On the next screen, <b>tick the box</b> next to "See and download any calendar you can access".</li>
      <li>Press <b>Continue</b> once and wait. Don't use the Back button.</li>
    </ol>
    <div class="actions"><button class="btn primary" data-act="grant-calendar">Allow calendar access</button><button class="btn ghost" data-act="cal-list">I already did, check again</button></div></div>`;
}
const isScopeErr = e => !!(e && e.code === "calendar_scope");
function renderSignIn(){
  return `<div class="signin"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5v14M9.5 5v14M14 5v14M18.5 5v14M3 16.5 21 7.5"/></svg></span>
    <h1>Trainer Tally</h1>
    <p class="muted">Your training business, counted from the calendar you already use. Packages, monthly bills, rent and renewals in one place.</p>
    ${S.signinError ? `<div class="banner err" style="text-align:left"><span>${esc(S.signinError)}</span></div>` : ""}
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
    else if (isScopeErr(S.calListErr) && A.grantCalendar) cal = calendarPermissionCard();
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
  return `<section class="card" data-tour="hero"><div class="hero">
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
  ${todoCard(M)}
  <div class="grid2">
    <section class="card" data-tour="attention"><div class="card-h"><h2>Needs attention</h2><span class="small muted">${A2.length ? A2.length + " client" + (A2.length===1?"":"s") : ""}</span></div>
      ${A2.length ? `<div class="alist">${A2.map(attnRow).join("")}</div>` : `<div class="empty">Everyone is paid up with sessions left.</div>`}
      ${M.unmatched.length ? `<div class="note">${M.unmatched.length} calendar name${M.unmatched.length===1?"":"s"} not matched to a client yet. <button class="btn link" data-tab="clients">Review</button></div>` : ""}
    </section>
    <section class="card"><div class="card-h"><h2>Sessions by week</h2><div class="legend"><span><i class="sw-acc"></i>Done</span><span><i class="sw-proj"></i>Booked / expected</span></div></div>
      <div class="chart" data-chart="weeks"></div>
      <dl class="kv"><dt>Average per week, last 8</dt><dd>${avgWeek(M).toFixed(1)}</dd><dt>Active clients</dt><dd>${S.clients.filter(c=>c.active!==false).length}</dd></dl>
    </section>
  </div>`;
}
function todoCard(M){
  const rec = recTodos(M), pg = PROGS() ? PROGS().todos(M).filter(t => t.kind !== "noprogram") : [];
  if (!rec.length && !pg.length) return "";
  const items = [
    ...rec.map(t => `<div><span>${t.state === "changed" ? `Re-check week of <b>${esc(weekLabel(t.a))}</b> · changed since you reconciled (${t.was} → ${t.n} sessions)` : `Reconcile week of <b>${esc(weekLabel(t.a))}</b> · ${t.n} session${t.n===1?"":"s"}, ${money(t.net)} net`}</span><button class="btn sm" data-act="rec-go" data-week="${t.key}">Review</button></div>`),
    ...pg.slice(0, 4).map(t => { const x = PROGS().todoText(t); return `<div><span><b>${esc(x.who)}</b> · ${esc(x.what)}</span><button class="btn sm" data-act="goto-programs">Programs</button></div>`; }),
    ...(pg.length > 4 ? [`<div><span class="muted">${pg.length - 4} more program to-do${pg.length - 4 === 1 ? "" : "s"}</span><button class="btn sm" data-act="goto-programs">See all</button></div>`] : [])
  ];
  return `<section class="card"><div class="card-h"><h2>To do</h2><span class="small muted">optional, at your own pace</span></div><div class="list">${items.join("")}</div></section>`;
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
  const pl = payLine(c); if (pl) meta += (meta ? " · " : "") + pl.slice(3);
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
      <section class="card" style="padding:12px" data-tour="cal"><div class="cal" role="grid">${cells}</div></section>
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
      <td><div class="who">${avatar(c)}<div style="min-width:0"><a href="#" class="n" data-act="edit" data-id="${c.id}">${esc(c.name)}</a><div class="s">${BILLING[st.bill].label} · ${rate}${c.noRent?" · no rent":""}${payLine(c)}</div></div></div></td>
      <td>${chipFor(st)}</td><td>${bal}</td>
      <td class="num">${st.pace ? st.pace.toFixed(1) : "–"}</td>
      <td class="small">${fmtD(st.last)}</td><td class="small">${fmtD(st.next)}</td>
      <td><div class="rowacts">${st.bill==="package" ? (st.status==="setup" ? `<button class="btn sm" data-act="setup-pkg" data-id="${c.id}">Set package</button>` : `<button class="btn sm" data-act="add-pkg" data-id="${c.id}">New package</button>`) : ""}
        ${st.bill!=="payg" ? `<button class="btn sm" data-act="msg" data-id="${c.id}" data-kind="${st.bill==="package"?(st.status==="owes"?"unpaid":"renew"):"invoice"}">Message</button>` : ""}
        <button class="btn sm" data-act="payment" data-id="${c.id}">Payment</button></div></td></tr>`; };
  const sugg = M.unmatched;
  return `<section class="card" data-tour="clients"><div class="card-h"><h2>Clients</h2><span class="small muted">${act.length} active</span></div>
    ${act.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Status</th><th>Package / balance</th><th class="num">Per wk</th><th>Last</th><th>Next</th><th></th></tr></thead><tbody>${act.map(row).join("")}</tbody></table></div>` : `<div class="empty">No clients yet. Add one, or pick from the names found on your calendar below.</div>`}
    ${inact.length ? `<details><summary class="small muted">${inact.length} inactive</summary><div class="tablewrap"><table><tbody>${inact.map(row).join("")}</tbody></table></div></details>` : ""}
  </section>
  <section class="card" data-tour="found"><div class="card-h"><h2>Found on your calendar</h2><span class="small muted">Recurring event names not matched to a client</span></div>
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
  return `${studioRentCard()}<div class="stats">
    <div class="stat"><span class="k">Billed</span><span class="v">${money(billed)}</span><span class="d">bills, packages, paid sessions</span></div>
    <div class="stat"><span class="k">Collected</span><span class="v">${money(collected)}</span><span class="d">payments dated this month</span></div>
    <div class="stat"><span class="k">Open bills</span><span class="v ${openN?"neg":""}">${openN}</span><span class="d">for ${esc(mName(k))}</span></div>
    <div class="stat"><span class="k">Packages sold</span><span class="v">${pkgs.length}</span><span class="d">${money(pkgs.reduce((a,x)=>a+num(x.p.price),0))}</span></div>
  </div>
  <section class="card" data-tour="bills"><div class="card-h"><h2>Monthly bills</h2><span class="small muted">${k===cur?"Monthly-bill clients are due at month end":"Sessions × rate, or membership fee"}</span></div>
    ${monthly.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Plan</th><th class="num">Sessions</th><th class="num">Amount</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead><tbody>
    ${monthly.map(({c,st,inv}) => `<tr><td><div class="who">${avatar(c)}<div style="min-width:0"><a href="#" class="n" data-act="edit" data-id="${c.id}">${esc(c.name)}</a>${payLine(c)?`<div class="s">${payLine(c).slice(3)}</div>`:""}</div></div></td><td class="small">${BILLING[st.bill].label}</td>
      <td class="num">${inv.n}${inv.sched?`<span class="muted"> +${inv.sched}</span>`:""}</td><td class="num" style="font-weight:600">${money(inv.amount)}</td><td class="num">${money(inv.paid)}</td><td>${stateChip(inv)}</td>
      <td><div class="rowacts"><button class="btn sm" data-act="msg" data-id="${c.id}" data-kind="invoice" data-month="${inv.month}">Bill</button>${inv.state!=="paid"?`<button class="btn sm" data-act="payment" data-id="${c.id}" data-amount="${Math.max(0,inv.amount-inv.paid)}">Log payment</button>`:""}</div></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">No monthly-bill or membership clients had sessions this month.</div>`}
  </section>
  <section class="card"><div class="card-h"><h2>Packages</h2></div>
    ${pkgs.length ? `<div class="list">${pkgs.map(({c,p}) => `<div><span class="who">${avatar(c)}<span><b>${esc(c.name)}</b> · ${num(p.size)} sessions · ${money(num(p.price))}${payerOf(c)?` · paid by ${esc(payerOf(c).name)}`:""}</span></span>${p.paidDate?`<span class="chip ok">Paid ${fmtD(parseDay(p.paidDate))}</span>`:`<button class="btn sm" data-act="payment" data-id="${c.id}">Mark paid</button>`}</div>`).join("")}</div>` : `<div class="empty">No packages sold or started this month.</div>`}
  </section>
  ${payg.length ? `<section class="card"><div class="card-h"><h2>Pay as you go</h2></div><div class="list">${payg.map(({c,m}) => `<div><span class="who">${avatar(c)}<span><b>${esc(c.name)}</b> · ${m.n} session${m.n===1?"":"s"}</span></span><span style="font-weight:600">${money(m.earned)}</span></div>`).join("")}</div></section>` : ""}`;
}

/* ---------- trends ---------- */
function renderTrends(M){
  const seg = `<div class="seg trendseg" role="group" aria-label="Trends view">${[["income","Income"],["weekly","Weekly"],["clients","Clients"],["pricing","Pricing"]].map(([v,l])=>`<button data-act="trend-view" data-view="${v}" aria-pressed="${S.trendView===v}">${l}</button>`).join("")}</div>`;
  if (S.trendView === "clients") return seg + renderClientTrends(M);
  if (S.trendView === "weekly") return seg + renderWeekly(M);
  if (S.trendView === "pricing") return seg + renderPricing(M);
  return seg + renderIncomeTrends(M) + taxCard(M);
}
function renderIncomeTrends(M){
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
  <section class="card" data-tour="trend"><div class="card-h"><h2>Monthly income</h2>
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

/* ---------- weekly ---------- */
/* What one client is worth in a normal week, from their current price and last-8-week pace. */
function typicalWeek(M){
  const r = rentCfg();
  const rows = S.clients.filter(c => c.active !== false && M.stats[c.id].pace > 0).map(c => {
    const st = M.stats[c.id], n = st.pace;
    const per = st.bill === "membership" ? num(c.fee) / Math.max(1, n * 52/12) : (st.perSession || st.rate || 0);
    const rentPer = c.noRent ? 0 : r.mode === "perSession" ? num(r.perSession) * st.rentShare : r.mode === "percent" ? per * num(r.percent)/100 * st.rentShare : 0;
    return {c, st, n, per, rentPer, gross:n*per, rent:n*rentPer, net:n*(per-rentPer)};
  }).sort((a,b) => b.net - a.net);
  const tot = rows.reduce((a,x) => ({n:a.n+x.n, gross:a.gross+x.gross, rent:a.rent+x.rent, net:a.net+x.net}), {n:0, gross:0, rent:0, net:0});
  if (r.mode === "monthly"){ const wk = num(r.monthly) * 12/52; tot.rent += wk; tot.net -= wk; }
  return {rows, tot};
}
function weekRows(M){
  const r = rentCfg(), cur = sow(M.now), out = [];
  for (let i = -11; i <= 4; i++){
    const a = addDays(cur, 7*i), b = addDays(a, 7);
    const list = sessionsIn(M, a, b).filter(s => s.billable !== false);
    const done = list.filter(s => !s.future);
    const earned = list.reduce((x,s)=>x+s.value,0);
    let rent = list.reduce((x,s)=>x+s.rent,0);
    if (r.mode === "monthly") rent += num(r.monthly) * 12/52;
    const by = {};
    for (const s of list){ const e = by[s.c.id] || (by[s.c.id] = {c:s.c, n:0, booked:0, earned:0, rent:0}); if (s.future) e.booked++; else e.n++; e.earned += s.value; e.rent += s.rent; }
    out.push({key:ymd(a), a, b, i, n:done.length, booked:list.length-done.length, earned, rent, net:earned-rent, clients:Object.values(by).sort((x,y)=>(y.earned-y.rent)-(x.earned-x.rent))});
  }
  return out;
}
function renderWeekly(M){
  const T = typicalWeek(M), W = weekRows(M);
  const past = W.filter(w => w.i < 0), last8 = past.slice(-8);
  const avg = k => last8.length ? last8.reduce((a,w)=>a+w[k],0)/last8.length : 0;
  const thisW = W.find(w => w.i === 0);
  const wkLabel = w => `${fmtD(w.a)} – ${fmtD(addDays(w.b,-1))}`;
  const rowsHtml = [...W].reverse().map(w => {
    const open = S.weekOpen === w.key;
    const tag = w.i === 0 ? ' <span class="chip info">This week</span>' : w.i > 0 ? ' <span class="chip neutral">Booked</span>' : "";
    const sess = w.i > 0 ? `${w.booked}` : `${w.n}${w.booked ? `<span class="muted"> +${w.booked}</span>` : ""}`;
    const detail = open ? `<tr class="wkdetail"><td colspan="6">${w.clients.length ? `<table class="sub"><thead><tr><th>Client</th><th class="num">Sessions</th><th class="num">Earned</th><th class="num">Rent</th><th class="num">Net</th></tr></thead><tbody>${w.clients.map(x => `<tr><td><div class="who">${avatar(x.c)}<span class="n">${esc(x.c.name)}</span></div></td><td class="num">${x.n}${x.booked?`<span class="muted"> +${x.booked} booked</span>`:""}</td><td class="num">${money(x.earned)}</td><td class="num">${money(x.rent)}</td><td class="num" style="font-weight:600">${money(x.earned-x.rent)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No sessions this week.</div>`}</td></tr>` : "";
    return `<tr class="wkrow${open?" open":""}" data-act="week-open" data-week="${w.key}" tabindex="0" role="button" aria-expanded="${open}"><td><span class="caret" aria-hidden="true">${open?"▾":"▸"}</span> ${wkLabel(w)}${tag}</td><td class="num">${sess}</td><td class="num">${money(w.earned)}</td><td class="num">${money(w.rent)}</td><td class="num" style="font-weight:600">${money(w.net)}</td><td class="num small muted">${w.n+w.booked ? money2(w.net/(w.n+w.booked)) : "–"}</td></tr>${detail}`;
  }).join("");
  return `<div class="stats">
      <div class="stat"><span class="k">Typical week</span><span class="v">${T.tot.n.toFixed(1)}</span><span class="d">sessions at your current setup</span></div>
      <div class="stat"><span class="k">Typical week net</span><span class="v">${money(T.tot.net)}</span><span class="d">${money(T.tot.gross)} earned · ${money(T.tot.rent)} rent</span></div>
      <div class="stat"><span class="k">Last 8 weeks, avg</span><span class="v">${avg("n").toFixed(1)}</span><span class="d">${money(avg("net"))} net a week</span></div>
      <div class="stat"><span class="k">This week</span><span class="v">${thisW.n}<small class="muted" style="font-size:14px"> +${thisW.booked} booked</small></span><span class="d">${money(thisW.net)} net if all happen</span></div>
    </div>
  <section class="card" data-tour="weekly"><div class="card-h"><h2>Week by week</h2><span class="small muted">Monday to Sunday · tap a week for the client breakdown</span></div>
    <div class="tablewrap"><table class="weeks"><thead><tr><th>Week</th><th class="num">Sessions</th><th class="num">Earned</th><th class="num">Rent</th><th class="num">Net</th><th class="num">Net / session</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <p class="small muted">Past weeks count sessions that happened. Grey "+" numbers are booked but still ahead.${rentCfg().mode==="monthly"?" Monthly studio rent is spread evenly across weeks.":""}</p>
  </section>
  <section class="card"><div class="card-h"><h2>Your current setup, per week</h2><span class="small muted">each client's current price × their pace over the last 8 weeks</span></div>
    ${T.rows.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th class="num">Per week</th><th class="num">Price / session</th><th class="num">Rent / session</th><th class="num">Net / week</th><th class="num">Share</th></tr></thead><tbody>
    ${T.rows.map(x => `<tr><td><div class="who">${avatar(x.c)}<div style="min-width:0"><a href="#" class="n" data-act="edit" data-id="${x.c.id}">${esc(x.c.name)}</a><div class="s">${BILLING[x.st.bill].label}${payLine(x.c)}</div></div></div></td><td class="num">${x.n.toFixed(1)}</td><td class="num">${money2(x.per)}</td><td class="num">${x.rentPer ? money2(x.rentPer) : "–"}</td><td class="num" style="font-weight:600">${money(x.net)}</td><td class="num">${T.tot.net > 0 ? Math.round(100*x.net/T.tot.net) : 0}%</td></tr>`).join("")}
    <tr class="total"><td style="font-weight:700">Total</td><td class="num" style="font-weight:700">${T.tot.n.toFixed(1)}</td><td class="num">${T.tot.n ? money2(T.tot.gross/T.tot.n) : "–"}</td><td class="num">${T.tot.n ? money2(T.tot.rent/T.tot.n) : "–"}</td><td class="num" style="font-weight:700">${money(T.tot.net)}</td><td></td></tr>
    </tbody></table></div>
    <p class="small muted">Per year at this pace: ${money(T.tot.net*52)} net (${money(T.tot.net*48)} with 4 weeks off).</p>` : `<div class="empty">Once clients have sessions in the last 8 weeks, their weekly value shows here.</div>`}
  </section>`;
}

/* ---------- client trends ---------- */
const HEALTH = {quiet:["Gone quiet","owes"], slipping:["Slipping","low"], new:["New","info"], growing:["Growing","ok"], steady:["Steady","neutral"]};
function miniBars(weekly){ const mx = Math.max(1, ...weekly); return `<span class="mini" aria-hidden="true">${weekly.map(n => `<i style="height:${Math.max(6, Math.round(100*n/mx))}%"${n?"":' class="z"'}></i>`).join("")}</span>`; }
function renderClientTrends(M){
  const H = E.clientHealth(M), R = E.retention(M);
  const count = k => H.filter(h => h.status === k).length;
  const last = R.months[R.months.length-1] || {active:0}, prev = R.months[R.months.length-2];
  const lost90 = R.months.slice(-4, -1).reduce((a,m)=>a+(m.lost||0),0), new90 = R.months.slice(-3).reduce((a,m)=>a+m.new,0);
  const cxl = H.reduce((a,h)=>a+h.cancels,0), done = H.reduce((a,h)=>a+Math.round(h.cancelRate && h.cancels ? h.cancels/h.cancelRate - h.cancels : 0),0);
  return `<div class="stats">
      <div class="stat"><span class="k">Active this month</span><span class="v">${last.active}</span><span class="d">${prev ? (last.active-prev.active>=0?"+":"")+(last.active-prev.active)+" vs last month" : "clients with a session"}</span></div>
      <div class="stat"><span class="k">New · last 3 months</span><span class="v">${new90}</span><span class="d">${lost90} stopped coming</span></div>
      <div class="stat"><span class="k">Need a check-in</span><span class="v">${count("quiet")+count("slipping")}</span><span class="d">${count("quiet")} quiet · ${count("slipping")} slipping</span></div>
      <div class="stat"><span class="k">Avg value per client</span><span class="v">${money(R.avgValue)}</span><span class="d">earned since you started counting</span></div>
    </div>
    <section class="card" data-tour="health"><div class="card-h"><h2>Client health</h2><span class="small muted">last 4 weeks vs the 12 before · ${cxl+done ? Math.round(100*cxl/(cxl+done)) : 0}% skipped/cancelled (90 days)</span></div>
      ${H.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Status</th><th>12 weeks</th><th class="num">Last visit</th><th class="num">Per week</th><th class="num">Earned</th></tr></thead><tbody>
      ${H.map(h => `<tr><td><div class="who">${avatar(h.c)}<span class="n">${esc(h.c.name)}</span></div></td><td><span class="chip ${HEALTH[h.status][1]}">${HEALTH[h.status][0]}</span><div class="small muted">${esc(h.note)}</div></td><td>${miniBars(h.weekly)}</td>
        <td class="num">${h.daysSince == null ? "–" : h.daysSince === 0 ? "today" : h.daysSince + "d ago"}${h.bookedSoon ? '<div class="small muted">booked</div>' : ""}</td><td class="num">${h.recent.toFixed(1)}</td><td class="num" style="font-weight:600">${money(h.earned)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">Add clients to see trends.</div>`}
    </section>
    <section class="card"><h2>Clients by month</h2>
      <div class="tablewrap"><table><thead><tr><th>Month</th><th class="num">Active</th><th class="num">New</th><th class="num">Stopped</th></tr></thead><tbody>
      ${[...R.months].reverse().slice(0,12).map(m => `<tr><td>${esc(mLabel(m.month))}</td><td class="num" style="font-weight:600">${m.active}</td><td class="num">${m.new||"–"}</td><td class="num">${m.lost==null?'<span class="small muted">in progress</span>':(m.lost||"–")}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="small muted">"Stopped" means they trained the month before but not that month.</p>
    </section>`;
}
function renderPricing(M){
  const sim = S.sim, act = S.clients.filter(c => c.active !== false && M.stats[c.id].pace);
  const ids = sim.ids || act.map(c => c.id);
  const R = E.simulateRate(M, {increase:num(sim.increase), mode:sim.mode, clientIds:ids, lose:num(sim.lose)});
  return `<section class="card" data-tour="sim"><div class="card-h"><h2>What if I raised my rate?</h2></div>
    <div class="form">
      <div class="field"><label for="sim-inc">Raise by</label><input id="sim-inc" type="number" step="1" value="${esc(sim.increase)}"></div>
      <div class="field"><label for="sim-mode">As</label><select id="sim-mode"><option value="amount" ${sim.mode==="amount"?"selected":""}>$ per session</option><option value="percent" ${sim.mode==="percent"?"selected":""}>% of current price</option></select></div>
      <div class="field"><label for="sim-lose">If this many clients leave</label><input id="sim-lose" type="number" min="0" step="1" value="${esc(sim.lose)}"></div>
    </div>
    <div class="stats">
      <div class="stat"><span class="k">Per month</span><span class="v">${R.monthly>=0?"+":""}${money(R.monthly)}</span><span class="d">${R.lossCost ? money(R.gross)+" gained, "+money(R.lossCost)+" lost" : "net after rent, at current pace"}</span></div>
      <div class="stat"><span class="k">Per year</span><span class="v">${R.annual>=0?"+":""}${money(R.annual)}</span><span class="d">${R.clients} client${R.clients===1?"":"s"} included</span></div>
      <div class="stat"><span class="k">Room to lose</span><span class="v">${R.breakEven.toFixed(1)}</span><span class="d">client${R.breakEven>=0.95&&R.breakEven<1.05?"":"s"} could leave and you'd still earn the same</span></div>
    </div>
    <h3>Who it applies to</h3>
    <div class="tablewrap"><table><thead><tr><th></th><th>Client</th><th class="num">Sessions / mo</th><th class="num">Now / mo</th><th class="num">New price</th><th class="num">Change / mo</th></tr></thead><tbody>
    ${act.map(c => { const r = R.rows.find(x => x.c.id === c.id), st = M.stats[c.id], on = ids.includes(c.id);
      return `<tr><td><input type="checkbox" data-sim-id="${esc(c.id)}" ${on?"checked":""} aria-label="Include ${esc(c.name)}"></td><td><div class="who">${avatar(c)}<span class="n">${esc(c.name)}</span></div><div class="small muted">${esc(BILLING[st.bill].label)}</div></td>
        <td class="num">${(st.pace*52/12).toFixed(1)}</td><td class="num">${r ? money(r.now) : "–"}</td><td class="num">${r ? money2(r.newRate) + (st.bill==="membership"?"/mo":"") : "–"}</td><td class="num" style="font-weight:600">${r ? "+"+money(r.add) : "–"}</td></tr>`; }).join("")}
    </tbody></table></div>
    <p class="small muted">Uses each client's pace over the last 8 weeks. Packages: the price per session goes up when they next renew. Clients who leave are valued at your average client.</p>
  </section>`;
}
function taxCard(M){
  const T = E.taxEstimate(M);
  if (!T.enabled) return `<section class="card"><div class="card-h"><h2>Taxes</h2><button class="btn sm" data-act="goto-settings" data-anchor="tax">Turn on</button></div><p class="small muted">Self-employed? Turn on the tax set-aside in Settings to see how much of each month to put away and what your quarterly payments might be.</p></section>`;
  return `<section class="card" data-tour="tax"><div class="card-h"><h2>Tax set-aside</h2><span class="small muted">${Math.round(T.rate*100)}% of profit · estimate, not tax advice</span></div>
    <div class="stats">
      <div class="stat"><span class="k">Set aside this month</span><span class="v">${money(T.thisMonth.setAside)}</span><span class="d">of ${money(T.thisMonth.net)} profit so far</span></div>
      <div class="stat"><span class="k">${M.curM.slice(0,4)} so far</span><span class="v">${money(T.ytdTax)}</span><span class="d">on ${money(T.ytdProfit)} profit</span></div>
      ${T.next ? `<div class="stat"><span class="k">${T.next.label} payment</span><span class="v">${money(T.next.tax)}</span><span class="d">due ${fmtD(T.next.due)}</span></div>` : ""}
    </div>
    <div class="tablewrap"><table><thead><tr><th>Quarter</th><th class="num">Profit</th><th class="num">Estimated tax</th><th>Due</th></tr></thead><tbody>
    ${T.quarters.map(q => `<tr><td>${q.label}</td><td class="num">${money(q.profit)}</td><td class="num" style="font-weight:600">${money(q.tax)}</td><td>${fmtD(q.due)} ${q.state==="past"?'<span class="chip neutral">past</span>':q.state==="due"?'<span class="chip low">due next</span>':q.state==="current"?'<span class="chip info">this quarter</span>':""}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="small muted">Profit = what you earned minus studio rent${num(T.cfg.expensesMonthly) ? " and " + money(T.cfg.expensesMonthly) + "/month of expenses" : ""}. Self-employment tax is 15.3% of 92.35% of profit, plus the federal and state rates you set. Check with a tax professional.</p>
  </section>`;
}

/* ---------- automatic messages ---------- */
function noticesCard(){
  const n = {...DEFAULTS.notices, ...(P("notices")||{})};
  const live = !!A.outbox;
  return `<section class="card" id="notices" data-tour="notices"><h2>Automatic messages</h2>
    <p class="small muted">${live ? "Checked every hour, in your time zone (" + esc(P("timeZone") || Intl.DateTimeFormat().resolvedOptions().timeZone) + ")." : "Available in the hosted app. Here you can see how they'd be set up."}</p>
    <div class="form">
      <label class="check full"><input type="checkbox" id="nt-weekly" ${n.weekly!==false?"checked":""}> Weekly summary, Saturday at 8pm</label>
      <label class="check full"><input type="checkbox" id="nt-monthly" ${n.monthly!==false?"checked":""}> Monthly reconciliation, 2 days before the month ends</label>
      <div class="field full"><label for="nt-email">Send summaries to</label><input id="nt-email" type="email" value="${esc(n.email)}" placeholder="${esc(P("myEmail") || (S.account && S.account.email) || "you@example.com")}"></div>
      <div class="field full"><label for="nt-renew">Renewal reminders to clients</label><select id="nt-renew">
        <option value="off" ${n.renewals==="off"?"selected":""}>Off</option>
        <option value="ask" ${n.renewals==="ask"?"selected":""}>Draft them, I'll approve each one</option>
        <option value="auto" ${n.renewals==="auto"?"selected":""}>Send automatically</option></select>
        <span class="hint">When a package hits your renewal flag. Uses your renewal message and goes to the client's email, with replies coming to you.</span></div>
    </div>
    <div class="actions"><button class="btn primary" data-act="save-notices" ${S.readOnly?"disabled":""}>Save</button>
      ${live ? `<button class="btn" data-act="notice-test" data-kind="weekly">Preview weekly</button><button class="btn" data-act="notice-test" data-kind="monthly">Preview monthly</button>` : ""}</div>
    ${live ? outboxList() : ""}
  </section>`;
}
const OB = {queued:["Waiting","info"], held:["Needs your OK","low"], sent:["Sent","ok"], skipped:["Skipped","neutral"], failed:["Failed","owes"]};
function outboxList(){
  const L = S.outbox;
  if (!L) return `<h3>Recent</h3><p class="small muted">Loading…</p>`;
  const mailOff = L.some(r => r.status === "queued" && /set up/.test(r.error||""));
  return `<h3>Recent</h3>
    ${mailOff ? `<p class="small muted">Email sending isn't switched on yet, so messages wait here. You can read each one.</p>` : ""}
    ${L.length ? `<div class="list">${L.slice(0,12).map(r => `<div><span><b>${esc(r.subject)}</b><span class="small muted"> · ${esc(new Date(r.created_at).toLocaleDateString(undefined,{month:"short",day:"numeric"}))} · to ${esc(r.to_email||"–")}</span></span>
      <span class="row-actions"><span class="chip ${OB[r.status][1]}">${OB[r.status][0]}</span><button class="btn sm" data-act="ob-view" data-oid="${esc(r.id)}">View</button>${r.status==="held"||r.status==="failed" ? `<button class="btn sm primary" data-act="ob-send" data-oid="${esc(r.id)}">Send</button><button class="btn sm ghost" data-act="ob-skip" data-oid="${esc(r.id)}">Skip</button>` : ""}</span></div>`).join("")}</div>` : `<p class="small muted">Nothing yet.</p>`}`;
}
async function refreshOutbox(){ if (!A.outbox) return; try { S.outbox = await A.outbox.list(); } catch(e){ S.outbox = []; } if (S.tab === "settings" && !S.modal) render(); }
function heldCount(){ return (S.outbox||[]).filter(r => r.status === "held").length; }
function taxSettingsCard(){
  const t = {...DEFAULTS.tax, ...(P("tax")||{})};
  return `<section class="card" id="tax" data-tour="taxset"><div class="card-h"><h2>Tax set-aside</h2><label class="check"><input type="checkbox" id="tx-on" ${t.enabled?"checked":""}> On</label></div>
    <p class="small muted">Shows how much of your profit to put aside for taxes, in Trends and your summaries. A rough estimate for self-employed trainers, not tax advice.</p>
    <div class="form">
      <div class="field"><label for="tx-fed">Federal income tax %</label><input id="tx-fed" type="number" min="0" step="0.5" value="${esc(t.federal)}"></div>
      <div class="field"><label for="tx-state">State income tax %</label><input id="tx-state" type="number" min="0" step="0.5" value="${esc(t.state)}"></div>
      <label class="check full"><input type="checkbox" id="tx-se" ${t.se!==false?"checked":""}> Include self-employment tax (about 14.1%)</label>
      <div class="field"><label for="tx-set">Or just set aside this %</label><input id="tx-set" type="number" min="0" step="1" value="${esc(t.setAside ?? "")}" placeholder="optional"></div>
      <div class="field"><label for="tx-exp">Monthly business expenses ($)</label><input id="tx-exp" type="number" min="0" step="1" value="${esc(t.expensesMonthly||"")}" placeholder="gym, insurance, software"></div>
    </div>
    <div class="actions"><button class="btn primary" data-act="save-tax" ${S.readOnly?"disabled":""}>Save</button></div>
  </section>`;
}
function saveTimeZone(){
  let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(e){}
  if (tz && P("timeZone") !== tz && !S.readOnly) saveProfile({timeZone: tz}).catch(()=>{});
  refreshOutbox();
}

/* ---------- client page links ---------- */
function clientLinkBlock(c){
  const L = S.links[c.id];
  if (L === undefined){ S.links[c.id] = null; A.links.get(c.id).then(x => { S.links[c.id] = x || false; if (S.modal && S.modal.id === c.id) renderModal(); }).catch(() => { S.links[c.id] = false; }); }
  const url = L && L.url;
  return `<h3>Client page</h3>
    <p class="small muted">A private link ${esc(firstName(c.name))} can open to see sessions left and what's booked. No prices, no other clients. Turn it off any time.</p>
    ${url ? `<div class="form"><div class="field full"><input id="cl-link" readonly value="${esc(url)}"></div></div>
      <div class="actions"><button class="btn" data-act="link-copy">Copy link</button><a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener">Open</a><button class="btn ghost danger" data-act="link-off" data-cid="${esc(c.id)}">Turn off</button></div>`
    : L === null ? `<p class="small muted">Checking…</p>` : `<div class="actions"><button class="btn" data-act="link-make" data-cid="${esc(c.id)}" ${S.readOnly?"disabled":""}>Create link</button></div>`}`;
}

/* ---------- studios (hosted) ---------- */
/* Months a trainer should sign off: last month, plus this month from 2 days before it ends. */
function signoffMonths(st, now){
  const curM = mkey(now), last = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const cut = mkey(new Date(now.getFullYear(), now.getMonth()-1, 1));
  return (st.months||[]).filter(m => (m.n || m.rent) && m.month >= cut && (m.month < curM || (m.month === curM && now.getDate() >= last - 2)));
}
function signoffFor(ms, k){ return (ms.signoffs||[]).find(x => x.month === k) || null; }
function pendingSignoffs(){
  if (!A.studio || !S.studios || !S.M) return [];
  const out = [];
  for (const ms of S.studios){ const st = ms.trainer && ms.trainer.statement; if (!st) continue;
    for (const m of signoffMonths(st, S.M.now)) if (!signoffFor(ms, m.month)) out.push({ms, m}); }
  return out;
}
function studioRentCard(){
  if (!A.studio || !S.studios || !S.studios.length) return "";
  const M = S.M;
  return S.studios.map(ms => { const st = ms.trainer && ms.trainer.statement;
    const sign = st ? signoffMonths(st, M.now) : [];
    const signRows = sign.map(m => { const so = signoffFor(ms, m.month), mine = E.studioCount(M, m.month), diff = mine.n !== m.n;
      return `<div class="aitem so"><div class="top"><b>${esc(mLabel(m.month, true))}</b>
          ${so ? `<span class="chip ${so.status==="confirmed"?"ok":"low"}">${so.status==="confirmed"?"Confirmed":"Disputed"}</span>` : `<span class="chip info">Waiting for you</span>`}</div>
        <div class="meta">Studio: ${m.n} session${m.n===1?"":"s"} · ${money(m.rent)} rent &nbsp;·&nbsp; Your calendar: ${mine.n} studio session${mine.n===1?"":"s"}${mine.free ? ` (+${mine.free} with no rent)` : ""}${diff ? ` <b class="warn">· ${mine.n > m.n ? "+" : ""}${mine.n - m.n} difference</b>` : ` · matches`}</div>
        ${so && so.note ? `<div class="meta">Your note: ${esc(so.note)}</div>` : ""}
        ${!so || so.status === "disputed" ? `<div class="rowacts"><button class="btn sm primary" data-act="so-confirm" data-sid="${esc(ms.studioId)}" data-m="${m.month}">Confirm</button><button class="btn sm" data-act="so-dispute" data-sid="${esc(ms.studioId)}" data-m="${m.month}">${so ? "Edit dispute" : "Dispute"}</button></div>` : ""}
      </div>`; }).join("");
    return `<section class="card" id="studio-${esc(ms.studioId)}"><div class="card-h"><h2>Studio rent · ${esc(ms.studioName)}</h2>${st ? `<span class="chip ${st.balance>0.5?"owes":"ok"}">${st.balance>0.5?"You owe "+money(st.balance):"Paid up"}</span>` : ""}</div>
      ${st ? `<p class="small muted">${esc(st.rule)} · updated ${esc(new Date(st.updatedAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}))} by the studio</p>
      ${signRows ? `<h3>Monthly sign-off</h3><p class="small muted">Check the studio's count against your calendar, then confirm or dispute. The studio sees only your answer, your session count and your note.</p><div class="alist">${signRows}</div>` : ""}
      <div class="tablewrap"><table><thead><tr><th>Month</th><th class="num">Sessions</th><th class="num">Rent</th><th class="num">Paid</th><th>Status</th></tr></thead><tbody>
      ${[...st.months].reverse().slice(0,4).map(m => `<tr><td>${esc(mLabel(m.month))}</td><td class="num">${m.n}</td><td class="num" style="font-weight:600">${money(m.rent)}</td><td class="num">${money(m.paid)}</td><td><span class="chip ${m.state==="paid"||m.state==="none"?"ok":m.state==="partial"?"low":m.state==="running"?"info":"owes"}">${m.state==="running"?"In progress":m.state==="none"?"No rent":m.state[0].toUpperCase()+m.state.slice(1)}</span></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">Your studio hasn't sent a statement yet.</div>`}</section>`; }).join("");
}
async function signOff(studioId, month, status, note, trainerN){
  const ms = (S.studios||[]).find(x => x.studioId === studioId); if (!ms || !ms.trainer) return;
  const m = ms.trainer.statement.months.find(x => x.month === month);
  try { await A.studio.signOff({studioId, trainerId: ms.trainer.id, month, status, note: note || "", studio_n: m.n, studio_rent: m.rent, trainer_n: trainerN});
    toast(status === "confirmed" ? `${mLabel(month)} confirmed` : "Dispute sent to the studio"); await refreshStudios(); }
  catch(err){ toast(err.message || "Couldn't save that"); }
}
function studiosSettingsCard(){
  if (!A.studio) return "";
  const list = S.studios || [];
  return `<section class="card"><h2>Studios</h2>
    ${list.length ? `<div class="list">${list.map(ms => `<div><span><b>${esc(ms.studioName)}</b>${ms.trainer?` · ${esc(ms.trainer.name||"")}`:""}</span><button class="btn sm" data-act="studio-leave" data-sid="${esc(ms.studioId)}">Leave</button></div>`).join("")}</div>` : `<p class="small muted">If your studio uses Trainer Tally, join it with the code they sent to see your rent statement here.</p>`}
    <div class="form"><div class="field"><label for="st-join">Studio code</label><input id="st-join" placeholder="e.g. K7M2QX9A" autocomplete="off"></div></div>
    <div class="actions"><button class="btn" data-act="studio-join">Join studio</button><a class="btn ghost" href="${esc(A.studio.url)}">${S.ownsStudio ? "Open the studio side →" : "Run a studio? Set up the studio side →"}</a></div>
  </section>`;
}
async function refreshStudios(){ if (!A.studio) return; try { S.studios = await A.studio.memberships(); S.ownsStudio = await A.studio.ownsStudio(); } catch(e){ S.studios = []; } if (inAppNow()) render(); }
async function joinStudio(code){
  try { const r = await A.studio.join(code); toast(`You joined ${r.studioName}`); try { localStorage.removeItem("tt-join"); } catch(e){} await refreshStudios(); }
  catch(err){ toast(err.message || "Couldn't join that studio"); try { localStorage.removeItem("tt-join"); } catch(e){} }
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
  <section class="card" id="features"><h2>Features</h2>
    ${A.programs ? `<label class="check"><input type="checkbox" data-act="feat" data-k="programs" ${S.prof && S.prof.programsOff ? "" : "checked"}> <span><b>Programs</b> <span class="small muted">· build client workouts, exercise videos, homework links, measurements</span></span></label>` : ""}
    <label class="check"><input type="checkbox" data-act="feat" data-k="reconcile" ${S.prof && S.prof.reconcileReminders === false ? "" : "checked"}> <span><b>Weekly reconcile reminders</b> <span class="small muted">· a to-do on Home for each finished week you haven't marked off</span></span></label>
    <p class="small muted">Turning a feature off hides it. Nothing is deleted.</p>
  </section>
  <section class="card"><h2>Messages and matching</h2>
    <div class="form">
      <div class="field full"><label for="st-renew">Renewal message</label><textarea id="st-renew">${esc(P("renewalTemplate"))}</textarea><span class="hint">{first} {left} {size} {price} {me}</span></div>
      <div class="field full"><label for="st-inv">Monthly bill message</label><textarea id="st-inv">${esc(P("invoiceTemplate"))}</textarea><span class="hint">{first} {month} {amount} {details} {me}</span></div>
      <div class="field full"><label for="st-ign">Skip events containing these words</label><input id="st-ign" value="${esc((P("ignoreWords")||[]).join(", "))}"><span class="hint">Comma separated. A session titled "Maria cancel" won't count.</span></div>
      <div class="field full"><label for="st-extra">On shared calendars, also count events created by</label><input id="st-extra" type="email" value="${esc((P("extraCreators")||[]).join(", "))}" placeholder="name@gmail.com"><span class="hint">For someone who books sessions for you. Comma separated.</span></div>
      <div class="field full"><label for="st-norent">No studio rent when the title includes</label><input id="st-norent" value="${esc((P("noRentWords")||[]).join(", "))}"><span class="hint">For sessions away from the studio, e.g. "Sarah home" or "Mike - online". Still counted as a session.</span></div>
      <div class="field"><label for="st-th">Renewal flag at</label><input id="st-th" type="number" min="0" value="${esc(P("threshold"))}"></div>
    </div>
    ${(P("ignoredTitles")||[]).length ? `<h3>Names marked "not a client"</h3><div class="list">${(P("ignoredTitles")||[]).map((t,i)=>`<div><span>${esc(t)}</span><button class="btn sm" data-act="unignore" data-i="${i}">Restore</button></div>`).join("")}</div>` : ""}
    <div class="actions"><button class="btn primary" data-act="save-settings" ${S.readOnly?"disabled":""}>Save</button></div>
  </section></div>
  <div class="grid2">${noticesCard()}${taxSettingsCard()}</div>
  ${studiosSettingsCard()}
  <div class="grid2">
  <section class="card" data-tour="backup"><h2>Backup and export</h2>
    <p class="small muted">Download everything you've entered, or pull your sessions and payments into a spreadsheet. A backup can be restored here or in any other copy of Trainer Tally.</p>
    <div class="actions">
      <button class="btn primary" data-act="export-json">Download backup (.json)</button>
      <button class="btn" data-act="export-sessions">Sessions (.csv)</button>
      <button class="btn" data-act="export-payments">Payments (.csv)</button>
      <button class="btn" data-act="restore-open" ${S.readOnly?"disabled":""}>Restore a backup</button>
    </div>
    <div class="actions"><button class="btn ghost" data-act="tour-start">Replay the walkthrough</button></div>
  </section>
  <section class="card"><div class="card-h"><h2>Appearance</h2><div class="seg" role="group" aria-label="Appearance">${[["system","Auto"],["light","Light"],["dark","Dark"]].map(([m,l])=>`<button data-act="theme" data-mode="${m}" aria-pressed="${getThemePref()===m}">${l}</button>`).join("")}</div></div>
    <h2>Your data</h2><p class="small muted">Your clients, packages and payments are private to your account. Nothing is ever written to your calendar.</p>
    ${A.billing ? `<dl class="kv"><dt>Plan</dt><dd>${esc(bs ? bs.label : "Checking…")}</dd></dl><div class="actions">${bs && bs.plan === "active" ? `<button class="btn" data-act="billing-portal">Manage subscription</button>` : `<button class="btn accent" data-act="billing-checkout">Subscribe · $3/month</button>`}</div>` : ""}
    <div class="actions">${S.confirmReset ? `<span class="small">Delete every client and setting?</span><button class="btn danger" data-act="reset-yes">Delete everything</button><button class="btn" data-act="reset-no">Keep</button>` : `<button class="btn danger" data-act="reset">Delete my data</button>`}</div>
  </section></div>`;
}

/* ---------- reconcile ---------- */
function recPeriod(){
  const R = S.rec || (S.rec = {mode:"month", at:new Date(), open:{}});
  if (R.mode === "week"){ const a = sow(R.at); return {a, b:addDays(a,7), label:`${fmtD(a)} – ${fmtD(addDays(a,6))}`}; }
  const a = new Date(R.at.getFullYear(), R.at.getMonth(), 1); return {a, b:new Date(a.getFullYear(), a.getMonth()+1, 1), label:a.toLocaleDateString(undefined,{month:"long", year:"numeric"})};
}
function recData(M, period){
  const {a, b} = period || recPeriod(), now = M.now;
  const cals = (P("calendars")||[]).filter(c => c.use);
  const calName = id => (cals.find(c => c.id === id)||{}).name || id;
  const rows = [];
  for (const c of S.clients){
    const st = M.stats[c.id];
    const inP = s => s.date >= a && s.date < b;
    const done = st.past.filter(inP), booked = st.future.filter(inP), skipped = (st.skipped||[]).filter(inP);
    if (!done.length && !booked.length && !skipped.length) continue;
    const byCal = {}; for (const s of done) byCal[s.cal] = (byCal[s.cal]||0) + 1;
    const bookedByCal = {}; for (const s of booked) bookedByCal[s.cal] = (bookedByCal[s.cal]||0) + 1;
    const earned = done.reduce((x,s)=>x+s.value,0), rent = done.reduce((x,s)=>x+s.rent,0);
    rows.push({c, st, done, booked, skipped, byCal, bookedByCal, earned, rent, net:earned-rent});
  }
  rows.sort((x,y) => y.done.length - x.done.length || x.c.name.localeCompare(y.c.name));
  const tot = {done:0, booked:0, skipped:0, earned:0, rent:0, net:0, byCal:{}, bookedByCal:{}, rentByCal:{}};
  for (const r of rows){ tot.done += r.done.length; tot.booked += r.booked.length; tot.skipped += r.skipped.length; tot.earned += r.earned; tot.rent += r.rent; tot.net += r.net;
    for (const s of r.done){ tot.byCal[s.cal] = (tot.byCal[s.cal]||0)+1; tot.rentByCal[s.cal] = (tot.rentByCal[s.cal]||0) + s.rent; }
    for (const k in r.bookedByCal) tot.bookedByCal[k] = (tot.bookedByCal[k]||0) + r.bookedByCal[k]; }
  const calIds = [...new Set([...cals.map(c => c.id), ...Object.keys(tot.byCal), ...Object.keys(tot.bookedByCal)])].filter(id => tot.byCal[id] || tot.bookedByCal[id] || cals.some(c => c.id === id));
  return {rows, tot, calIds, calName, cals, now};
}
/* Weekly reconcile: completed weeks with sessions that haven't been marked off (or changed since). Not mandatory. */
function recTodos(M){
  if (!M || (S.prof && S.prof.reconcileReminders === false)) return [];
  const done = P("reconciled") || {}, hs = parseDay(P("historyStart")), out = [];
  for (let k = 1; k <= 6; k++){
    const a = addDays(sow(M.now), -7*k), b = addDays(a, 7); if (b <= hs) break;
    const D = recData(M, {a, b}); if (!D.tot.done) continue;
    const key = ymd(a), r = done[key];
    if (r && r.n === D.tot.done) continue;
    out.push({key, a, b, n:D.tot.done, net:D.tot.net, state: r ? "changed" : "open", was: r && r.n, at: r && r.at});
  }
  return out;
}
const weekLabel = a => `${fmtD(a)} – ${fmtD(addDays(a,6))}`;
function renderReconcile(M){
  const R = S.rec || (S.rec = {mode:"month", at:new Date(), open:{}});
  const {label, a, b} = recPeriod(), D = recData(M), isNow = M.now >= a && M.now < b, future = a > M.now;
  const short = n => String(n).replace(/@.*$/, "").slice(0, 22);
  const weekMode = R.mode === "week", prevP = weekMode ? {a:addDays(a,-7), b:a} : null;
  const prevD = prevP ? recData(M, prevP) : null, prevN = id => { const r = prevD && prevD.rows.find(x => x.c.id === id); return r ? r.done.length : 0; };
  const rec = weekMode ? (P("reconciled")||{})[ymd(a)] : null, over = b <= M.now;
  const delta = (n, p) => { const d = n - p; return d ? `<span class="small ${d>0?"pos":"neg"}"> ${d>0?"+":""}${d}</span>` : ""; };
  const banner = !weekMode ? "" : !over ? `<div class="banner"><span>This week isn't over yet. Come back after Sunday to mark it reconciled.</span></div>`
    : !rec ? `<div class="banner"><span>Review the sessions below, compare with last week, then mark this week off.</span><button class="btn sm primary" data-act="rec-mark" data-week="${ymd(a)}">Mark week reconciled</button></div>`
    : rec.n !== D.tot.done ? `<div class="banner err"><span>Changed since you reconciled on ${esc(fmtD(new Date(rec.at)))}: was ${rec.n} session${rec.n===1?"":"s"}, now ${D.tot.done}.</span><button class="btn sm primary" data-act="rec-mark" data-week="${ymd(a)}">Mark reconciled again</button></div>`
    : `<div class="banner"><span>✓ Reconciled on ${esc(fmtD(new Date(rec.at)))} · ${rec.n} sessions · ${money(rec.net)} net</span><button class="btn sm ghost" data-act="rec-unmark" data-week="${ymd(a)}">Undo</button></div>`;
  const calCell = (r, id) => { const n = r.byCal[id]||0, bk = r.bookedByCal[id]||0; return `${n||"–"}${bk?`<span class="muted"> +${bk}</span>`:""}`; };
  const studio = id => (D.cals.find(c => c.id === id)||{}).studio;
  const tiles = D.calIds.map(id => `<div class="stat"><span class="k">${esc(short(D.calName(id)))}${studio(id)?' <span class="tag">studio</span>':""}</span><span class="v">${D.tot.byCal[id]||0}${D.tot.bookedByCal[id]?`<span class="muted" style="font-size:14px;font-weight:600"> +${D.tot.bookedByCal[id]}</span>`:""}</span><span class="d">${D.tot.rentByCal[id] ? money(D.tot.rentByCal[id]) + " rent" : "no rent"}</span></div>`).join("");
  const gone = weekMode ? prevD.rows.filter(p => !D.rows.some(r => r.c.id === p.c.id)) : [];
  const body = D.rows.map(r => { const open = R.open[r.c.id];
    const detail = open ? `<tr class="wkdetail"><td colspan="${D.calIds.length + 5 + (weekMode?1:0)}"><div class="list">${[...r.done.map(s=>[s,"done"]), ...r.booked.map(s=>[s,"booked"]), ...r.skipped.map(s=>[s,"skipped"])].sort((x,y)=>x[0].date-y[0].date).map(([s,k]) => `<div><span>${esc(s.date.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"}))} · ${esc(fmtT(s.date))} <span class="tag">${esc(short(s.calName||D.calName(s.cal)))}</span>${k!=="done"?` <span class="chip ${k==="booked"?"info":"low"}">${k==="booked"?"Booked":"Not counted"}</span>`:""}${k==="skipped"?` <span class="small muted">“${esc(s.title)}”</span>`:""}</span><span class="small">${k==="done"?money(s.value)+(s.rent?` · ${money(s.rent)} rent`:""):""}</span></div>`).join("")}</div></td></tr>` : "";
    return `<tr class="wkrow${open?" open":""}" data-act="rec-open" data-id="${r.c.id}" tabindex="0" role="button" aria-expanded="${!!open}"><td><div class="who"><span class="caret" aria-hidden="true">${open?"▾":"▸"}</span>${avatar(r.c)}<div style="min-width:0"><span class="n">${esc(r.c.name)}</span><div class="s">${BILLING[r.st.bill].label}${r.c.noRent?" · no rent":""}${payLine(r.c)}</div></div></div></td>
      ${D.calIds.map(id => `<td class="num">${calCell(r,id)}</td>`).join("")}
      <td class="num" style="font-weight:700">${r.done.length}${r.booked.length?`<span class="muted" style="font-weight:500"> +${r.booked.length}</span>`:""}</td>
      ${weekMode ? `<td class="num muted">${prevN(r.c.id)}${delta(r.done.length, prevN(r.c.id))}</td>` : ""}
      <td class="num">${money(r.earned)}</td><td class="num">${r.rent?money(r.rent):"–"}</td><td class="num" style="font-weight:600">${money(r.net)}</td></tr>${detail}`; }).join("");
  return `<section class="card"><div class="card-h">
      <div class="seg" role="group" aria-label="Period">${[["week","Week"],["month","Month"]].map(([k,l]) => `<button data-act="rec-mode" data-k="${k}" aria-pressed="${R.mode===k}">${l}</button>`).join("")}</div>
      <div class="monthsw"><button data-act="rec-prev" aria-label="Previous">${ic("left")}</button><span>${esc(label)}</span><button data-act="rec-next" aria-label="Next">${ic("right")}</button></div>
      <div class="actions">${!isNow?`<button class="btn sm" data-act="rec-today">This ${R.mode}</button>`:""}<button class="btn sm" data-act="rec-csv">Export CSV</button></div></div>
    ${banner}
    ${isNow ? `<p class="small muted">Done so far, plus <span class="muted">+booked</span> for the rest of the ${R.mode}.</p>` : future ? `<p class="small muted">Everything here is still booked.</p>` : ""}
  </section>
  <div class="stats">
    <div class="stat"><span class="k">Sessions done</span><span class="v">${D.tot.done}${D.tot.booked?`<span class="muted" style="font-size:14px;font-weight:600"> +${D.tot.booked}</span>`:""}</span><span class="d">${D.rows.length} client${D.rows.length===1?"":"s"}${D.tot.skipped?` · ${D.tot.skipped} not counted`:""}</span></div>
    ${tiles}
    <div class="stat"><span class="k">Net to you</span><span class="v">${money(D.tot.net)}</span><span class="d">${money(D.tot.earned)} earned · ${money(D.tot.rent)} rent</span></div>
  </div>
  <section class="card"><div class="card-h"><h2>By client</h2><span class="small muted">tap a client for dates</span></div>
    ${D.rows.length ? `<div class="tablewrap"><table class="weeks"><thead><tr><th>Client</th>${D.calIds.map(id => `<th class="num">${esc(short(D.calName(id)))}</th>`).join("")}<th class="num">Total</th>${weekMode?'<th class="num">Last wk</th>':""}<th class="num">Earned</th><th class="num">Rent</th><th class="num">Net</th></tr></thead><tbody>${body}
      <tr class="total"><td style="font-weight:700">Total</td>${D.calIds.map(id => `<td class="num" style="font-weight:700">${D.tot.byCal[id]||0}${D.tot.bookedByCal[id]?`<span class="muted" style="font-weight:500"> +${D.tot.bookedByCal[id]}</span>`:""}</td>`).join("")}<td class="num" style="font-weight:700">${D.tot.done}${D.tot.booked?`<span class="muted" style="font-weight:500"> +${D.tot.booked}</span>`:""}</td>${weekMode?`<td class="num muted">${prevD.tot.done}${delta(D.tot.done, prevD.tot.done)}</td>`:""}<td class="num">${money(D.tot.earned)}</td><td class="num">${money(D.tot.rent)}</td><td class="num" style="font-weight:700">${money(D.tot.net)}</td></tr>
    </tbody></table></div>` : `<div class="empty">No sessions in this ${R.mode}.</div>`}
    ${gone.length ? `<p class="small">Trained last week but not this week: ${gone.map(g => `<b>${esc(g.c.name)}</b> (${g.done.length})`).join(", ")}</p>` : ""}
    <p class="small muted">"Not counted" are calendar events with words like cancel, free or comp in the title. They show in a client's dates but aren't billed or charged rent.</p>
  </section>`;
}
function exportReconcile(){
  const D = recData(S.M), {label, a} = recPeriod(), R = S.rec;
  const rows = [["client", ...D.calIds.map(id => D.calName(id) + " (done)"), "done", "booked", "not counted", "earned", "rent", "net"]];
  for (const r of D.rows) rows.push([r.c.name, ...D.calIds.map(id => r.byCal[id]||0), r.done.length, r.booked.length, r.skipped.length, Math.round(r.earned*100)/100, Math.round(r.rent*100)/100, Math.round(r.net*100)/100]);
  rows.push(["Total", ...D.calIds.map(id => D.tot.byCal[id]||0), D.tot.done, D.tot.booked, D.tot.skipped, Math.round(D.tot.earned*100)/100, Math.round(D.tot.rent*100)/100, Math.round(D.tot.net*100)/100]);
  offerFile(`reconcile-${R.mode}-${ymd(a)}.csv`, csv(rows));
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

/* ---------- walkthrough ---------- */
const TOUR = [
  {tab:"overview", sel:"hero", title:"Your month at a glance", body:"Net is what you keep after studio rent. The dashed line projects where the month will land, using what's booked plus each client's usual pace."},
  {tab:"overview", sel:"attention", title:"Needs attention", body:"Renewals coming due, unpaid packages and open bills show up here. Each has a ready-made message and a one-tap way to record the payment."},
  {tab:"clients", sel:"found", title:"Clients come from your calendar", body:"Names that repeat on your calendar land here. Add as client, merge a nickname into an existing client with Same as, or hide it with Not a client."},
  {tab:"clients", sel:"clients", title:"Set how each client pays", body:"Tap a name to set their rate and plan: package, monthly bill, membership or pay as you go. For packages, Set package tells the tally where they stand today."},
  {tab:"calendar", sel:"cal", title:"Every session, by day", body:"Each dot is a session. Tap a day to see who, when, and what you netted. Events with words like cancel or free are skipped automatically."},
  {tab:"billing", sel:"bills", title:"Bills and payments", body:"Monthly-bill and membership clients get a bill each month. Send it as a text or email, then log the payment when it arrives. If your studio uses Trainer Tally, you confirm its rent statement here each month."},
  {tab:"trends", view:"income", sel:"trend", title:"Trends and projections", body:"Income by month after rent, plus the next few months at your current pace. Switch to Sessions to see volume instead of dollars."},
  {tab:"trends", view:"clients", sel:"health", title:"Who's growing, who's slipping", body:"Each client's last 4 weeks against the 12 before. \"Gone quiet\" means two weeks with nothing booked, a good time to reach out."},
  {tab:"trends", view:"pricing", sel:"sim", title:"Try a rate increase", body:"See what raising your rate would add per month and per year, for everyone or just the clients you pick, even if a few leave."},
  {tab:"settings", sel:"notices", title:"Automatic messages", body:"A summary of your week every Saturday night and a month-end reconciliation 2 days before the month closes. Renewal reminders can be drafted for your OK or sent for you."},
  {tab:"settings", sel:"taxset", title:"Tax set-aside", body:"Turn this on to see how much of each month's profit to put aside, and what your quarterly estimated payments might be."},
  {tab:"settings", sel:"backup", title:"Your data is yours", body:"Download a backup or spreadsheet any time. Change your calendars, rent, no-rent words or message wording here. Open any client to make them a private sessions-left page. You can replay this walkthrough here."}
];
function tourEnd(){ S.tour = null; document.querySelectorAll(".tour-focus").forEach(el => el.classList.remove("tour-focus")); const c = $("#tourcard"); if (c) c.remove(); if (!(S.prof && S.prof.tourDone)) saveProfile({tourDone:true}).catch(()=>{}); }
function tourGo(i){ if (i < 0) i = 0; if (i >= TOUR.length){ tourEnd(); S.tab = "overview"; render(); return; } S.tour = i; S.tab = TOUR[i].tab; if (TOUR[i].view) S.trendView = TOUR[i].view; render(); window.scrollTo({top:0}); }
function renderTour(){
  document.querySelectorAll(".tour-focus").forEach(el => el.classList.remove("tour-focus"));
  let card = $("#tourcard");
  if (S.tour == null || !inAppNow()){ if (card) card.remove(); return; }
  const st = TOUR[S.tour];
  const el = document.querySelector(`[data-tour="${st.sel}"]`);
  if (el){ el.classList.add("tour-focus"); try { el.scrollIntoView({block:"center", behavior:"smooth"}); } catch(e){ el.scrollIntoView(); } }
  if (!card){ card = document.createElement("div"); card.id = "tourcard"; card.className = "tourcard"; card.setAttribute("role","dialog"); card.setAttribute("aria-live","polite"); document.body.appendChild(card); }
  const last = S.tour === TOUR.length - 1;
  card.innerHTML = `<div class="tour-top"><span class="small muted">${S.tour+1} of ${TOUR.length}</span><button class="btn sm ghost" data-act="tour-skip">Skip</button></div>
    <h2>${esc(st.title)}</h2><p>${esc(st.body)}</p>
    <div class="tour-dots">${TOUR.map((_,i)=>`<i class="${i===S.tour?"on":""}"></i>`).join("")}</div>
    <div class="actions">${S.tour>0?`<button class="btn" data-act="tour-back">Back</button>`:""}<button class="btn primary" data-act="tour-next">${last?"Done":"Next"}</button></div>`;
}

/* ---------- modals ---------- */
function openModal(m){ S.modal = m; renderModal(); }
function closeModal(){ S.modal = null; $("#modal").innerHTML = ""; }
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
      ${(() => { const deps = m.id ? dependentsOf(c) : []; const cur = c.paidBy || "";
        if (deps.length) return `<div class="field full"><label>Paid for by</label><input value="${esc(firstName(c.name))} pays for ${esc(deps.map(x=>x.name).join(", "))}" disabled><span class="hint">A client who pays for someone else can't also be paid for.</span></div>`;
        const opts = S.clients.filter(x => x.id !== m.id && !x.paidBy).sort((a,b)=>a.name.localeCompare(b.name));
        return `<div class="field full"><label for="ed-paidby">Paid for by</label><select id="ed-paidby"><option value="">Themselves</option>${opts.map(x=>`<option value="${esc(x.id)}" ${x.id===cur?"selected":""}>${esc(x.name)}${x.active===false?" (inactive)":""}</option>`).join("")}</select><span class="hint">If another client pays, bills and renewal messages go to them and show on their messages too.</span></div>`; })()}
      <div class="field"><label for="ed-email">Email</label><input id="ed-email" type="email" value="${esc(c.email||"")}"></div>
      <div class="field"><label for="ed-phone">Phone</label><input id="ed-phone" type="tel" value="${esc(c.phone||"")}"></div>
      <label class="check full"><input type="checkbox" id="ed-norent" ${c.noRent?"checked":""}> No studio rent for this client</label>
      <div class="field full"><label for="ed-nrn">No rent when the event is named</label><input id="ed-nrn" value="${esc((c.noRentNames||[]).join(", "))}" placeholder="e.g. a partner billed to this client"><span class="hint">Optional. Comma separated calendar names.</span></div>
      <label class="check full" data-bill-show="package"><input type="checkbox" id="ed-noauto" ${c.noAutoNotice?"checked":""}> Don't send automatic renewal emails</label>
      <label class="check full"><input type="checkbox" id="ed-active" ${c.active!==false?"checked":""}> Active</label>
    </div>
    ${m.id && A.links ? clientLinkBlock(c) : ""}
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
    const c0 = client(m.id), bt = E.billTo(S.M, c0);
    const c = {...c0, phone:bt.phone, email:bt.email};
    title = "Message · " + (bt.payer ? `${bt.payer.name} (for ${c0.name})` : c0.name);
    if (m.text == null) m.text = messageText(c0, m.kind, m.month);
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
  } else if (m.type === "dispute"){
    const ms = S.studios.find(x => x.studioId === m.sid), sm = ms.trainer.statement.months.find(x => x.month === m.month), mine = E.studioCount(S.M, m.month);
    title = `Dispute ${mLabel(m.month, true)} · ${ms.studioName}`;
    body = `<p class="small muted">The studio counted ${sm.n} session${sm.n===1?"":"s"} (${money(sm.rent)} rent). Your calendar shows ${mine.n}. Tell them what's off, like a date that was cancelled or a session at a client's home.</p>
      <div class="form"><div class="field"><label for="so-n">Your count</label><input id="so-n" type="number" min="0" value="${esc(m.prev && m.prev.trainer_n != null ? m.prev.trainer_n : mine.n)}"></div>
      <div class="field full"><label for="so-note">Note to the studio</label><textarea id="so-note" placeholder="e.g. Sep 14 was cancelled; Sep 22 was at a client's home">${esc(m.prev && m.prev.note || "")}</textarea></div></div>
      <div class="actions"><button class="btn primary" data-act="so-send">Send dispute</button></div>`;
  } else if (m.type === "outbox"){
    const r = m.row;
    title = r.subject;
    body = `<p class="small muted">To ${esc(r.to_email||"–")} · ${esc(new Date(r.created_at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}))} · <span class="chip ${OB[r.status][1]}">${OB[r.status][0]}</span>${r.error ? " · " + esc(r.error) : ""}</p>
      <pre class="mailtext">${esc(r.body_text)}</pre>
      ${r.status==="held"||r.status==="failed" ? `<div class="actions"><button class="btn primary" data-act="ob-send" data-oid="${esc(r.id)}">Send</button><button class="btn ghost" data-act="ob-skip" data-oid="${esc(r.id)}">Skip</button></div>` : ""}`;
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
  if (tabBtn){ e.preventDefault(); if (S.tour != null) tourEnd(); S.tab = tabBtn.getAttribute("data-tab"); S.confirmReset = false; closeModal(); render(); window.scrollTo({top:0}); return; }
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.getAttribute("data-act"), id = el.getAttribute("data-id");
  if (act === "close-scrim" && e.target !== el) return;
  if (act.startsWith("pg-") && PROGS()){ if (el.tagName === "A") e.preventDefault(); PROGS().onClick(el, e); return; }
  if (el.tagName === "A" && el.getAttribute("href") === "#") e.preventDefault();
  const M = S.M;
  switch (act){
    case "close": case "close-scrim": closeModal(); break;
    case "studio-join": { const c = val("st-join").trim(); if (!c){ toast("Enter your studio's code"); break; } joinStudio(c); break; }
    case "studio-leave": { const sid = el.getAttribute("data-sid"); try { await A.studio.leave(sid); toast("You left the studio"); } catch(err){ toast("Couldn't leave. Try again."); } refreshStudios(); break; }
    case "tour-next": tourGo((S.tour||0) + 1); break;
    case "tour-back": tourGo((S.tour||0) - 1); break;
    case "tour-skip": tourEnd(); break;
    case "tour-start": S.tourSeen = true; tourGo(0); break;
    case "theme": setTheme(el.getAttribute("data-mode")); break;
    case "signin": if (A.signIn){ el.disabled = true; el.textContent = "Opening Google…"; A.signIn(); } break;
    case "grant-calendar": if (A.grantCalendar){ el.disabled = true; el.textContent = "Opening Google…"; A.grantCalendar(); } break;
    case "signout": if (A.signOut) A.signOut(); break;
    case "refresh": loadCalendar(true); break;
    case "cal-list": S.calList = null; S.calListErr = null; render(); break;
    case "mprev": S.month = mPrev(S.month); render(); break;
    case "mnext": if (S.month < M.curM) S.month = mNext(S.month); render(); break;
    case "day": S.day = el.getAttribute("data-day"); render(); break;
    case "trend-mode": S.trendMode = el.getAttribute("data-mode"); render(); break;
    case "reload": location.reload(); break;
    case "goto-billing": S.tab = "billing"; render(); break;
    case "so-confirm": { const sid = el.getAttribute("data-sid"), mk = el.getAttribute("data-m"); el.disabled = true; await signOff(sid, mk, "confirmed", "", E.studioCount(M, mk).n); break; }
    case "so-dispute": { const sid = el.getAttribute("data-sid"), mk = el.getAttribute("data-m"); const ms = S.studios.find(x => x.studioId === sid); openModal({type:"dispute", sid, month:mk, prev: ms && signoffFor(ms, mk)}); break; }
    case "so-send": { const m = S.modal; const note = val("so-note").trim(); if (!note){ toast("Add a note so the studio knows what to check"); break; } closeModal(); await signOff(m.sid, m.month, "disputed", note, Math.round(num(val("so-n")))); break; }
    case "trend-view": S.trendView = el.getAttribute("data-view"); render(); break;
    case "rec-mode": S.rec.mode = el.getAttribute("data-k"); render(); break;
    case "rec-prev": case "rec-next": { const d = act === "rec-next" ? 1 : -1; S.rec.at = S.rec.mode === "week" ? addDays(sow(S.rec.at), 7*d) : new Date(S.rec.at.getFullYear(), S.rec.at.getMonth()+d, 1); render(); break; }
    case "rec-today": S.rec.at = new Date(); render(); break;
    case "rec-mark": { const k = el.getAttribute("data-week"), a = parseDay(k), D = recData(M, {a, b:addDays(a,7)}); saveProfile({reconciled:{...(P("reconciled")||{}), [k]:{at:new Date().toISOString(), n:D.tot.done, net:Math.round(D.tot.net)}}}).then(()=>toast("Week reconciled")).catch(()=>{}); break; }
    case "rec-unmark": { const k = el.getAttribute("data-week"), cur = {...(P("reconciled")||{})}; delete cur[k]; saveProfile({reconciled:cur}).catch(()=>{}); break; }
    case "rec-go": S.tab = "reconcile"; S.rec = {...(S.rec||{open:{}}), mode:"week", at:parseDay(el.getAttribute("data-week")), open:(S.rec&&S.rec.open)||{}}; render(); window.scrollTo({top:0}); break;
    case "goto-programs": S.tab = "programs"; if (PROGS()) PROGS().state.clientId = null; render(); window.scrollTo({top:0}); break;
    case "rec-open": { const id = el.getAttribute("data-id"); S.rec.open[id] = !S.rec.open[id]; render(); break; }
    case "rec-csv": exportReconcile(); break;
    case "week-open": { const w = el.getAttribute("data-week"); S.weekOpen = S.weekOpen === w ? null : w; render(); break; }
    case "goto-settings": { S.tab = "settings"; render(); const a = document.getElementById(el.getAttribute("data-anchor")); if (a) a.scrollIntoView({block:"start"}); break; }
    case "save-notices": saveProfile({notices:{renewals:val("nt-renew"), weekly:chk("nt-weekly"), monthly:chk("nt-monthly"), email:val("nt-email").trim()}}).then(()=>toast("Saved")).catch(()=>{}); break;
    case "save-tax": { const sa = val("tx-set"); saveProfile({tax:{enabled:chk("tx-on"), federal:num(val("tx-fed")), state:num(val("tx-state")), se:chk("tx-se"), setAside: sa === "" ? null : num(sa), expensesMonthly:num(val("tx-exp"))}}).then(()=>toast("Saved")).catch(()=>{}); break; }
    case "notice-test": { el.disabled = true; const k = el.getAttribute("data-kind");
      try { const r = await A.outbox.test(k); toast(r.status === "sent" ? "Preview sent to your email" : "Preview saved below (email isn't switched on yet)"); } catch(err){ toast(err.message || "Couldn't build the preview"); }
      await refreshOutbox(); break; }
    case "ob-view": { const r = (S.outbox||[]).find(x => x.id === el.getAttribute("data-oid")); if (r) openModal({type:"outbox", row:r}); break; }
    case "ob-send": { el.disabled = true; try { const r = await A.outbox.send(el.getAttribute("data-oid")); toast(r.status === "sent" ? "Sent" : r.status === "queued" ? "Approved. It'll go out once email is switched on." : "Couldn't send"); } catch(err){ toast(err.message || "Couldn't send"); } if (S.modal && S.modal.type === "outbox") closeModal(); await refreshOutbox(); break; }
    case "ob-skip": { try { await A.outbox.skip(el.getAttribute("data-oid")); } catch(err){} if (S.modal && S.modal.type === "outbox") closeModal(); await refreshOutbox(); break; }
    case "link-make": { const cid = el.getAttribute("data-cid"); el.disabled = true; try { S.links[cid] = await A.links.create(cid); } catch(err){ toast(err.message || "Couldn't create the link"); } renderModal(); break; }
    case "link-off": { const cid = el.getAttribute("data-cid"); try { await A.links.revoke(cid); S.links[cid] = false; toast("Link turned off"); } catch(err){ toast("Couldn't turn it off"); } renderModal(); break; }
    case "link-copy": { const t = document.getElementById("cl-link"); try { await navigator.clipboard.writeText(t.value); toast("Link copied"); } catch(x){ t.select(); } break; }
    case "wiz-back": readWizStep(); S.wiz.step--; render(); break;
    case "wiz-cancel": S.wiz = null; S.rerunning = false; S.prof = {...S.prof, setupDone:true}; render(); break;
    case "rerun": S.wiz = wizDefaults(); S.calList = null; S.rerunning = true; S.prof = {...S.prof, setupDone:false}; render(); break;
    case "wiz-next": {
      readWizStep(); const w = S.wiz;
      if (w.step < 3){ w.step++; render(); break; }
      const patch = {setupDone:true, trainerName:w.name, calendars:w.cals.filter(c=>c.use).map(c=>({id:c.id, name:c.name, use:true, studio:!!c.studio, mineOnly:!!c.mineOnly})), rent:w.rent, defaults:w.defaults, threshold:w.threshold, historyStart:w.historyStart, myEmail:S.detectedEmail || P("myEmail") || ""};
      S.wiz = null; S.rerunning = false; S.tab = S.clients.length ? "overview" : "clients";
      try { await saveProfile(patch); } catch(err){ S.prof = {...S.prof, ...patch}; }
      loadCalendar("full"); break;
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
        email: val("ed-email").trim(), phone: val("ed-phone").trim(), noRent: chk("ed-norent"), noRentNames: val("ed-nrn").split(",").map(s=>s.trim()).filter(Boolean), noAutoNotice: chk("ed-noauto"), active: chk("ed-active"),
        paidBy: document.getElementById("ed-paidby") ? (val("ed-paidby") || null) : (old.paidBy || null),
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
    case "save-settings": { const ex = val("st-extra").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean); const exChanged = ex.join() !== (P("extraCreators")||[]).join(); saveProfile({extraCreators:ex, noRentWords:val("st-norent").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean), renewalTemplate:val("st-renew"), invoiceTemplate:val("st-inv"), ignoreWords:val("st-ign").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean), threshold:Math.max(0, Math.round(num(val("st-th"),3)))}).then(()=>{ toast("Settings saved"); if (exChanged) loadCalendar("full"); }).catch(()=>{}); break; }
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
  if (t.getAttribute && t.getAttribute("data-act") === "feat"){
    const k = t.getAttribute("data-k");
    saveProfile(k === "programs" ? {programsOff: !t.checked} : {reconcileReminders: t.checked}).then(() => { if (k === "programs" && t.checked && PROGS()) PROGS().preload(); toast("Saved"); }).catch(()=>{});
    return;
  }
  if (PROGS() && t.getAttribute && t.getAttribute("data-pg") && PROGS().onChange(t)) return;
  if (t.id === "sim-inc" || t.id === "sim-mode" || t.id === "sim-lose" || (t.hasAttribute && t.hasAttribute("data-sim-id"))){
    const ids = [...document.querySelectorAll("[data-sim-id]")].filter(x => x.checked).map(x => x.getAttribute("data-sim-id"));
    S.sim = {increase: num(val("sim-inc")), mode: val("sim-mode"), lose: Math.max(0, Math.round(num(val("sim-lose")))), ids};
    render(); return;
  }
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
function onInput(e){ if (PROGS() && e.target.getAttribute && e.target.getAttribute("data-pg") && PROGS().onInput(e.target)) return; if (e.target.id === "msg-text" && S.modal) S.modal.text = e.target.value; }

/* ---------- boot ---------- */
async function start(adapter){
  A = adapter;
  if (A.programs && window.TallyPrograms) window.TallyPrograms.attach({ S, A, avatar, toast, render, closeModal, saveClient, saveProfile, getModel: () => S.M, modelLoading: () => S.cal.state === "loading" });
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches('tr[role="button"][data-act]')){ e.preventDefault(); e.target.click(); return; } if (e.key === "Escape"){ if (S.modal) closeModal(); else if (S.tour != null) tourEnd(); } });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => S.M && drawCharts(S.M), 150); });
  try { const j = new URLSearchParams(location.search).get("join"); if (j){ localStorage.setItem("tt-join", j); history.replaceState(null, "", location.pathname); } } catch(e){}
  renderChrome();
  let info;
  try { info = await A.init(); } catch(e){ info = {status:"nostore"}; }
  S.account = info.account || null;
  if (info.status === "signin"){ S.signinError = info.error || null; S.screen = "signin"; render(); return; }
  if (info.status !== "ready"){ S.screen = "nostore"; render(); return; }
  S.screen = "data";
  try { const j = new URLSearchParams(location.search).get("join"); if (j){ localStorage.setItem("tt-join", j); history.replaceState(null, "", location.pathname); } } catch(e){}
  try { const q = new URLSearchParams(location.search).get("billing"); if (q){ toast(q === "success" ? "You're subscribed. Thank you!" : "Checkout cancelled"); history.replaceState(null, "", location.pathname); if (q === "success") S.tab = "settings"; } } catch(e){}
  if (A.studio){ refreshStudios(); let pending = null; try { pending = localStorage.getItem("tt-join"); } catch(e){} if (pending) joinStudio(pending); }
  if (A.billing) A.billing.status().then(s => { S.billingStatus = s; if (S.tab === "settings") render(); }).catch(()=>{});
  let started = false;
  const maybeStart = () => { if (!started && S.profLoaded && S.clientsLoaded && S.prof && S.prof.setupDone){ started = true; loadCalendar(false); saveTimeZone(); if (PROGS()) PROGS().preload(); } };
  A.watchProfile(p => {
    if (S.rerunning) return;
    S.prof = p; S.profLoaded = true;
    render(); maybeStart();
  }, err => { S.loadError = err || new Error("load failed"); S.profLoaded = true; render(); });
  A.watchClients(list => {
    S.clients = list; S.clientsLoaded = true;
    if (S.modal && S.modal.id && ["edit","setup-pkg","add-pkg","msg"].includes(S.modal.type) && !client(S.modal.id)) closeModal();
    render(); maybeStart();
  }, err => { S.loadError = err || new Error("load failed"); S.clientsLoaded = true; render(); });
}
window.TrainerTally = {start, version:"2.0"};
})();
