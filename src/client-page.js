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
    const D = buildDemo();
    // ?demo=owed: Priya with two unpaid packages, the first started before the calendar history (3 listed earlier dates).
    if (demo === "owed"){ const c = D.clients.find(x => x.id === "priya"), old = new Date(Date.now() - 95 * 864e5);
      c.packages = [{ id: "o1", size: 24, price: 2400, start: old.toISOString(), used0: 3, earlier: [1, 2, 3].map(k => new Date(old - (4 - k) * 7 * 864e5).toISOString()) }, { id: "o2", size: 24, price: 2400 }]; }
    // ?demo=cash: Priya's earlier package paid in cash and still listed, then her current one not paid yet.
    if (demo === "cash"){ const c = D.clients.find(x => x.id === "priya"), old = new Date(Date.now() - 95 * 864e5);
      c.packages = [{ id: "c1", size: 24, price: 2400, start: old.toISOString(), used0: 0, paidDate: "2026-08-10", paidNote: "Paid in cash", onLink: true }, { id: "c2", size: 24, price: 2400 }]; }
    // ?demo=shared (or =david): Leslie uses David's package, so both of their sessions count down one package. Shown from Leslie's side.
    if (demo === "shared" || demo === "david") D.clients.push({ id: "leslie", name: "Leslie", aliases: [], billing: "package", paidBy: "david", sharePackage: true, packages: [], payments: [], active: true });
    const v = E.clientView(demoModel(D, D.profile, D.clients), demo === "owed" || demo === "cash" ? "priya" : demo === "shared" ? "leslie" : demo);
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
