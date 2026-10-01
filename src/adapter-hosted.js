/* Trainer Tally adapter for the hosted web app.
 * Data: Supabase (row-level security keeps each trainer's rows private).
 * Calendar: /api/calendar, which calls Google with the trainer's stored refresh token.
 * Same contract as adapter-claude.js — see the top of app.js. */
import "./styles.css";
import "./engine-global.js";
import "./app.js";
import { sb, api, currentSession, signInWithGoogle, storeGoogleToken, calendarCall, downloadFile, takeAuthError } from "./supabase.js";

let session = null;
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

const adapter = {
  name: "hosted",
  calendar: { call: calendarCall },
  async init(){
    const authError = takeAuthError();
    session = await currentSession();
    if (!session) return { status: "signin", error: authError };
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
    const load = async () => { const { data, error } = await sb.from("profiles").select("data").eq("user_id", uid).maybeSingle(); if (error) return onErr && onErr(fail(error)); cb(data ? data.data : null); };
    load();
    const ch = sb.channel("profile-" + uid).on("postgres_changes", { event:"*", schema:"public", table:"profiles", filter:"user_id=eq." + uid }, load).subscribe();
    return () => sb.removeChannel(ch);
  },
  watchClients(cb, onErr){
    const uid = session.user.id;
    const load = async () => { const { data, error } = await sb.from("clients").select("id,data").eq("user_id", uid); if (error) return onErr && onErr(fail(error)); cb((data || []).map(r => ({ id: r.id, ...r.data }))); };
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
        if (st) out.push({ studioId: st.id, studioName: (st.data && st.data.name) || "Studio", trainer: tr ? { id: tr.id, ...tr.data } : null });
      }
      return out;
    },
    async join(code){ return api("/api/studio/join", { code }); },
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

window.TrainerTally.start(adapter);
