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
  let recent = `<div class="card"><h2>${v.packSessions ? "Sessions this package" : "Recent sessions"}</h2>${rows(v.recent, false)}</div>`;
  let upcoming = `<div class="card"><h2>Coming up</h2>${rows(v.next, true)}</div>`;
  if (v.pack){
    // Package clients: every session numbered 1..size, then what counts toward the next package.
    const line = (iso, n, booked) => `<li class="${booked ? "bk" : ""}"><span><b class="n">${n}</b>${esc(day(iso))}</span><span>${booked ? `booked · ${esc(time(iso))}` : "done"}</span></li>`;
    const P = v.pack, done = P.done.length + (P.uncounted || 0), fmtRange = a => a.length ? `${esc(day(a[0]).replace(/^\w+, /, ""))} – ${esc(day(a[a.length - 1]).replace(/^\w+, /, ""))}` : "";
    const all = [...P.done, ...P.booked];
    recent = `<div class="card"><h2>This package · ${P.size} sessions</h2><p class="note">${fmtRange(all)}${P.done.length ? ` · ${Math.min(done, P.size)} done` : ""}${P.booked.length ? ` · ${P.booked.length} booked` : ""}</p>
      <ul class="num">${P.uncounted ? `<li><span><b class="n">1–${P.uncounted}</b>Earlier sessions</span><span>done</span></li>` : ""}${P.done.map((d, i) => line(d, i + 1 + (P.uncounted || 0), false)).join("")}${P.booked.map((d, i) => line(d, done + i + 1, true)).join("")}</ul>
      ${done + P.booked.length < P.size ? `<p class="note" style="margin-top:10px">${P.size - done - P.booked.length} more to book in this package.</p>` : ""}</div>`;
    const N = v.nextPack || { done: [], booked: [] };
    if (N.done.length || N.booked.length){
      recent += `<div class="card nextpk"><h2>Next package</h2><p class="note ${N.done.length ? "warn" : ""}">${N.done.length ? `${N.done.length} session${N.done.length === 1 ? "" : "s"} done since this package ran out. They count toward your next package.` : "These sessions start your next package."}</p>
        <ul class="num">${N.done.map((d, i) => line(d, i + 1, false)).join("")}${N.booked.map((d, i) => line(d, N.done.length + i + 1, true)).join("")}</ul></div>`;
    }
    upcoming = "";
  }
  if (v.months){
    // Monthly-bill clients: every session this month and last, by date (and by person if they pay for someone else).
    const items = list => list.length ? `<ul>${list.map(x => `<li><span>${esc(day(x.at))}</span><span>${esc(x.who || "")}</span></li>`).join("")}</ul>` : `<p class="empty">None.</p>`;
    const by = list => v.people ? `<p class="note">${v.people.map(n => `${esc(n)}: ${list.filter(x => x.who === n).length}`).join(" · ")}</p>` : "";
    // Oldest open month first, this month last.
    const card = (m, isCur) => `<div class="card"><h2>${esc(m.label)}</h2><div><span class="big">${m.done.length}</span><span class="of">session${m.done.length === 1 ? "" : "s"}${isCur ? " so far" : ""}</span></div>${by(m.done)}
      ${items(m.done)}${m.booked.length ? `<p class="note" style="margin-top:10px">${m.booked.length} more booked this month.</p>` : ""}</div>`;
    const ms = v.months, total = ms.reduce((a, m) => a + m.done.length, 0);
    head = (ms.length > 2 ? `<div class="card"><h2>Since ${esc(ms[0].label.replace(/ \d{4}$/, ""))}</h2><div><span class="big">${total}</span><span class="of">sessions</span></div>${by(ms.flatMap(m => m.done))}</div>` : "")
      + ms.map((m, i) => card(m, i === ms.length - 1)).join("");
    recent = "";
  }
  document.title = `${v.first}'s sessions`;
  $m.innerHTML = `<div><h1>Hi ${esc(v.first)}</h1><p class="sub">${v.trainer ? `Your training with ${esc(v.trainer)}` : "Your training"}</p></div>
    ${head}
    ${upcoming}
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
