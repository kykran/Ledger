/* Standalone Programs page (/programs): the coaching side on its own.
 * Same sign-in and data as Trainer Tally, but it only loads clients and programs: no calendar sync, no income. */
import "./styles.css";
import "./programs.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const P = window.TallyPrograms;
const S = { clients: [], prof: null, ready: false };
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
  $("#main").innerHTML = P.render();
}
async function saveClient(c){ const body = { ...c }; delete body.id; body.updatedAt = new Date().toISOString(); const i = S.clients.findIndex(x => x.id === c.id); if (i >= 0) S.clients[i] = c; await A.setClient(c.id, body); }
async function saveProfile(patch){ S.prof = { ...(S.prof || {}), ...patch, updatedAt: new Date().toISOString() }; await A.setProfile(S.prof); }

document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.getAttribute("data-act");
  if (act === "close-scrim" && e.target !== el) return;
  if (el.tagName === "A" && el.getAttribute("href") === "#") e.preventDefault();
  if (act === "close" || act === "close-scrim") return closeModal();
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
  P.attach({ S, A, avatar, toast, render, closeModal, saveClient, saveProfile, standalone: true });
  let info; try { info = await A.init(); } catch (e) { info = { status: "error" }; }
  if (info.status !== "ready"){
    $("#main").innerHTML = info.status === "signin"
      ? `<div class="card"><div class="empty"><b>Sign in to see your programs</b><span>Use the same Google account as Trainer Tally.</span><button class="btn primary" data-act="pa-signin">Sign in with Google</button></div></div>`
      : `<div class="card"><div class="empty"><b>Couldn't load</b><span>Check your connection and refresh.</span></div></div>`;
    return;
  }
  if (info.account && info.account.email) $("#pa-who").textContent = info.account.email;
  let gotP = false, gotC = false;
  const go = () => { if (gotP && gotC){ S.ready = true; render(); } };
  A.watchProfile(p => { S.prof = p; gotP = true; go(); }, () => { gotP = true; go(); });
  A.watchClients(list => { S.clients = list; gotC = true; go(); }, () => { gotC = true; go(); });
}
start();
