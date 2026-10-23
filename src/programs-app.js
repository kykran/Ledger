/* Standalone Programs page (/programs): the coaching side on its own.
 * Same sign-in and data as Trainer Tally, but it only loads clients and programs: no calendar sync, no income. */
import "./styles.css";
import "./engine-global.js";
import "./programs.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const P = window.TallyPrograms;
const S = { clients: [], prof: null, ready: false, M: null, calLoading: true };
let A = null;

// Theme: same saved choice as the main app.
try { const t = localStorage.getItem("tt-theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}

function hueOf(s){ let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
const initials = n => String(n || "?").trim().split(/[\s+&]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
const avatar = c => `<span class="av" style="background:hsl(${hueOf(c.name)} 52% 46%)" aria-hidden="true">${esc(initials(c.name))}</span>`;
function toast(msg){ const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2800); }
const closeModal = () => { $("#modal").innerHTML = ""; };
function render(){
  if (!S.ready) return;
  if (S.prof && S.prof.programsOff){ $("#main").innerHTML = `<div class="card"><div class="empty"><b>Programs is turned off</b><span>Turn it back on in Trainer Tally → Settings → Features.</span><a class="btn" href="/">Open Trainer Tally</a></div></div>`; return; }
  $("#main").innerHTML = P.render();
}
// Calendar sessions are read only to spot clients booked without a workout written. Income isn't shown here.
let demoMode = false;
async function loadModel(refresh){
  const E = globalThis.TallyEngine;
  const use = rows => { S.M = E.compute({ profile: S.prof, clients: S.clients, events: rows ? E.normalizeEvents(rows, S.prof) : [], now: new Date() }); };
  try {
    if (demoMode){ const { buildDemo } = await import("./demo-data.js"); const D = buildDemo(); const cal = Object.fromEntries((S.prof || D.profile).calendars.map(c => [c.id, c])); S.M = E.compute({ profile: S.prof, clients: S.clients, events: E.normalizeEvents(D.events.map(e => [e, cal[e.cal]]).filter(r => r[1]), S.prof || D.profile), now: new Date() }); }
    // Older than 20 minutes: show what's saved now, then redraw once the background sync brings in new bookings.
    else if (A.events) use(await A.events.load({ refresh: !!refresh, onUpdate: rows => { use(rows); render(); } }));
    else use([]);
  } catch (e){ if (refresh) throw e; S.M = null; }
  S.calLoading = false; render();
}
/* Sync button: re-read clients (one just added in Billing shows up) and pull fresh bookings from Google Calendar. */
async function syncNow(btn){
  if (btn.disabled) return;
  btn.disabled = true; btn.classList.add("spin"); const label = btn.querySelector("span"); label.textContent = "Syncing…";
  const before = new Set(S.clients.map(c => c.id));
  try {
    if (A.listClients) S.clients = await A.listClients();
    S.calLoading = true; render();
    await loadModel(true);
    const added = S.clients.filter(c => !before.has(c.id) && c.active !== false);
    toast(added.length ? `Synced. New: ${added.map(c => c.name.split(" ")[0]).join(", ")}` : "Synced with your calendar");
  } catch (e){ S.calLoading = false; render(); toast("Couldn't sync. Check your connection and try again."); }
  btn.disabled = false; btn.classList.remove("spin"); label.textContent = "Sync";
}
async function saveClient(c){ const body = { ...c }; delete body.id; body.updatedAt = new Date().toISOString(); const i = S.clients.findIndex(x => x.id === c.id); if (i >= 0) S.clients[i] = c; else S.clients.push(c); await A.setClient(c.id, body); }
/* A client was added here: recount with the bookings already loaded, so their next session shows straight away. */
function modelChanged(){ if (S.M) S.M = globalThis.TallyEngine.compute({ profile: S.prof, clients: S.clients, events: S.M.ctx.events, now: new Date() }); render(); }
async function saveProfile(patch){ S.prof = { ...(S.prof || {}), ...patch, updatedAt: new Date().toISOString() }; await A.setProfile(S.prof); }

document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.getAttribute("data-act");
  if (act === "close-scrim" && e.target !== el) return;
  if (el.tagName === "A" && el.getAttribute("href") === "#") e.preventDefault();
  if (act === "close" || act === "close-scrim") return closeModal();
  if (act === "pa-sync") return syncNow(el);
  if (act === "pa-signin"){ el.disabled = true; el.textContent = "Opening Google…"; A.grantCalendar(); return; }
  if (act.startsWith("pg-")) P.onClick(el, e);
});
document.addEventListener("input", e => { if (e.target.getAttribute && e.target.getAttribute("data-pg")) P.onInput(e.target); });
document.addEventListener("change", e => { if (e.target.getAttribute && e.target.getAttribute("data-pg")) P.onChange(e.target); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

async function start(){
  const demo = new URLSearchParams(location.search).has("demo");
  if (demo){ await import("./engine-global.js"); const { demoAdapter } = await import("./demo-core.js"); A = demoAdapter(); $("#pa-home").href = "/demo.html"; }
  else A = (await import("./adapter-hosted-core.js")).default;
  demoMode = demo;
  P.attach({ S, A, avatar, toast, render, closeModal, saveClient, saveProfile, modelChanged, standalone: true, getModel: () => S.M, modelLoading: () => S.calLoading });
  let info; try { info = await A.init(); } catch (e) { info = { status: "error" }; }
  if (info.status !== "ready"){
    $("#main").innerHTML = info.status === "signin"
      ? `<div class="card"><div class="empty"><b>Sign in to see your programs</b><span>Use the same Google account as Trainer Tally.</span><button class="btn primary" data-act="pa-signin">Sign in with Google</button></div></div>`
      : `<div class="card"><div class="empty"><b>Couldn't load</b><span>Check your connection and refresh.</span></div></div>`;
    return;
  }
  if (!demo){ try { localStorage.setItem("tt-side", "programs"); } catch (e) {} }
  let gotP = false, gotC = false;
  let modelStarted = false;
  const go = () => { if (gotP && gotC){ S.ready = true; if (S.prof && S.prof.setupDone) $("#pa-sync").hidden = false; render(); if (!modelStarted && S.prof && S.prof.setupDone){ modelStarted = true; loadModel(); } else if (S.M && !S.calLoading){ S.M = globalThis.TallyEngine.compute({ profile: S.prof, clients: S.clients, events: S.M.ctx.events, now: new Date() }); render(); } } };
  A.watchProfile(p => { S.prof = p; gotP = true; go(); }, () => { gotP = true; go(); });
  A.watchClients(list => { S.clients = list; gotC = true; go(); }, () => { gotC = true; go(); });
}
start();
