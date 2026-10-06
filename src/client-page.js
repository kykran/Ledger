/* The page a client opens from their trainer's link: sessions left (packages) or each month's dated sessions (monthly bill), plus upcoming dates. Read-only, no prices. */
const $m = document.getElementById("m");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const token = (location.pathname.match(/\/s\/([A-Za-z0-9_-]+)/) || [])[1] || new URLSearchParams(location.search).get("t") || "";

function render(v){
  const tz = v.timeZone || undefined;
  const day = iso => new Date(iso).toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric", timeZone: tz});
  const time = iso => new Date(iso).toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit", timeZone: tz});
  const rows = (list, withTime) => list.length ? `<ul>${list.map(i => `<li><span>${esc(day(i))}</span><span>${withTime ? esc(time(i)) : ""}</span></li>`).join("")}</ul>` : `<p class="empty">None yet.</p>`;
  let head;
  if (v.billing === "package" && v.size){
    const pct = Math.min(100, Math.round(v.used / v.size * 100));
    head = `<div class="card"><h2>Sessions left</h2><div><span class="big">${v.left}</span><span class="of">of ${v.size}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="note ${v.left <= 2 ? "warn" : ""}">${v.over ? `${v.over} session${v.over === 1 ? "" : "s"} past this package. Time to renew.` : v.left === 0 ? "Package used up. Time to renew." : v.runout ? `At your current schedule, your last session is around ${esc(day(v.runout))}.` : `${v.used} used so far.`}</p></div>`;
  } else {
    head = `<div class="card"><h2>This month</h2><div><span class="big">${v.thisMonth || 0}</span><span class="of">${v.included ? `of ${v.included} included` : "sessions so far"}</span></div>
      <p class="note" style="margin-top:10px">${v.bookedThisMonth ? `${v.bookedThisMonth} more booked this month.` : "No more booked this month."}</p></div>`;
  }
  let recent = `<div class="card"><h2>Recent sessions</h2>${rows(v.recent, false)}</div>`;
  if (v.months){
    // Monthly-bill clients: every session this month and last, by date (and by person if they pay for someone else).
    const items = list => list.length ? `<ul>${list.map(x => `<li><span>${esc(day(x.at))}</span><span>${esc(x.who || "")}</span></li>`).join("")}</ul>` : `<p class="empty">None.</p>`;
    const by = list => v.people ? `<p class="note">${v.people.map(n => `${esc(n)}: ${list.filter(x => x.who === n).length}`).join(" · ")}</p>` : "";
    const [cur, last] = v.months;
    const early = new Date(v.updated).getDate() <= 10; // early in the month, last month (the one just billed) comes first
    head = `<div class="card"><h2>${esc(cur.label)}</h2><div><span class="big">${cur.done.length}</span><span class="of">session${cur.done.length === 1 ? "" : "s"} so far</span></div>${by(cur.done)}
      ${items(cur.done)}${cur.booked.length ? `<p class="note" style="margin-top:10px">${cur.booked.length} more booked this month.</p>` : ""}</div>`;
    recent = `<div class="card"><h2>${esc(last.label)}</h2><div><span class="big">${last.done.length}</span><span class="of">session${last.done.length === 1 ? "" : "s"}</span></div>${by(last.done)}${items(last.done)}</div>`;
    if (early) [head, recent] = [recent, head];
  }
  document.title = `${v.first}'s sessions`;
  $m.innerHTML = `<div><h1>Hi ${esc(v.first)}</h1><p class="sub">${v.trainer ? `Your training with ${esc(v.trainer)}` : "Your training"}</p></div>
    ${head}
    <div class="card"><h2>Coming up</h2>${rows(v.next, true)}</div>
    ${recent}
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
