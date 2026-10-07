/* Trainer Tally hosted adapter: Supabase data + Google Calendar proxy. Shared by the full app and the standalone Programs page.
 * Same contract as adapter-claude.js — see the top of app.js. */
import { sb, api, currentSession, signInWithGoogle, storeGoogleToken, calendarCall, downloadFile, takeAuthError } from "./supabase.js";

let session = null;
// A request can be turned away if the sign-in token expired while the tab was closed.
// Refresh the token and try again before telling the app anything failed.
const authErr = e => e && (e.code === "PGRST301" || e.code === "PGRST303" || /jwt|expired|401/i.test(String(e.message || "") + (e.status || "")));
async function query(run){
  let last;
  for (let i = 0; i < 3; i++){
    const r = await run();
    if (!r.error) return r;
    last = r.error;
    if (authErr(r.error) || i === 0){ try { const { data } = await sb.auth.refreshSession(); if (data && data.session) session = data.session; } catch(e){} }
    await new Promise(res => setTimeout(res, 400 * (i + 1)));
  }
  return { data: null, error: last };
}
async function currentProfile(){ const { data } = await sb.from("profiles").select("data").eq("user_id", session.user.id).maybeSingle(); return data && data.data; }
async function readRows(uid, cals){
  const byId = Object.fromEntries(cals.map(c => [c.id, c])), rows = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await sb.from("calendar_events").select("calendar_id,data").eq("user_id", uid).in("calendar_id", cals.map(c => c.id)).order("start_at").range(from, from + 999);
    if (error) throw fail(error);
    for (const r of data) rows.push([r.data, byId[r.calendar_id]]);
    if (data.length < 1000) break;
  }
  return rows;
}
const fail = (error) => { const e = new Error(error && error.message || "Request failed"); e.code = error && (error.code === "42501" ? "invalid_argument" : "unavailable"); return e; };

