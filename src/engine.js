/* Trainer Tally · calculation engine.
 * Pure functions shared by the browser app and the server (reminders, weekly/monthly emails,
 * client "sessions left" pages). No DOM. Every entry point takes the data it needs.
 *
 *   const M = compute({profile, clients, events, now})   // events from normalizeEvents()
 *   monthTotals(M, "2026-09"), projectMonth(M, k), attention(M), messageText(M, client, kind)
 *   clientHealth(M), retention(M), taxEstimate(M, opts), simulateRate(M, opts)
 *   weeklySummary(M), monthlySummary(M)                  // {subject, text, html}
 */
export const DAY = 86400000;
export const YEAR0 = new Date().getFullYear() + "-01-01";
export const DEFAULTS = {
  trainerName: "", myEmail: "", calendars: [], historyStart: YEAR0,
  ignoreWords: ["cancel","cancelled","canceled","free","comp","rescheduled","tentative","hold"],
  ignoredTitles: [], threshold: 3,
  rent: {mode:"none", perSession:20, monthly:660, percent:30, appliesTo:"studio"},
  defaults: {billing:"package", rate:100, packageSize:10},
  renewalTemplate: "Hi {first}! Quick heads-up: you have {left} session{s} left in your package. Your next {size}-session package is ${price}. Thanks! - {me}",
  invoiceTemplate: "Hi {first}! Your total for {month} is ${amount} ({details}). Thanks! - {me}",
  notices: {renewals:"ask", weekly:true, monthly:true, email:""},
  noRentWords: ["home","online","remote","zoom","virtual","outdoor","offsite"],
  tax: {enabled:false, federal:12, state:5, se:true, setAside:null, expensesMonthly:0}
};
export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const LEAD = new Set(["pt","session","sesh","training","personal","train","with","w","appt","appointment"]);
const TRAIL = new Set(["pt","session","sesh","training","appt"]);

