/* The "sessions left" cards a client sees: on their sessions page (/s/<token>) and the Sessions tab of their program page (/p/<token>). Read-only, no prices. */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
/* opts.tap: each date is a button (data-act="flag") so the client can question it; opts.flags maps a date to its flag;
 * opts.due: a card at the top saying whether a package (or payment) is due. Never an amount. */
export function sessionCards(v, opts = {}){
  const tz = v.timeZone || undefined;
  const day = iso => new Date(iso).toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric", timeZone: tz});
  const time = iso => new Date(iso).toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit", timeZone: tz});
  const flags = opts.flags || {};
  const fchip = iso => { const f = flags[iso]; return f ? ` <span class="due ${f.resolved ? "paid" : ""}">${f.resolved ? "sorted" : "flagged"}</span>` : ""; };
  const li = (iso, cls, left, right) => opts.tap
    ? `<li class="tap ${cls}"><button data-act="flag" data-at="${esc(iso)}" aria-label="${esc(day(iso))}. Tap if something's wrong"><span>${left}</span><span>${right}${fchip(iso)}</span></button></li>`
    : `<li class="${cls}"><span>${left}</span><span>${right}</span></li>`;
  const rows = (list, withTime) => list.length ? `<ul>${list.map(i => li(i, "", esc(day(i)), withTime ? esc(time(i)) : "")).join("")}</ul>` : `<p class="empty">None yet.</p>`;
  let head;
  if (v.billing === "package" && v.size){
    const pct = Math.min(100, Math.round(v.used / v.size * 100));
    const shared = v.people && v.people.length > 1 ? `<p class="note" style="margin:0 0 8px">Shared package: ${esc(v.people.join(" and "))}</p>` : "";
    head = `<div class="card"><h2>Sessions left</h2>${shared}<div><span class="big">${v.left}</span><span class="of">of ${v.size}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${(n => n ? `<p class="note warn" style="margin-bottom:4px">${n} package${n === 1 ? "" : "s"} not paid yet. Every session is listed below.</p>` : "")((v.owed || []).filter(O => !O.paid).length + (v.owed && v.owed.length && v.pack && v.pack.unpaid ? 1 : 0))}
      <p class="note ${v.left <= 2 ? "warn" : ""}">${v.over ? `${v.over} session${v.over === 1 ? "" : "s"} past this package. Time to renew.` : v.left === 0 ? "Package used up. Time to renew." : v.runout ? `At your current schedule, your last session is around ${esc(day(v.runout))}.` : `${v.used} used so far.`}</p></div>`;
  } else {
    head = `<div class="card"><h2>This month</h2><div><span class="big">${v.thisMonth || 0}</span><span class="of">${v.included ? `of ${v.included} included` : "sessions so far"}</span></div>
      <p class="note" style="margin-top:10px">${v.bookedThisMonth ? `${v.bookedThisMonth} more booked this month.` : "No more booked this month."}</p></div>`;
  }
  let recent = `<div class="card"><h2>${v.packSessions ? "Sessions this package" : "Recent sessions"}</h2>${rows(v.recent, false)}</div>`;
  let upcoming = `<div class="card"><h2>Coming up</h2>${rows(v.next, true)}</div>`;
  if (v.pack){
    // Package clients: every session numbered 1..size, then what counts toward the next package.
    // On a shared package, each line says whose session it was.
    const who = iso => v.who && v.who[iso] ? `${esc(v.who[iso])} · ` : "";
    const line = (iso, n, booked) => li(iso, booked ? "bk" : "", `<b class="n">${n}</b>${esc(day(iso))}`, `${who(iso)}${booked ? `booked · ${esc(time(iso))}` : "done"}`);
    const P = v.pack, done = P.done.length + (P.uncounted || 0), fmtRange = a => a.length ? `${esc(day(a[0]).replace(/^\w+, /, ""))} – ${esc(day(a[a.length - 1]).replace(/^\w+, /, ""))}` : "";
    const all = [...P.done, ...P.booked];
    // Earlier packages (not paid yet, or paid ones the trainer chose to show): every session, numbered, oldest package first.
    const owed = v.owed || [], unpaidTag = `<span class="due">not paid yet</span>`;
    const owedCards = owed.map((O, k) => { const n0 = O.uncounted || 0;
      return `<div class="card"><h2>Package ${k + 1} · ${O.size} sessions ${O.paid ? `<span class="due paid">${esc(O.paid)}</span>` : unpaidTag}</h2><p class="note">${fmtRange(O.done)} · ${O.done.length + n0} done</p>
      <ul class="num">${n0 ? `<li><span><b class="n">1–${n0}</b>Earlier sessions</span><span>done</span></li>` : ""}${O.done.map((d, i) => line(d, i + 1 + n0, false)).join("")}</ul></div>`; }).join("");
    recent = owedCards + `<div class="card"><h2>${owed.length ? `Package ${owed.length + 1}` : "This package"} · ${P.size} sessions${P.unpaid ? " " + unpaidTag : ""}</h2><p class="note">${fmtRange(all)}${P.done.length ? ` · ${Math.min(done, P.size)} done` : ""}${P.booked.length ? ` · ${P.booked.length} booked` : ""}</p>
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
    const items = list => list.length ? `<ul>${list.map(x => li(x.at, "", esc(day(x.at)), esc(x.who || ""))).join("")}</ul>` : `<p class="empty">None.</p>`;
    const by = list => v.people ? `<p class="note">${v.people.map(n => `${esc(n)}: ${list.filter(x => x.who === n).length}`).join(" · ")}</p>` : "";
    // Oldest open month first, this month last.
    const card = (m, isCur) => `<div class="card"><h2>${esc(m.label)}</h2><div><span class="big">${m.done.length}</span><span class="of">session${m.done.length === 1 ? "" : "s"}${isCur ? " so far" : ""}</span></div>${by(m.done)}
      ${items(m.done)}${m.booked.length ? `<p class="note" style="margin-top:10px">${m.booked.length} more booked this month.</p>` : ""}</div>`;
    const ms = v.months, total = ms.reduce((a, m) => a + m.done.length, 0);
    head = (ms.length > 2 ? `<div class="card"><h2>Since ${esc(ms[0].label.replace(/ \d{4}$/, ""))}</h2><div><span class="big">${total}</span><span class="of">sessions</span></div>${by(ms.flatMap(m => m.done))}</div>` : "")
      + ms.map((m, i) => card(m, i === ms.length - 1)).join("");
    recent = "";
  }
  const due = opts.due && v.due != null ? `<div class="card duecard ${v.due ? "is-due" : ""}"><b>${v.due ? (v.billing === "package" ? "Package due" : "Payment due") : "All paid up"}</b><span class="note">${v.due ? `${esc(v.trainer || "Your trainer")} will sort out payment with you.` : "Nothing due right now."}</span></div>` : "";
  return due + head + upcoming + recent;
}
/* One line for the top of the program page: "11 of 24 sessions left · next Thu Oct 29, 7:00 AM". */
export function sessionsLine(v){
  const tz = v.timeZone || undefined;
  const when = iso => new Date(iso).toLocaleString("en-US", {weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZone: tz});
  const a = v.billing === "package" && v.size ? (v.over ? `${v.over} past your ${v.size}-pack · time to renew` : `${v.left} of ${v.size} sessions left`)
    : v.months ? `${(v.months[v.months.length - 1] || { done: [] }).done.length} sessions this month` : `${v.thisMonth || 0} sessions this month`;
  return { text: a, next: v.next && v.next.length ? when(v.next[0]) : "", due: !!v.due, warn: !!(v.due || v.over || (v.size && v.left <= 2)) };
}