export const adapter = {
  name: "hosted",
  calendar: { call: calendarCall },
  async init(){
    const authError = takeAuthError();
    session = await currentSession();
    if (!session) return { status: "signin", error: authError };
    if (session.expires_at && session.expires_at * 1000 < Date.now() + 60000){ try { const { data } = await sb.auth.refreshSession(); if (data && data.session) session = data.session; } catch(e){} }
    await storeGoogleToken(session);
    sb.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_OUT") location.reload(); });
    const u = session.user;
    return { status: "ready", account: { email: u.email, name: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name) || "").split(" ")[0] } };
  },
  signIn(){ return signInWithGoogle("/"); },
  grantCalendar(){ return signInWithGoogle(location.pathname); },
  async signOut(){ await sb.auth.signOut(); },

  watchProfile(cb, onErr){
    const uid = session.user.id;
    const load = async () => { const { data, error } = await query(() => sb.from("profiles").select("data").eq("user_id", uid).maybeSingle()); if (error) return onErr && onErr(fail(error)); cb(data ? data.data : null); };
    load();
    const ch = sb.channel("profile-" + uid).on("postgres_changes", { event:"*", schema:"public", table:"profiles", filter:"user_id=eq." + uid }, load).subscribe();
    return () => sb.removeChannel(ch);
  },
  watchClients(cb, onErr){
    const uid = session.user.id;
    const load = async () => { const { data, error } = await query(() => sb.from("clients").select("id,data").eq("user_id", uid)); if (error) return onErr && onErr(fail(error)); cb((data || []).map(r => ({ id: r.id, ...r.data }))); };
    load();
    let t; const soon = () => { clearTimeout(t); t = setTimeout(load, 400); };
    const ch = sb.channel("clients-" + uid).on("postgres_changes", { event:"*", schema:"public", table:"clients", filter:"user_id=eq." + uid }, soon).subscribe();
    return () => sb.removeChannel(ch);
  },
  async setProfile(obj){ const { error } = await sb.from("profiles").upsert({ user_id: session.user.id, data: obj, updated_at: new Date().toISOString() }); if (error) throw fail(error); },
  async setClient(id, body){ const { error } = await sb.from("clients").upsert({ user_id: session.user.id, id, data: body, updated_at: new Date().toISOString() }); if (error) throw fail(error); },
  async deleteClient(id){ const { error } = await sb.from("clients").delete().eq("user_id", session.user.id).eq("id", id); if (error) throw fail(error); },
  async deleteProfile(){ const { error } = await sb.from("profiles").delete().eq("user_id", session.user.id); if (error) throw fail(error); },

  async saveFile({ filename, data }){ downloadFile(filename, data); },

  // Sessions come from the background sync (calendar_events), so the app opens without waiting on Google.
  events: {
    async load({ refresh, full, onUpdate } = {}){
      const uid = session.user.id;
      const profile = await currentProfile();
      const cals = ((profile && profile.calendars) || []).filter(c => c.use);
      if (!cals.length) return [];
      const { data: st, error: stErr } = await sb.from("calendar_sync").select("calendar_id,last_synced_at,synced_from").eq("user_id", uid);
      if (stErr) return null; // tables not there yet: read Google directly
      const syncedAt = Object.fromEntries((st || []).map(r => [r.calendar_id, r.last_synced_at ? new Date(r.last_synced_at).getTime() : 0]));
      const oldest = Math.min(...cals.map(c => syncedAt[c.id] || 0));
      const never = oldest === 0;
      const stale = Date.now() - oldest > 20 * 60000;
      const sync = () => api("/api/sync", { full: !!full });
      if (refresh || never){ await sync(); return readRows(uid, cals); }
      const rows = await readRows(uid, cals);
      if (stale && onUpdate) sync().then(() => readRows(uid, cals)).then(onUpdate).catch(() => {});
      return rows;
    }
  },

  outbox: {
    async list(){ const { data } = await sb.from("outbox").select("id,kind,client_id,to_email,subject,body_text,status,error,created_at,sent_at").eq("user_id", session.user.id).order("created_at", { ascending: false }).limit(30); return data || []; },
    send(id){ return api("/api/outbox", { action: "send", id }); },
    async skip(id){ const { error } = await sb.from("outbox").update({ status: "skipped" }).eq("id", id); if (error) throw fail(error); },
    test(kind){ return api("/api/outbox", { action: "test", kind }); }
  },

  // Programs: exercise library, client programs, set logs, measurements, private program links.
  programs: {
    async ready(){
      const { error } = await sb.from("exercises").select("id").limit(1);
      if (!error) return { ok: true };
      return { ok: false, code: /does not exist|schema cache|42P01|PGRST205/i.test((error.message || "") + (error.code || "")) ? "not_setup" : "unavailable" };
    },
    async listExercises(){ const { data, error } = await query(() => sb.from("exercises").select("id,data").eq("user_id", session.user.id)); if (error) throw fail(error); return (data || []).map(r => ({ id: r.id, ...r.data })); },
    async saveExercises(list){ const now = new Date().toISOString(); const { error } = await sb.from("exercises").upsert(list.map(({ id, ...d }) => ({ user_id: session.user.id, id, data: d, updated_at: now }))); if (error) throw fail(error); },
    async deleteExercise(id){ const { error } = await sb.from("exercises").delete().eq("user_id", session.user.id).eq("id", id); if (error) throw fail(error); },
    async uploadVideo(file){
      const ext = (file.name.match(/\.[a-z0-9]+$/i) || [".mp4"])[0].toLowerCase();
      const path = session.user.id + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + ext;
      const { error } = await sb.storage.from("exercise-videos").upload(path, file, { contentType: file.type || "video/mp4", upsert: false });
      if (error) throw fail(error);
      return { path };
    },
    async videoUrl(path){ const { data, error } = await sb.storage.from("exercise-videos").createSignedUrl(path, 3600); if (error) throw fail(error); return data.signedUrl; },
    async deleteVideo(path){ await sb.storage.from("exercise-videos").remove([path]); },
    async listPrograms(){ const { data, error } = await query(() => sb.from("programs").select("id,client_id,data,updated_at").eq("user_id", session.user.id)); if (error) throw fail(error); return (data || []).map(r => ({ ...r.data, id: r.id, clientId: r.client_id, updatedAt: r.updated_at })); },
    async saveProgram(p){
      const { id, updatedAt, ownerId, ownerName, shared, ...d } = p, now = new Date().toISOString();
      // A program someone shared with me lives under their account: update it in place.
      const { error } = shared
        ? await sb.from("programs").update({ data: d, updated_at: now }).eq("user_id", ownerId).eq("id", id)
        : await sb.from("programs").upsert({ user_id: session.user.id, id, client_id: d.clientId, data: d, updated_at: now });
      if (error) throw fail(error);
    },
    async deleteProgram(id){ const uid = session.user.id; const { error } = await sb.from("programs").delete().eq("user_id", uid).eq("id", id); if (error) throw fail(error); await sb.from("program_logs").delete().eq("user_id", uid).eq("program_id", id); },
    async logs(clientId){ const { data, error } = await query(() => sb.from("program_logs").select("*").eq("user_id", session.user.id).eq("client_id", clientId).order("logged_on")); if (error) throw fail(error); return data || []; },
    async saveLogs(rows, ownerId){ if (!rows.length) return; const uid = ownerId || session.user.id, now = new Date().toISOString(); const { error } = await sb.from("program_logs").upsert(rows.map(r => ({ ...r, user_id: uid, source: "trainer", updated_at: now }))); if (error) throw fail(error); },
    async programLogs(ownerId, programId){ const { data, error } = await query(() => sb.from("program_logs").select("*").eq("user_id", ownerId).eq("program_id", programId).order("logged_on")); if (error) throw fail(error); return data || []; },
    // Which days each client has anything logged (for the "workout not logged" to-do).
    async logDates(){ const { data, error } = await sb.from("program_logs").select("client_id,logged_on").eq("user_id", session.user.id).gte("logged_on", new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)); if (error) throw fail(error); return data || []; },
    ai(body){ return api("/api/ai", body); },
    voice(body){ return api("/api/voice", body); },
    emailWorkout(body){ return api("/api/outbox", { action: "workout", ...body }); },
    sharing: {
      async ready(){ const { error } = await sb.from("program_shares").select("program_id").limit(1); return !error; },
      async list(programId){ const { data, error } = await sb.from("program_shares").select("shared_email,created_at").eq("owner_id", session.user.id).eq("program_id", programId); if (error) throw fail(error); return data || []; },
      async add(p, email, clientName, ownerName){ const { error } = await sb.from("program_shares").upsert({ owner_id: session.user.id, program_id: p.id, shared_email: email.trim().toLowerCase(), client_id: p.clientId, client_name: clientName, program_name: p.name || "", owner_name: ownerName || "" }); if (error) throw fail(error); },
      async remove(programId, email){ const { error } = await sb.from("program_shares").delete().eq("owner_id", session.user.id).eq("program_id", programId).eq("shared_email", email); if (error) throw fail(error); },
      // Programs other trainers shared with me, plus the exercises they use.
      async withMe(){
        const me = (session.user.email || "").toLowerCase();
        const { data: sh, error } = await sb.from("program_shares").select("*").ilike("shared_email", me);
        if (error) throw fail(error);
        const programs = [], exercises = [];
        for (const s of sh || []){
          const { data } = await sb.from("programs").select("id,client_id,data,updated_at").eq("user_id", s.owner_id).eq("id", s.program_id).maybeSingle();
          if (data) programs.push({ ...data.data, id: data.id, clientId: data.client_id, updatedAt: data.updated_at, ownerId: s.owner_id, ownerName: s.owner_name, shared: true, clientName: s.client_name });
        }
        for (const owner of [...new Set((sh || []).map(s => s.owner_id))]){
          const { data } = await sb.from("exercises").select("id,data").eq("user_id", owner);
          for (const r of data || []) exercises.push({ id: r.id, ...r.data, ownerId: owner });
        }
        return { programs, exercises };
      },
      async leave(ownerId, programId){ const me = (session.user.email || "").toLowerCase(); await sb.from("program_shares").delete().eq("owner_id", ownerId).eq("program_id", programId).ilike("shared_email", me); }
    },
    async measurements(clientId){ const { data, error } = await query(() => sb.from("measurements").select("*").eq("user_id", session.user.id).eq("client_id", clientId).order("taken_on")); if (error) throw fail(error); return data || []; },
    async saveMeasurement(m){ const row = { ...m, user_id: session.user.id }; if (!row.id) delete row.id; const { error } = await sb.from("measurements").upsert(row); if (error) throw fail(error); },
    async deleteMeasurement(id){ const { error } = await sb.from("measurements").delete().eq("user_id", session.user.id).eq("id", id); if (error) throw fail(error); },
    link: {
      url: t => location.origin + "/p/" + t,
      async get(clientId){
        const { data } = await sb.from("program_links").select("token").eq("user_id", session.user.id).eq("client_id", clientId).is("revoked_at", null).order("created_at", { ascending: false }).limit(1);
        return data && data[0] ? { token: data[0].token, url: adapter.programs.link.url(data[0].token) } : null;
      },
      async create(clientId){
        const b = crypto.getRandomValues(new Uint8Array(18));
        const token = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const { error } = await sb.from("program_links").insert({ token, user_id: session.user.id, client_id: clientId });
        if (error) throw fail(error);
        return { token, url: adapter.programs.link.url(token) };
      },
      async revoke(clientId){ const { error } = await sb.from("program_links").update({ revoked_at: new Date().toISOString() }).eq("user_id", session.user.id).eq("client_id", clientId).is("revoked_at", null); if (error) throw fail(error); }
    }
  },

  // Private read-only "sessions left" pages for clients.
  links: {
    url: t => location.origin + "/s/" + t,
    async get(clientId){
      const { data } = await sb.from("client_links").select("token").eq("user_id", session.user.id).eq("client_id", clientId).is("revoked_at", null).order("created_at", { ascending: false }).limit(1);
      return data && data[0] ? { token: data[0].token, url: adapter.links.url(data[0].token) } : null;
    },
    async create(clientId){
      const b = crypto.getRandomValues(new Uint8Array(18));
      const token = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const { error } = await sb.from("client_links").insert({ token, user_id: session.user.id, client_id: clientId });
      if (error) throw fail(error);
      return { token, url: adapter.links.url(token) };
    },
    async revoke(clientId){ const { error } = await sb.from("client_links").update({ revoked_at: new Date().toISOString() }).eq("user_id", session.user.id).eq("client_id", clientId).is("revoked_at", null); if (error) throw fail(error); }
  },

  // Studios this trainer has joined, with the statement the studio's owner computed for them.
  studio: {
    url: "/studio.html",
    async memberships(){
      const { data: mem, error } = await sb.from("studio_members").select("studio_id,trainer_id").eq("user_id", session.user.id);
      if (error || !mem || !mem.length) return [];
      const out = [];
      for (const m of mem){
        const [{ data: st }, { data: tr }] = await Promise.all([
          sb.from("studios").select("id,data").eq("id", m.studio_id).maybeSingle(),
          sb.from("studio_trainers").select("id,data").eq("studio_id", m.studio_id).eq("id", m.trainer_id).maybeSingle()
        ]);
        const { data: so } = await sb.from("statement_confirmations").select("month,status,note,trainer_n,studio_n,studio_rent,updated_at").eq("studio_id", m.studio_id).eq("trainer_id", m.trainer_id);
        if (st) out.push({ studioId: st.id, studioName: (st.data && st.data.name) || "Studio", trainer: tr ? { id: tr.id, ...tr.data } : null, signoffs: so || [] });
      }
      return out;
    },
    async join(code){ return api("/api/studio/join", { code }); },
    async signOff({ studioId, trainerId, month, status, note, studio_n, studio_rent, trainer_n }){
      const { error } = await sb.from("statement_confirmations").upsert({ studio_id: studioId, trainer_id: trainerId, month, status, note, studio_n, studio_rent, trainer_n, user_id: session.user.id, updated_at: new Date().toISOString() });
      if (error) throw Object.assign(fail(error), { message: error.code === "42501" ? "That month is already confirmed. Ask the studio to reopen it." : error.message });
    },
    async leave(studioId){ const { error } = await sb.from("studio_members").delete().eq("studio_id", studioId).eq("user_id", session.user.id); if (error) throw fail(error); },
    async ownsStudio(){ const { data } = await sb.from("studios").select("id").eq("owner_id", session.user.id).limit(1); return !!(data && data.length); }
  },

  billing: import.meta.env.VITE_BILLING_ENABLED === "true" ? {
    async status(){
      const { data } = await sb.from("subscriptions").select("status,current_period_end,cancel_at_period_end").eq("user_id", session.user.id).maybeSingle();
      const st = data && data.status;
      const end = data && data.current_period_end ? new Date(data.current_period_end).toLocaleDateString(undefined, { month:"short", day:"numeric" }) : "";
      if (st === "past_due") return { plan: "active", label: "Payment failed · update your card" };
      if (st === "active" || st === "trialing"){
        if (data.cancel_at_period_end) return { plan: "active", label: `Cancels ${end}` };
        return { plan: "active", label: `Subscribed · $3/month${end ? " · renews " + end : ""}` };
      }
      return { plan: "none", label: "Free trial" };
    },
    async checkout(){ const { url } = await api("/api/billing/checkout"); location.href = url; },
    async portal(){ const { url } = await api("/api/billing/portal"); location.href = url; }
  } : undefined
};

export default adapter;