let CTX = {profile:{}, clients:[], events:[]};
export const num = (v, d=0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
export const money = v => (v < -0.5 ? "-$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");
export const pad = n => String(n).padStart(2,"0");
export const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
export const mkey = d => d.getFullYear()+"-"+pad(d.getMonth()+1);
export const parseDay = s => { const [y,m,d] = String(s||"").slice(0,10).split("-").map(Number); return new Date(y||2000, (m||1)-1, d||1); };
export const mStart = k => { const [y,m] = k.split("-").map(Number); return new Date(y, m-1, 1); };
export const mNext = k => { const d = mStart(k); return mkey(new Date(d.getFullYear(), d.getMonth()+1, 1)); };
export const mPrev = k => { const d = mStart(k); return mkey(new Date(d.getFullYear(), d.getMonth()-1, 1)); };
export const mLabel = (k, long) => { const d = mStart(k); return (long ? d.toLocaleDateString("en-US",{month:"long"}) : MONTHS[d.getMonth()]) + " " + d.getFullYear(); };
export const sow = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; };
export const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
export const norm = s => (s||"").toLowerCase().replace(/[’']/g,"").replace(/[^a-z0-9+&\s]/g," ").replace(/\s+/g," ").trim();
export function clean(s){
  const w = norm(s).split(" ").filter(Boolean);
  while (w.length > 1 && LEAD.has(w[0])) w.shift();
  while (w.length > 1 && TRAIL.has(w[w.length-1])) w.pop();
  return w.join(" ");
}
export const firstName = n => String(n||"").trim().split(/[\s+&]/)[0] || "there";
const P = k => (CTX.profile && CTX.profile[k] !== undefined && CTX.profile[k] !== null) ? CTX.profile[k] : DEFAULTS[k];
const rentCfg = () => ({...DEFAULTS.rent, ...(P("rent")||{})});
const defs = () => ({...DEFAULTS.defaults, ...(P("defaults")||{})});

/* Google Calendar events (each tagged with its calendar settings) -> session-ready events. */
/* On shared ("mine only") calendars, keep only events the trainer (or a helper listed in extraCreators) made. */
export function keepEvent(e, cal, profile){
  if (!e || e.status === "cancelled" || !e.start || !e.start.dateTime) return false;
  if (!cal.mineOnly) return true;
  const me = String((profile && profile.myEmail) || "").toLowerCase();
  if (!me) return true;
  const extra = ((profile && profile.extraCreators) || []).map(x => String(x).toLowerCase().trim()).filter(Boolean);
  const creator = ((e.creator||{}).email||"").toLowerCase(), org = ((e.organizer||{}).email||"").toLowerCase();
  return creator === me || org === me || extra.includes(creator);
}
/* The earliest date the trainer's history needs (history start, or an older billing / package start). */
export function historyFrom(profile, clients){
  let start = parseDay((profile && profile.historyStart) || YEAR0);
  for (const c of clients || []){ const d = c.billingStart ? parseDay(c.billingStart) : null; if (d && d < start) start = d;
    for (const p of (c.packages||[])) if (p.start){ const e = new Date(p.start); if (e < start) start = new Date(e.getFullYear(), e.getMonth(), 1); } }
  return start;
}
export function normalizeEvents(rows, profile){
  const seen = new Set(), evs = [];
  for (const [e, cal] of rows){
    if (!e || e.status === "cancelled" || !e.start || !e.start.dateTime) continue;
    const key = cal.id + ":" + e.id; if (seen.has(key)) continue; seen.add(key);
    if (!keepEvent(e, cal, profile)) continue;
    evs.push({id:e.id, title:(e.summary||"").trim(), date:new Date(e.start.dateTime), cal:cal.id, calName:cal.name, studio:!!cal.studio});
  }
  return evs.sort((a,b)=>a.date-b.date);
}

function buildMatcher(){
  const list = [];
  for (const c of CTX.clients) for (const n of [c.name, ...(c.aliases||[])]){ const a = clean(n); if (a) list.push({a, id:c.id}); }
  list.sort((x,y)=>y.a.length-x.a.length);
  return t => { for (const {a,id} of list){ if (t === a) return id; if (t.startsWith(a+" ") && t.slice(a.length+1).split(" ").length <= 2) return id; } return null; };
}
/* Words after the client's name in an event title, e.g. "Sarah home" -> ["home"]. */
function titleExtras(c, s){
  const t = clean(s.title||"");
  const names = [c.name, ...(c.aliases||[])].map(clean).filter(Boolean).sort((a,b) => b.length - a.length);
  for (const n of names) if (t === n || t.startsWith(n + " ")) return t.slice(n.length).trim();
  return t;
}
/* True when the title marks a session away from the studio ("Sarah home", "Mike - online"). */
export function noRentTitle(c, s){
  const extra = " " + titleExtras(c, s) + " ";
  return (P("noRentWords")||[]).map(norm).filter(Boolean).some(w => extra.includes(" " + w + " "));
}
export function rentApplies(c, s){
  const r = rentCfg();
  if (c.noRent) return false;
  if (noRentTitle(c, s)) return false;
  const nr = (c.noRentNames||[]).map(clean).filter(Boolean);
  if (nr.length){ const t = clean(s.title||""); if (nr.some(a => t === a || t.startsWith(a + " "))) return false; }
  return r.appliesTo === "all" || !!s.studio;
}
function sessionRent(s, value, c){
  const r = rentCfg();
  if (!rentApplies(c, s)) return 0;
  if (r.mode === "perSession") return num(r.perSession);
  if (r.mode === "percent") return value * num(r.percent)/100;
  return 0;
}
export function compute({profile, clients, events, now} = {}){
  CTX = {profile: profile || {}, clients: clients || [], events: events || []};
  now = now || new Date(); const curM = mkey(now);
  const match = buildMatcher();
  const ignoreW = (P("ignoreWords")||[]).map(norm).filter(Boolean);
  const ignoredT = new Set((P("ignoredTitles")||[]).map(clean));
  const byClient = {}; CTX.clients.forEach(c => byClient[c.id] = []);
  const unmatched = {};
  for (const e of CTX.events){
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
  for (const c of CTX.clients) stats[c.id] = clientStats(c, byClient[c.id]||[], now, curM);
  const recentCut = now - 120*DAY;
  const um = Object.values(unmatched).filter(u => u.count >= 2 && ((u.last && u.last >= recentCut) || u.next)).sort((a,b)=>b.count-a.count).slice(0,40);
  return {now, curM, stats, unmatched:um, byClient, ctx:CTX};
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
export function monthTotals(M, k){
  CTX = M.ctx;
  let n=0, earned=0, rent=0, collected=0;
  for (const c of CTX.clients){ const m = M.stats[c.id].monthly[k]; if (m){ n += m.n; earned += m.earned; rent += m.rent; collected += m.collected; } }
  const r = rentCfg();
  const hs = mkey(parseDay(P("historyStart")));
  if (r.mode === "monthly" && k >= hs && k <= M.curM) rent += num(r.monthly);
  return {n, earned, rent, net:earned-rent, collected};
}
export function projectMonth(M, k){
  CTX = M.ctx;
  const now = M.now, ms = mStart(k), me = mStart(mNext(k));
  if (me <= now) return {n:0, earned:0, rent:0, net:0};
  const horizon = addDays(now, 63);
  let n=0, earned=0, rent=0;
  const r = rentCfg();
  for (const c of CTX.clients){
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
export function sessionsIn(M, a, b){
  CTX = M.ctx;
  const out = [];
  for (const c of CTX.clients){ const st = M.stats[c.id]; for (const s of [...st.past, ...st.future]) if (s.date >= a && s.date < b) out.push({...s, c}); }
  return out.sort((x,y)=>x.date-y.date);
}


export function attention(M){
  CTX = M.ctx;
  const out = [];
  for (const c of CTX.clients){
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

export function fillTpl(t, vars){ return String(t||"").replace(/\{(\w+)\}/g, (m,k) => vars[k] !== undefined ? vars[k] : m); }
/* "Paid for by": a client can be billed to another client (e.g. a spouse or parent pays). */
export function payerOf(M, c){
  if (!c || !c.paidBy || c.paidBy === c.id) return null;
  const p = (M.ctx.clients || []).find(x => x.id === c.paidBy);
  return p && !p.paidBy ? p : null;
}
export function dependentsOf(M, c){
  return (M.ctx.clients || []).filter(x => x.paidBy === c.id && x.id !== c.id && x.active !== false && M.stats[x.id]);
}
/* Where messages about this client should go: the payer's contact details if someone else pays. */
export function billTo(M, c){ const p = payerOf(M, c); return p ? {name:p.name, email:p.email || c.email || "", phone:p.phone || c.phone || "", payer:p} : {name:c.name, email:c.email || "", phone:c.phone || "", payer:null}; }
function ownMessage(M, c, kind, monthK, first){
  const st = M.stats[c.id], me = P("trainerName") || "";
  if (kind === "renew"){ const left = Math.max(0, st.remaining||0); return fillTpl(P("renewalTemplate"), {first, left, s:left===1?"":"s", size:st.nextSize, price:Math.round(st.nextPrice).toLocaleString(), me}).replace(/ - $/,""); }
  if (kind === "unpaid") return `Hi ${first}! Quick reminder that payment for your ${st.current ? st.current.size + "-session " : ""}package (${money(st.unpaidAmt)}) is still open. Thanks!${me?" - "+me:""}`;
  const invs = st.invoices || [];
  const inv = monthK ? invs.find(i => i.month === monthK) : ([...invs].reverse().find(i => i.due && i.state !== "paid") || invs[invs.length-1]);
  if (!inv) return "";
  let t = fillTpl(P("invoiceTemplate"), {first, month:mLabel(inv.month,true), amount:Math.round(inv.amount).toLocaleString(), details:inv.details, me});
  const otherOpen = st.balance - Math.max(0, inv.amount - inv.paid);
  if (otherOpen > 0.5) t += ` Total balance including earlier months: ${money(st.balance)}.`;
  return t.replace(/ - $/,"");
}
/* One line per client this person pays for, added to their own messages. */
function dependentLines(M, c, kind, monthK){
  const lines = []; let extraAmt = 0;
  for (const d of dependentsOf(M, c)){
    const st = M.stats[d.id], dn = firstName(d.name);
    if (st.bill === "package"){
      if (st.status === "setup") continue;
      if (st.unpaidAmt > 0.5) lines.push(`${dn}'s package (${money(st.unpaidAmt)}) is also still open.`);
      else if (kind === "renew" || st.status === "low" || st.status === "out") lines.push(st.remaining > 0 ? `${dn} has ${st.remaining} session${st.remaining===1?"":"s"} left on their package.` : `${dn} is out of sessions; their next ${st.nextSize}-session package is ${money(st.nextPrice)}.`);
    } else if (st.bill !== "payg"){
      const invs = st.invoices || [];
      const k = monthK || ([...invs].reverse().find(i => i.due && i.state !== "paid") || invs[invs.length-1] || {}).month;
      const inv = invs.find(i => i.month === k);
      if (inv && inv.amount > 0.5){ extraAmt += Math.max(0, inv.amount - inv.paid); lines.push(`Plus ${dn}: ${money(inv.amount)} (${inv.details})${inv.paid > 0.5 && inv.paid < inv.amount - 0.5 ? `, ${money(inv.paid)} already paid` : inv.state === "paid" ? ", already paid" : ""}.`); }
    }
  }
  return {lines, extraAmt};
}
/* Past sessions in month k for a client plus everyone they pay for, oldest first. */
export function monthSessions(M, c, k){
  return [c, ...dependentsOf(M, c)].flatMap(p => ((M.stats[p.id] || {}).past || []).filter(s => mkey(s.date) === k).map(s => ({date:s.date, who:p}))).sort((a,b) => a.date - b.date);
}
/* Monthly sessions link: from the 1st to the 10th, a to-do to send last month's sessions to clients set up for it. */
export function monthLinkTodos(M){
  CTX = M.ctx; const now = M.now; if (now.getDate() > 10) return [];
  const pk = mkey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  return M.ctx.clients.filter(c => c.monthlyLink && c.active !== false && !payerOf(M, c) && c.monthlyLinkSent !== pk && M.stats[c.id])
    .map(c => ({c, month:pk, n:monthSessions(M, c, pk).length})).filter(t => t.n > 0);
}
export function messageText(M, c, kind, monthK, link){
  CTX = M.ctx; const me = P("trainerName") || "";
  if (kind === "monthlink"){
    const list = monthSessions(M, c, monthK), deps = dependentsOf(M, c).filter(d => list.some(x => x.who.id === d.id));
    const cnt = p => list.filter(x => x.who.id === p.id).length;
    const parts = deps.length ? ` (${[`${cnt(c)} for you`, ...deps.map(d => `${cnt(d)} for ${firstName(d.name)}`)].join(", ")})` : ` (${cnt(c)})`;
    return `Hi ${firstName(c.name)}! Here are your ${mLabel(monthK, true).replace(/ \d{4}$/, "")} sessions${parts}: ${link || "[link]"}${me ? " - " + me : ""}`;
  }
  const payer = payerOf(M, c);
  const sign = t => { let tail = me ? " - " + me : ""; let body = tail && t.endsWith(tail) ? t.slice(0, -tail.length) : (tail = "", t);
    const m = body.match(/\s+(Thanks!?|Thank you!?)$/i); if (m){ body = body.slice(0, -m[0].length); tail = " " + m[1] + tail; }
    return { body, tail }; };
  if (payer){
    // Addressed to whoever pays, about this client's sessions.
    const t = ownMessage(M, c, kind, monthK, firstName(payer.name)); if (!t) return "";
    const {body, tail} = sign(t);
    return `${body} (This is for ${firstName(c.name)}'s training.)${tail}`;
  }
  const t = ownMessage(M, c, kind, monthK, firstName(c.name));
  const {lines, extraAmt} = dependentLines(M, c, kind, monthK);
  if (!t || !lines.length) return t;
  const {body, tail} = sign(t);
  let total = "";
  if (extraAmt > 0.5 && kind === "invoice"){ const st = M.stats[c.id], invs = st.invoices || [];
    const inv = monthK ? invs.find(i => i.month === monthK) : ([...invs].reverse().find(i => i.due && i.state !== "paid") || invs[invs.length-1]);
    if (inv) total = ` Together that's ${money(inv.amount + extraAmt)}.`; }
  return `${body} ${lines.join(" ")}${total}${tail}`;
}

/* ======================================================================
 * Trends, tax, pricing and summaries
 * ==================================================================== */
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDay = d => d ? d.toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric"}) : "–";
const fmtTime = d => d ? d.toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit"}) : "";
const fmtShort = d => d ? d.toLocaleDateString("en-US", {month:"short", day:"numeric"}) : "–";
const activeClients = M => M.ctx.clients.filter(c => c.active !== false);

/* Who's growing, steady, slipping or gone quiet. Compares the last 4 weeks to the 12 weeks before. */
export function clientHealth(M){
  CTX = M.ctx;
  const now = M.now, w0 = sow(now), out = [];
  for (const c of activeClients(M)){
    const st = M.stats[c.id]; if (!st) continue;
    const past = st.past, first = past.length ? past[0].date : null;
    const inRange = (a, b) => past.filter(s => s.date >= a && s.date < b).length;
    const recentN = inRange(addDays(now, -28), now);
    const baseStart = new Date(Math.max(+addDays(now, -112), first ? +first : +now));
    const baseWeeks = Math.max(0, (addDays(now, -28) - baseStart) / (7*DAY));
    const recent = recentN / 4, base = baseWeeks >= 2 ? inRange(baseStart, addDays(now, -28)) / baseWeeks : null;
    const daysSince = st.last ? Math.floor((now - st.last) / DAY) : null;
    const bookedSoon = st.future.some(s => s.date < addDays(now, 8));
    const cut90 = addDays(now, -90);
    const cancels = st.skipped.filter(s => s.date >= cut90 && s.date < now).length, done90 = inRange(cut90, now);
    const weekly = Array.from({length:12}, (_, i) => { const a = addDays(w0, (i - 11) * 7); return inRange(a, addDays(a, 7)); });
    let status = "steady", note = "";
    if (!past.length) { status = "new"; note = st.next ? "First session booked" : "No sessions yet"; }
    else if (first >= addDays(now, -42)) { status = "new"; note = `Started ${fmtShort(first)}`; }
    else if (daysSince !== null && daysSince >= 14 && !bookedSoon) { status = "quiet"; note = `No session in ${daysSince} days`; }
    else if (base && recent < base * 0.7 && base >= 0.75) { status = "slipping"; note = `${base.toFixed(1)} → ${recent.toFixed(1)} per week`; }
    else if (base && recent > base * 1.3) { status = "growing"; note = `${base.toFixed(1)} → ${recent.toFixed(1)} per week`; }
    else note = `${recent.toFixed(1)} per week`;
    const earned = past.reduce((a, s) => a + (s.value || 0), 0);
    out.push({c, st, status, note, recent, base, change: base ? (recent - base) / base : null, daysSince, bookedSoon,
      cancelRate: (cancels + done90) ? cancels / (cancels + done90) : 0, cancels, earned, weekly, first, sessions: past.length});
  }
  const rank = {quiet:0, slipping:1, new:2, growing:3, steady:4};
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.earned - a.earned);
}

/* Active / new / lost clients by month. */
export function retention(M){
  CTX = M.ctx;
  const hs = mkey(parseDay(P("historyStart"))), months = [];
  const activeIn = {}, firstM = {};
  for (const c of M.ctx.clients){ const st = M.stats[c.id]; if (!st) continue;
    for (const s of st.past){ const k = mkey(s.date); (activeIn[k] = activeIn[k] || new Set()).add(c.id); if (!firstM[c.id] || k < firstM[c.id]) firstM[c.id] = k; } }
  for (let k = hs; k <= M.curM; k = mNext(k)){
    const act = activeIn[k] || new Set(), prev = activeIn[mPrev(k)] || new Set();
    const isNew = [...act].filter(id => firstM[id] === k && k !== hs).length;
    const lost = k === M.curM ? null : [...prev].filter(id => !act.has(id)).length;
    months.push({month:k, active: act.size, new: isNew, lost});
  }
  const ltv = M.ctx.clients.map(c => M.stats[c.id] ? M.stats[c.id].past.reduce((a, s) => a + (s.value||0), 0) : 0).filter(v => v > 0);
  return {months, avgValue: ltv.length ? ltv.reduce((a,b)=>a+b,0) / ltv.length : 0};
}

/* Rough tax set-aside for self-employed trainers. An estimate, not tax advice. */
export const QUARTERS = [
  {label:"Q1", from:[0,1], to:[3,1], due:[3,15]},   // Jan 1 – Mar 31, due Apr 15
  {label:"Q2", from:[3,1], to:[5,1], due:[5,15]},   // Apr 1 – May 31, due Jun 15
  {label:"Q3", from:[5,1], to:[8,1], due:[8,15]},   // Jun 1 – Aug 31, due Sep 15
  {label:"Q4", from:[8,1], to:[12,1], due:[12,15]}  // Sep 1 – Dec 31, due Jan 15
];
export function taxEstimate(M, cfg){
  CTX = M.ctx;
  const t = {...DEFAULTS.tax, ...(cfg || P("tax") || {})};
  const seRate = t.se === false ? 0 : 0.9235 * 0.153;
  const rate = t.setAside != null && t.setAside !== "" ? num(t.setAside) / 100 : seRate + (num(t.federal) + num(t.state)) / 100;
  const Y = M.now.getFullYear(), exp = num(t.expensesMonthly);
  const monthNet = k => { const T = monthTotals(M, k); return T.net - exp; };
  const quarters = QUARTERS.map(q => {
    let profit = 0;
    for (let m = q.from[0]; m < q.to[0]; m++){ const k = Y + "-" + pad(m + 1); if (k <= M.curM) profit += monthNet(k); }
    const due = new Date(Y + (q.due[0] >= 12 ? 1 : 0), q.due[0] % 12, q.due[1]);
    const end = new Date(Y, q.to[0], 1);
    return {label:q.label, profit, tax: Math.max(0, profit) * rate, due, state: M.now >= due ? "past" : M.now >= end ? "due" : M.now >= new Date(Y, q.from[0], 1) ? "current" : "upcoming"};
  });
  const ytdProfit = quarters.reduce((a, q) => a + q.profit, 0);
  const cur = monthNet(M.curM);
  const next = quarters.find(q => q.state === "due" || q.state === "current");
  return {enabled: !!t.enabled, rate, cfg: t, ytdProfit, ytdTax: Math.max(0, ytdProfit) * rate,
    thisMonth: {net: cur, setAside: Math.max(0, cur) * rate}, quarters, next};
}

/* What a rate change would do. increase is $ per session (or % when mode === "percent"). */
export function simulateRate(M, {increase = 0, mode = "amount", clientIds = null, lose = 0} = {}){
  CTX = M.ctx;
  const r = rentCfg(), rows = [];
  for (const c of activeClients(M)){
    if (clientIds && !clientIds.includes(c.id)) continue;
    const st = M.stats[c.id]; if (!st || !st.pace) continue;
    const perMonth = st.pace * 52 / 12;
    let nowRev, add;
    if (st.bill === "membership"){ const fee = num(c.fee); nowRev = fee; add = mode === "percent" ? fee * increase / 100 : increase * perMonth; }
    else { const per = st.perSession || st.rate || 0; nowRev = per * perMonth; add = (mode === "percent" ? per * increase / 100 : increase) * perMonth; }
    const rentCut = r.mode === "percent" && st.rentShare ? add * st.rentShare * num(r.percent) / 100 : 0;
    rows.push({c, perMonth, now: nowRev, add: add - rentCut, newRate: st.bill === "membership" ? num(c.fee) + (mode === "percent" ? num(c.fee) * increase / 100 : increase * perMonth) : (st.perSession || st.rate || 0) * (mode === "percent" ? 1 + increase / 100 : 1) + (mode === "percent" ? 0 : increase)});
  }
  const gain = rows.reduce((a, x) => a + x.add, 0);
  const avgClient = rows.length ? rows.reduce((a, x) => a + x.now + x.add, 0) / rows.length : 0;
  const lossCost = lose * avgClient;
  const breakEven = avgClient ? gain / avgClient : 0;
  return {rows, monthly: gain - lossCost, annual: (gain - lossCost) * 12, gross: gain, lossCost, breakEven, clients: rows.length};
}

/* What a client sees on their private "sessions left" page. No prices. */
export function clientView(M, clientId){
  CTX = M.ctx;
  const c = M.ctx.clients.find(x => x.id === clientId); if (!c) return null;
  const st = M.stats[c.id], now = M.now;
  const v = {first: firstName(c.name), trainer: P("trainerName") || "", billing: st.bill,
    next: st.future.slice(0, 6).map(s => s.date.toISOString()), recent: st.past.slice(-6).reverse().map(s => s.date.toISOString()),
    updated: now.toISOString()};
  if (st.bill === "package" && st.current){ v.left = Math.max(0, st.remaining); v.size = st.current.size; v.used = Math.min(st.current.size, st.current.usedIn); v.over = Math.max(0, -st.remaining);
    v.runout = st.runout ? st.runout.toISOString() : null; v.runoutEst = !!st.runoutEst;
    // Every session in this package (plus any past it), newest first.
    const inPack = st.past.filter(s => s.pkg === st.current.index || s.over);
    if (inPack.length > v.recent.length) v.recent = inPack.slice().reverse().map(s => s.date.toISOString());
    v.packSessions = true; }
  else { const k = M.curM; v.thisMonth = st.past.filter(s => mkey(s.date) === k).length; v.bookedThisMonth = st.future.filter(s => mkey(s.date) === k).length;
    if (st.bill === "membership" && num(c.included)) v.included = num(c.included);
    // Dated session lists for this month and last, including anyone this client pays for.
    const deps = dependentsOf(M, c), people = [c, ...deps], who = p => deps.length ? firstName(p.name) : "";
    const pk = mkey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    v.people = deps.length ? people.map(p => firstName(p.name)) : null;
    // From the oldest month still unpaid (theirs or anyone they pay for) through this month; at least last month.
    let from = pk;
    for (const p of people) for (const inv of (M.stats[p.id].invoices || [])) if (inv.due && inv.amount > 0.5 && inv.state !== "paid" && inv.month < from) from = inv.month;
    const keys = []; for (let m = from; m <= k; m = mNext(m)) keys.push(m);
    v.months = keys.map(m => ({month:m, label:mLabel(m, true),
      done: monthSessions(M, c, m).map(x => ({at:x.date.toISOString(), who:who(x.who)})),
      booked: m === k ? people.flatMap(p => M.stats[p.id].future.filter(s => mkey(s.date) === k).map(s => ({at:s.date.toISOString(), who:who(p)}))).sort((a,b) => a.at.localeCompare(b.at)) : []})); }
  return v;
}

/* Email summaries ---------------------------------------------------- */
const box = (inner) => `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1d1a14;background:#fffcf6;border:1px solid #e2d9c8;border-radius:14px;padding:24px">${inner}<p style="color:#877f6f;font-size:12px;margin-top:24px">Sent by Trainer Tally. Change these emails in Settings → Automatic messages.</p></div>`;
const h2 = t => `<h2 style="font-size:15px;margin:22px 0 8px">${esc(t)}</h2>`;
const kpis = items => `<table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0"><tr>${items.map(([k, v, d]) => `<td style="padding:10px;border:1px solid #e2d9c8;border-radius:8px;vertical-align:top"><div style="font-size:12px;color:#877f6f">${esc(k)}</div><div style="font-size:22px;font-weight:700">${esc(v)}</div>${d ? `<div style="font-size:12px;color:#4f493d">${esc(d)}</div>` : ""}</td>`).join("")}</tr></table>`;
const list = rows => rows.length ? `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">${rows.map(([a, b]) => `<tr><td style="padding:7px 0;border-bottom:1px solid #eee7da">${esc(a)}</td><td style="padding:7px 0;border-bottom:1px solid #eee7da;text-align:right;font-weight:600">${esc(b)}</td></tr>`).join("")}</table>` : `<p style="color:#877f6f;font-size:14px;margin:0">Nothing here.</p>`;
const textList = rows => rows.length ? rows.map(([a, b]) => `  • ${a} — ${b}`).join("\n") : "  Nothing here.";
function attentionRows(M){
  return attention(M).filter(a => a.kind !== "setup").map(({c, st, kind}) => {
    if (kind === "renew") return [c.name, st.remaining < 0 ? `${-st.remaining} past package — renewal due` : st.remaining === 0 ? "out of sessions" : `${st.remaining} left · runs out ${st.runout ? (st.runoutEst ? "~" : "") + fmtShort(st.runout) : "soon"}`];
    if (kind === "unpaid") return [c.name, `package unpaid · ${money(st.unpaidAmt)}`];
    return [c.name, `owes ${money(st.balance)}`];
  });
}
function compose(subject, sections, appUrl){
  const html = box(sections.map(s => s.html).join("") + (appUrl ? `<p style="margin-top:22px"><a href="${esc(appUrl)}" style="background:#1d1a14;color:#fffcf6;padding:10px 16px;border-radius:9px;text-decoration:none;font-weight:600">Open Trainer Tally</a></p>` : ""));
  const text = sections.map(s => s.text).join("\n\n") + (appUrl ? `\n\nOpen Trainer Tally: ${appUrl}` : "");
  return {subject, html, text};
}
export function weeklySummary(M, {appUrl = ""} = {}){
  CTX = M.ctx;
  const now = M.now, ws = sow(now), we = addDays(ws, 7), lws = addDays(ws, -7);
  const sum = (a, b) => { let n = 0, earned = 0, rent = 0; for (const c of M.ctx.clients){ const st = M.stats[c.id]; for (const s of st.past) if (s.date >= a && s.date < b){ n++; earned += s.value; rent += s.rent; } } return {n, earned, rent, net: earned - rent}; };
  const T = sum(ws, now), L = sum(lws, ws);
  const pays = []; for (const c of M.ctx.clients) for (const p of (c.payments||[])){ const d = parseDay(p.date); if (d >= ws && d < we) pays.push([c.name, money(num(p.amount)) + (p.method ? " · " + p.method : "")]); }
  const nextWeek = sessionsIn(M, we, addDays(we, 7));
  const byDay = {}; nextWeek.forEach(s => { const k = fmtDay(s.date); byDay[k] = (byDay[k] || 0) + 1; });
  const runningOut = M.ctx.clients.map(c => ({c, st: M.stats[c.id]})).filter(x => x.c.active !== false && x.st.bill === "package" && x.st.runout && x.st.runout >= now && x.st.runout < addDays(we, 7)).map(x => [x.c.name, `runs out ${fmtShort(x.st.runout)}`]);
  const quiet = clientHealth(M).filter(h => h.status === "quiet" || h.status === "slipping").map(h => [h.c.name, h.note]);
  const tax = taxEstimate(M);
  const att = attentionRows(M);
  const delta = L.n ? ` (${T.n - L.n >= 0 ? "+" : ""}${T.n - L.n} vs last week)` : "";
  const sections = [
    {html: `<h1 style="font-size:20px;margin:0 0 4px">Your week, ${esc(fmtShort(ws))}–${esc(fmtShort(addDays(ws, 6)))}</h1><p style="margin:0;color:#4f493d">Hi ${esc(P("trainerName") || "there")}, here's where things stand.</p>` + kpis([["Sessions", String(T.n), delta.trim()], ["Earned", money(T.earned), ""], ["Net after rent", money(T.net), ""]]),
     text: `Your week, ${fmtShort(ws)}–${fmtShort(addDays(ws, 6))}\nSessions: ${T.n}${delta}\nEarned: ${money(T.earned)}\nNet after rent: ${money(T.net)}`},
    {html: h2("Needs attention") + list(att), text: "Needs attention\n" + textList(att)},
    {html: h2("Payments logged this week") + list(pays), text: "Payments logged this week\n" + textList(pays)},
    {html: h2(`Next week · ${nextWeek.length} session${nextWeek.length === 1 ? "" : "s"} booked`) + list(Object.entries(byDay).map(([d, n]) => [d, `${n} session${n === 1 ? "" : "s"}`])),
     text: `Next week: ${nextWeek.length} sessions booked\n` + textList(Object.entries(byDay).map(([d, n]) => [d, String(n)]))},
  ];
  if (runningOut.length) sections.push({html: h2("Packages running out next week") + list(runningOut), text: "Packages running out next week\n" + textList(runningOut)});
  if (quiet.length) sections.push({html: h2("Check in with") + list(quiet), text: "Check in with\n" + textList(quiet)});
  if (tax.enabled) sections.push({html: h2("Tax set-aside") + list([["This week's net", money(T.net)], [`Set aside (${Math.round(tax.rate * 100)}%)`, money(Math.max(0, T.net) * tax.rate)]]), text: `Tax set-aside: ${money(Math.max(0, T.net) * tax.rate)} of this week's ${money(T.net)} net`});
  if (M.unmatched.length) sections.push({html: `<p style="font-size:13px;color:#4f493d;margin-top:16px">${M.unmatched.length} calendar name${M.unmatched.length === 1 ? "" : "s"} aren't matched to a client yet.</p>`, text: `${M.unmatched.length} calendar names aren't matched to a client yet.`});
  return compose(`Your week: ${T.n} sessions, ${money(T.net)} net` + (att.length ? ` · ${att.length} need${att.length === 1 ? "s" : ""} attention` : ""), sections, appUrl);
}
export function monthlySummary(M, {appUrl = ""} = {}){
  CTX = M.ctx;
  const k = M.curM, T = monthTotals(M, k), L = monthTotals(M, mPrev(k)), pr = projectMonth(M, k);
  const bills = [], open = [];
  for (const c of activeClients(M)){
    const st = M.stats[c.id];
    if (st.bill === "tab" || st.bill === "membership"){
      const inv = st.invoices.find(i => i.month === k);
      if (inv && (inv.amount > 0 || inv.sched)) bills.push([c.name, `${money(inv.amount)}${inv.sched ? ` + ${inv.sched} booked` : ""} · ${inv.n} session${inv.n === 1 ? "" : "s"}${inv.state === "paid" ? " · paid" : ""}`]);
      for (const i of st.invoices) if (i.month < k && i.due && i.state !== "paid") open.push([c.name, `${mLabel(i.month)} · ${money(i.amount - i.paid)}`]);
    }
    if (st.bill === "package" && st.unpaid && st.unpaid.length) open.push([c.name, `package unpaid · ${money(st.unpaidAmt)}`]);
  }
  const nm = mNext(k), nmStart = mStart(nm), nmEnd = mStart(mNext(nm));
  const renewals = activeClients(M).map(c => ({c, st: M.stats[c.id]})).filter(x => x.st.bill === "package" && x.st.runout && x.st.runout < nmEnd)
    .sort((a, b) => a.st.runout - b.st.runout).map(x => [x.c.name, x.st.remaining <= 0 ? "renewal due now" : `runs out ${(x.st.runoutEst ? "~" : "") + fmtShort(x.st.runout)} · ${money(x.st.nextPrice)}`]);
  const r = rentCfg(), tax = taxEstimate(M);
  const rentLine = r.mode === "monthly" ? `${money(num(r.monthly))} flat` : r.mode === "none" ? "No studio rent" : `${money(T.rent)} so far`;
  const sections = [
    {html: `<h1 style="font-size:20px;margin:0 0 4px">${esc(mLabel(k, true))} reconciliation</h1><p style="margin:0;color:#4f493d">Two days left in the month. Here's what to bill, collect and expect.</p>` +
      kpis([["Sessions", String(T.n), pr.n >= 0.5 ? `+${Math.round(pr.n)} expected` : ""], ["Earned", money(T.earned), L.earned ? `${T.earned - L.earned >= 0 ? "+" : ""}${money(T.earned - L.earned)} vs ${MONTHS[mStart(mPrev(k)).getMonth()]}` : ""], ["Net after rent", money(T.net), `${money(T.collected)} collected`]]),
     text: `${mLabel(k, true)} reconciliation\nSessions: ${T.n}\nEarned: ${money(T.earned)}\nStudio rent: ${rentLine}\nNet: ${money(T.net)}\nCollected: ${money(T.collected)}`},
    {html: h2("Monthly bills to send") + list(bills), text: "Monthly bills to send\n" + textList(bills)},
    {html: h2("Still unpaid") + list(open), text: "Still unpaid\n" + textList(open)},
    {html: h2(`Renewals coming up in ${MONTHS[nmStart.getMonth()]}`) + list(renewals), text: `Renewals coming up in ${MONTHS[nmStart.getMonth()]}\n` + textList(renewals)},
    {html: h2("Studio rent") + list([["This month", rentLine]]), text: `Studio rent: ${rentLine}`}
  ];
  if (tax.enabled){
    const rows = [[`Set aside for ${MONTHS[mStart(k).getMonth()]} (${Math.round(tax.rate * 100)}%)`, money(tax.thisMonth.setAside)], ["Year to date", money(tax.ytdTax)]];
    if (tax.next) rows.push([`${tax.next.label} estimated payment, due ${fmtShort(tax.next.due)}`, money(tax.next.tax)]);
    sections.push({html: h2("Taxes (estimate)") + list(rows), text: "Taxes (estimate)\n" + textList(rows)});
  }
  return compose(`${mLabel(k, true)} reconciliation: ${money(T.net)} net` + (open.length ? ` · ${open.length} unpaid` : ""), sections, appUrl);
}
/* A renewal reminder to a client, as an email. */
export function renewalEmail(M, c){
  const text = messageText(M, c, "renew"); CTX = M.ctx;
  const me = P("trainerName") || "your trainer";
  return {subject: `Your training package with ${me}`, text, html: box(`<p style="font-size:15px;line-height:1.55;margin:0">${esc(text)}</p>`).replace("Sent by Trainer Tally. Change these emails in Settings → Automatic messages.", `Sent on behalf of ${esc(me)}. Reply to this email to reach them.`)};
}

/* The trainer's own count of studio sessions in a month, for checking a studio's statement. */
export function studioCount(M, k){
  CTX = M.ctx;
  let n = 0, free = 0;
  for (const c of M.ctx.clients){ const st = M.stats[c.id]; if (!st) continue;
    for (const s of st.past) if (s.studio && mkey(s.date) === k){ if (rentApplies(c, s)) n++; else free++; } }
  return {n, free};
}
