/* A client's private program page: their program and videos, homework logging, bodyweight and progress charts. */
import { clientProgramView, setCount, lineChart, LINECHART_CSS, videoEmbed, VIDEO_CSS, grpClass, GROUP_CSS, repsFor } from "./programs-core.js";

const $m = document.getElementById("m");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const q = new URLSearchParams(location.search);
const token = (location.pathname.match(/\/p\/([A-Za-z0-9_-]+)/) || [])[1] || q.get("t") || "";
const demo = q.get("demo");
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const fmt = d => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); };
const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
document.head.insertAdjacentHTML("beforeend", `<style>${LINECHART_CSS}${VIDEO_CSS}${GROUP_CSS}.ex.g{border-left:4px solid var(--g);padding-left:10px;margin-left:-2px}</style>`);

let V = null, demoStore = null;
const st = { prog: 0, week: null, tab: "program", open: {}, draft: {}, lift: "" };

function toast(msg){ const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
const logsFor = (pid, sid) => { const o = {}; for (const l of V.logs) if (l.p === pid && l.s === sid) o[l.r + "|" + l.n] = l; return o; };

function currentWeek(p){
  if (!p.startDate || !p.weeks.length) return 0;
  const [y, m, d] = p.startDate.split("-").map(Number);
  const i = Math.floor((Date.now() - new Date(y, m - 1, d).getTime()) / (7 * 86400000));
  return Math.max(0, Math.min(p.weeks.length - 1, i));
}

function render(){
  document.title = `${V.first}'s program`;
  const head = `<div><h1>Hi ${esc(V.first)}</h1><p class="sub">${V.trainer ? `Your program from ${esc(V.trainer)}` : "Your program"}</p></div>
    <div class="seg" role="group" aria-label="View">${[["program", "Program"], ["progress", "Progress"]].map(([k, l]) => `<button data-act="tab" data-k="${k}" aria-pressed="${st.tab === k}">${l}</button>`).join("")}</div>`;
  $m.innerHTML = head + (st.tab === "progress" ? renderProgress() : renderProgram()) + `<footer>Trainer Tally</footer>`;
}

function renderProgram(){
  if (!V.programs.length) return `<div class="card"><div class="empty">Your trainer hasn't added a program yet.</div></div>`;
  const p = V.programs[Math.min(st.prog, V.programs.length - 1)];
  if (st.week == null) st.week = currentWeek(p);
  const wk = p.weeks[Math.min(st.week, p.weeks.length - 1)];
  const pick = V.programs.length > 1 ? `<select data-act="prog" aria-label="Program">${V.programs.map((x, i) => `<option value="${i}" ${i === st.prog ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : `<h3>${esc(p.name)}</h3>`;
  const tabs = `<div class="tabs" role="tablist">${p.weeks.map((w, i) => `<button role="tab" aria-selected="${i === st.week}" data-act="week" data-i="${i}">${esc(w.label || "Week " + (i + 1))}</button>`).join("")}</div>`;
  return pick + tabs + (wk && wk.sessions.length ? wk.sessions.map(s => renderSession(p, s)).join("") : `<div class="card"><div class="empty">Nothing scheduled this week.</div></div>`);
}

function renderSession(p, s){
  const logged = logsFor(p.id, s.id), any = Object.values(logged);
  const doneOn = any.length ? any.map(l => l.date).sort().pop() : null;
  const draft = st.draft[s.id] || (st.draft[s.id] = {});
  const exs = s.rows.map(r => {
    const ex = r.exId && V.exercises[r.exId], open = st.open[s.id + r.id];
    const rx = [r.sets && r.reps ? `${esc(r.sets)} × ${esc(r.reps)}` : esc(r.reps || r.sets), r.weight ? `@ ${esc(r.weight)}` : ""].filter(Boolean).join(" ");
    let sets = "";
    if (s.homework){
      sets = `<div class="sets">${Array.from({ length: setCount(r) }, (_, k) => { const key = r.id + "|" + (k + 1), l = draft[key] || logged[key] || {};
        return `<div class="set"><span class="lbl">Set ${k + 1}</span>
          <input type="number" inputmode="numeric" placeholder="Reps${repsFor(r, k) ? " (" + repsFor(r, k) + ")" : ""}" aria-label="Set ${k + 1} reps" data-act="set" data-s="${s.id}" data-k="${esc(key)}" data-f="reps" value="${esc(l.reps ?? "")}">
          <input type="number" inputmode="decimal" step="0.5" placeholder="Weight${r.weight ? " (" + esc(r.weight) + ")" : ""}" aria-label="Set ${k + 1} weight" data-act="set" data-s="${s.id}" data-k="${esc(key)}" data-f="weight" value="${esc(l.weight ?? "")}">
          <button class="chk" data-act="done" data-s="${s.id}" data-k="${esc(key)}" aria-pressed="${!!l.done}" aria-label="Set ${k + 1} done">${CHECK}</button></div>`; }).join("")}</div>`;
    }
    return `<div class="ex${r.group ? " g " + grpClass(r.group) : ""}"><div class="ex-h"><button class="ex-name" data-act="open" data-k="${esc(s.id + r.id)}" aria-expanded="${!!open}">${r.group ? `<span class="gchip ${grpClass(r.group)}">${esc(r.group)}</span>` : ""}<span>${esc(r.name)}</span>${ex && (ex.video || ex.cues) ? `<span class="play">${ex.video ? "▶ video" : "cues"}</span>` : ""}</button><span class="rx">${rx}</span></div>
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
      ${open && ex ? `<div class="detail">${ex.video ? videoEmbed(ex.video) : ""}${ex.cues ? `<div class="note">${esc(ex.cues)}</div>` : ""}</div>` : ""}
      ${sets}</div>`;
  }).join("");
  return `<section class="card"><div class="sess-h"><h2>${esc(s.name)}</h2>${s.homework ? `<span class="badge ${doneOn ? "done" : ""}">${doneOn ? "Logged " + esc(fmt(doneOn)) : "Homework"}</span>` : doneOn ? `<span class="badge done">Done ${esc(fmt(doneOn))}</span>` : ""}</div>
    ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ""}
    ${exs || `<div class="empty">No exercises yet.</div>`}
    ${s.homework && s.rows.length ? `<div class="row"><label class="lbl" for="d-${s.id}">Date</label><input type="date" id="d-${s.id}" value="${doneOn || today()}"><button class="btn primary" data-act="save" data-s="${s.id}" style="margin-left:auto">Save workout</button></div>` : ""}
  </section>`;
}

function renderProgress(){
  const w = V.measurements.filter(m => m.weight != null).map(m => ({ date: m.date, value: m.weight }));
  const bf = V.measurements.filter(m => m.bodyFat != null).map(m => ({ date: m.date, value: m.bodyFat }));
  const H = {};
  for (const l of V.logs){ if (l.weight == null || !l.ex) continue; const day = (H[l.ex] = H[l.ex] || {}); if (!day[l.date] || l.weight > day[l.date]) day[l.date] = l.weight; }
  const names = Object.keys(H).sort((a, b) => Object.keys(H[b]).length - Object.keys(H[a]).length || a.localeCompare(b));
  if (!st.lift || !H[st.lift]) st.lift = names[0] || "";
  const lift = st.lift ? Object.entries(H[st.lift]).map(([date, value]) => ({ date, value })) : [];
  return `<section class="card"><h3>Log your weight</h3>
      <div class="row"><input type="number" id="bw" inputmode="decimal" step="0.1" placeholder="Weight" style="width:120px"><input type="date" id="bw-d" value="${today()}"><button class="btn primary" data-act="bw">Save</button></div></section>
    <section class="card"><div class="sess-h"><h2>Bodyweight</h2><span class="muted small">${w.length ? "latest " + w[w.length - 1].value : ""}</span></div>${lineChart(w)}</section>
    ${bf.length ? `<section class="card"><div class="sess-h"><h2>Body fat</h2><span class="muted small">latest ${bf[bf.length - 1].value}%</span></div>${lineChart(bf, { unit: "%" })}</section>` : ""}
    <section class="card"><div class="sess-h"><h2>Lifts</h2>${names.length ? `<select data-act="lift" aria-label="Exercise">${names.map(n => `<option ${n === st.lift ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>` : ""}</div>
      ${names.length ? lineChart(lift) + `<p class="muted small" style="margin:0">Heaviest set each day.</p>` : `<div class="empty">Weights you log show up here.</div>`}</section>`;
}

/* ---------- actions ---------- */
async function post(body){
  if (demo){ demoPost(body); return { ok: true }; }
  const r = await fetch("/api/program", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: token, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || "Couldn't save.");
  return j;
}
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el || !V) return;
  const a = el.getAttribute("data-act");
  if (a === "tab"){ st.tab = el.getAttribute("data-k"); render(); }
  else if (a === "week"){ st.week = +el.getAttribute("data-i"); render(); }
  else if (a === "open"){ const k = el.getAttribute("data-k"); st.open[k] = !st.open[k]; render(); }
  else if (a === "done"){ const s = el.getAttribute("data-s"), k = el.getAttribute("data-k"); const d = (st.draft[s][k] = st.draft[s][k] || { ...(logsFor(V.programs[st.prog].id, s)[k] || {}) }); d.done = !d.done; el.setAttribute("aria-pressed", String(d.done)); }
  else if (a === "save"){
    const sid = el.getAttribute("data-s"), p = V.programs[st.prog], d = st.draft[sid] || {};
    const sets = Object.entries(d).map(([k, v]) => { const [row_id, n] = k.split("|"); return { row_id, set_no: +n, reps: v.reps ?? null, weight: v.weight ?? null, done: !!v.done || (v.reps != null && v.reps !== "") }; });
    if (!sets.length){ toast("Fill in a set first"); return; }
    el.disabled = true; el.textContent = "Saving…";
    try { await post({ action: "log", program_id: p.id, session_id: sid, logged_on: document.getElementById("d-" + sid).value, sets }); st.draft[sid] = {}; toast("Workout saved. Nice work!"); await load(true); }
    catch (x){ toast(x.message); el.disabled = false; el.textContent = "Save workout"; }
  }
  else if (a === "bw"){
    const w = parseFloat(document.getElementById("bw").value); if (!isFinite(w)){ toast("Enter your weight"); return; }
    el.disabled = true;
    try { await post({ action: "weight", weight: w, taken_on: document.getElementById("bw-d").value }); toast("Saved"); await load(true); } catch (x){ toast(x.message); el.disabled = false; }
  }
});
document.addEventListener("input", e => {
  const el = e.target; if (el.getAttribute("data-act") !== "set") return;
  const s = el.getAttribute("data-s"), k = el.getAttribute("data-k");
  const d = (st.draft[s][k] = st.draft[s][k] || { ...(logsFor(V.programs[st.prog].id, s)[k] || {}) });
  d[el.getAttribute("data-f")] = el.value === "" ? null : Number(el.value);
});
document.addEventListener("change", e => {
  const a = e.target.getAttribute("data-act");
  if (a === "prog"){ st.prog = +e.target.value; st.week = null; render(); }
  if (a === "lift"){ st.lift = e.target.value; render(); }
});

/* ---------- load ---------- */
async function load(quiet){
  if (demo){
    if (!demoStore){ const { buildProgramsDemo } = await import("./programs-demo.js"); demoStore = buildProgramsDemo(); }
    V = clientProgramView({ client: { name: "Maya Chen", sex: "female", birthYear: new Date().getFullYear() - 34 }, trainerName: "Alex", programs: demoStore.programs.filter(p => p.clientId === demo), exercises: demoStore.exercises, logs: demoStore.logs, measurements: demoStore.measurements });
    return render();
  }
  try {
    const r = await fetch("/api/program?t=" + encodeURIComponent(token));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "Couldn't load this page.");
    V = j; render();
  } catch (x){ if (!quiet) $m.innerHTML = `<div class="card"><h1 style="font-size:18px">Can't show this page</h1><p class="note">${esc(x.message)}</p></div>`; else toast(x.message); }
}
function demoPost(b){
  if (b.action === "weight") demoStore.measurements.push({ id: "c" + Date.now(), client_id: demo, taken_on: b.taken_on, weight: b.weight, source: "client" });
  if (b.action === "log") for (const s of b.sets){ const row = { program_id: b.program_id, session_id: b.session_id, row_id: s.row_id, set_no: s.set_no, client_id: demo, reps: s.reps, weight: s.weight, done: s.done, logged_on: b.logged_on, source: "client",
    ex_name: (() => { for (const p of demoStore.programs) for (const w of p.weeks) for (const x of w.sessions) for (const r of x.rows) if (r.id === s.row_id) return r.name; return ""; })() };
    const i = demoStore.logs.findIndex(l => l.program_id === row.program_id && l.session_id === row.session_id && l.row_id === row.row_id && l.set_no === row.set_no); if (i >= 0) demoStore.logs[i] = row; else demoStore.logs.push(row); }
}
load();
