/* Demo adapter core: the Trainer Tally adapter contract, served from in-memory sample data.
 * Changes last until the page is reloaded. No sign-in, no network. */
import { buildDemo, listEvents, ME } from "./demo-data.js";

export function demoAdapter(){
  const D = buildDemo();
  const clone = D.clone;
  let profile = D.profile;
  let clients = D.clients;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let outbox = null; const links = {}; const signoffs = [];
  return {
    name: "demo",
    calendar: {
      async call(tool, input){
        await wait(40);
        if (tool === "list_calendars") return { calendars: clone(D.calendars) };
        if (tool === "list_events") return listEvents(D.events, input || {});
        throw Object.assign(new Error("Unknown tool"), { code: "tool_error" });
      }
    },
    async init(){ return { status: "ready", account: { email: ME, name: "Alex" } }; },
    watchProfile(cb){ setTimeout(() => cb(profile ? clone(profile) : null), 0); return () => {}; },
    watchClients(cb){ setTimeout(() => cb(clients.map(clone)), 0); return () => {}; },
    async setProfile(obj){ profile = clone(obj); },
    async setClient(id, body){ const c = { id, ...clone(body) }; const i = clients.findIndex(x => x.id === id); if (i >= 0) clients[i] = c; else clients.push(c); },
    async deleteClient(id){ clients = clients.filter(c => c.id !== id); },
    async deleteProfile(){ profile = null; },
    async saveFile({ filename, data }){
      const type = filename.endsWith(".json") ? "application/json" : "text/csv";
      const url = URL.createObjectURL(new Blob([data], { type }));
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
    outbox: {
      async list(){ if (!outbox) outbox = demoOutbox(D, profile, clients); return clone(outbox); },
      async send(id){ const r = outbox.find(x => x.id === id); if (r){ r.status = "sent"; r.sent_at = new Date().toISOString(); } return { status: "sent" }; },
      async skip(id){ const r = outbox.find(x => x.id === id); if (r) r.status = "skipped"; },
      async test(kind){ const m = demoModel(D, profile, clients); const E = globalThis.TallyEngine; const b = (kind === "monthly" ? E.monthlySummary : E.weeklySummary)(m, {});
        outbox.unshift({ id: "t" + Date.now(), kind: "test", to_email: ME, subject: "[Preview] " + b.subject, body_text: b.text, status: "sent", created_at: new Date().toISOString() }); return { status: "sent" }; }
    },
    links: {
      async get(id){ return links[id] || null; },
      async create(id){ links[id] = { token: "demo", url: "/client.html?demo=" + encodeURIComponent(id) }; return links[id]; },
      async revoke(id){ delete links[id]; }
    },
    studio: {
      url: "/demo-studio.html",
      async memberships(){ return [{ ...clone(D.membership), signoffs: clone(signoffs) }]; },
      async signOff(r){ const i = signoffs.findIndex(x => x.month === r.month); const row = { ...r, updated_at: new Date().toISOString() }; if (i >= 0) signoffs[i] = row; else signoffs.push(row); },
      async join(){ return { studioName: D.membership.studioName }; },
      async leave(){},
      async ownsStudio(){ return true; }
    }
  };
}

/* Studio demo backend: stands in for supabase.js so studio.js runs unchanged. */
export function demoStudioBackend(){
  const D = buildDemo();
  const clone = D.clone;
  const DB = {
    studios: [clone(D.studio)],
    studio_trainers: D.trainers.map(t => { const { id, ...data } = t; return { studio_id: D.studio.id, id, data }; }),
    studio_members: [{ studio_id: D.studio.id, user_id: "demo-alex", trainer_id: "alex" }],
    studio_invites: [],
    statement_confirmations: (() => { const now = new Date(), last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const k = now.getDate() >= last - 2 ? D.membership.trainer.statement.months.slice(-1)[0].month : (D.membership.trainer.statement.months.slice(-2)[0] || {}).month;
      return k ? [{ studio_id: D.studio.id, trainer_id: "alex", month: k, status: "disputed", trainer_n: null, studio_n: null, note: "I think the 14th was a cancel, not a session.", updated_at: now.toISOString() }] : []; })()
  };
  const keyOf = {
    studios: (a, b) => a.id === b.id,
    studio_trainers: (a, b) => a.studio_id === b.studio_id && a.id === b.id,
    studio_members: (a, b) => a.studio_id === b.studio_id && a.user_id === b.user_id,
    studio_invites: (a, b) => a.code === b.code
  };
  function from(name){
    const st = { op: "select", filters: [], single: false, payload: null };
    const b = {
      select(){ return b; }, order(){ return b; }, limit(){ return b; },
      eq(k, v){ st.filters.push([k, v]); return b; },
      single(){ st.single = true; return b; }, maybeSingle(){ st.single = true; return b; },
      insert(r){ st.op = "insert"; st.payload = r; return b; },
      update(r){ st.op = "update"; st.payload = r; return b; },
      upsert(r){ st.op = "upsert"; st.payload = r; return b; },
      delete(){ st.op = "delete"; return b; },
      then(res, rej){ try { res(run()); } catch (e){ if (rej) rej(e); } }
    };
    const match = r => st.filters.every(([k, v]) => r[k] === v);
    function run(){
      const T = DB[name] || (DB[name] = []);
      let rows = [];
      if (st.op === "select") rows = T.filter(match).map(clone);
      else if (st.op === "insert"){ const r = clone(st.payload); if (name === "studios" && !r.id) r.id = "demo-" + Date.now(); T.push(r); rows = [clone(r)]; }
      else if (st.op === "update"){ T.forEach(r => { if (match(r)) Object.assign(r, clone(st.payload)); }); rows = T.filter(match).map(clone); }
      else if (st.op === "upsert"){ const p = clone(st.payload); const i = T.findIndex(r => (keyOf[name] || ((a, b) => a.id === b.id))(r, p)); if (i >= 0) T[i] = p; else T.push(p); rows = [clone(p)]; }
      else if (st.op === "delete"){ for (let i = T.length - 1; i >= 0; i--) if (match(T[i])) T.splice(i, 1); }
      return { data: st.single ? (rows[0] || null) : rows, error: null };
    }
    return b;
  }
  const session = { user: { id: "demo-owner", email: "owner@harborstrength.demo" }, access_token: "demo" };
  return {
    homeUrl: "/demo.html",
    sb: { from, auth: { onAuthStateChange(){}, async signOut(){}, async getSession(){ return { data: { session } }; } } },
    async api(){ return {}; },
    async currentSession(){ return session; },
    signInWithGoogle(){}, async storeGoogleToken(){},
    async calendarCall(tool, input){
      await new Promise(r => setTimeout(r, 40));
      if (tool === "list_calendars") return { calendars: [{ id: D.studio.data.calendarId, summary: D.studio.data.name }] };
      return listEvents(D.studioEvents, input || {});
    },
    downloadFile(filename, data){
      const url = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  };
}

/* Demo helpers: run the shared engine on the sample data. */
export function demoModel(D, profile, clients){
  const E = globalThis.TallyEngine;
  const cal = Object.fromEntries(((profile && profile.calendars) || D.profile.calendars).map(c => [c.id, c]));
  const events = E.normalizeEvents(D.events.map(e => [e, cal[e.cal]]).filter(r => r[1]), profile || D.profile);
  return E.compute({ profile: profile || D.profile, clients: clients || D.clients, events, now: new Date() });
}
function demoOutbox(D, profile, clients){
  const E = globalThis.TallyEngine, M = demoModel(D, profile, clients), out = [];
  const lastSat = E.addDays(E.sow(new Date()), -2); lastSat.setHours(20, 0, 0, 0);
  const w = E.weeklySummary(M, {});
  out.push({ id: "w1", kind: "weekly", to_email: ME, subject: w.subject, body_text: w.text, status: "sent", created_at: lastSat.toISOString(), sent_at: lastSat.toISOString() });
  for (const a of E.attention(M)) if (a.kind === "renew" && a.c.email){
    const r = E.renewalEmail(M, a.c);
    out.unshift({ id: "r-" + a.c.id, kind: "renewal", client_id: a.c.id, to_email: a.c.email, subject: r.subject, body_text: r.text, status: "held", created_at: new Date().toISOString() });
  }
  return out;
}
