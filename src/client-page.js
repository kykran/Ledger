/* The page a client opens from their trainer's link: sessions left (packages) or each month's dated sessions (monthly bill), plus upcoming dates. Read-only, no prices. */
import { sessionCards } from "./sessions-view.js";

const $m = document.getElementById("m");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const token = (location.pathname.match(/\/s\/([A-Za-z0-9_-]+)/) || [])[1] || new URLSearchParams(location.search).get("t") || "";

function render(v){
  const tz = v.timeZone || undefined;
  document.title = `${v.first}'s sessions`;
  $m.innerHTML = `<div><h1>Hi ${esc(v.first)}</h1><p class="sub">${v.trainer ? `Your training with ${esc(v.trainer)}` : "Your training"}</p></div>
    ${sessionCards(v)}
    <footer>Updated ${esc(new Date(v.updated).toLocaleString("en-US", {month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZone: tz}))} · Trainer Tally</footer>`;
}

async function load(){
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo){
    const E = await import("./engine.js"); globalThis.TallyEngine = E;
    const { buildDemo } = await import("./demo-data.js"); const { demoModel } = await import("./demo-core.js");
    const D = buildDemo(); const v = E.clientView(demoModel(D, D.profile, D.clients), demo);
    if (v) return render(v);
  }
  try {
    const r = await fetch("/api/client-view?t=" + encodeURIComponent(token));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "Couldn't load this page.");
    render(j);
  } catch (e) { $m.innerHTML = `<div class="card"><h1 style="font-size:18px">Can't show this page</h1><p class="note" style="margin-top:6px">${esc(e.message)}</p></div>`; }
}
load();
