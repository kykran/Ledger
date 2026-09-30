/* Trainer Tally adapter for the hosted web app.
 * Data: Supabase (row-level security keeps each trainer's rows private).
 * Calendar: /api/calendar, which calls Google with the trainer's stored refresh token.
 * Same contract as adapter-claude.js — see the top of app.js. */
import "./styles.css";
import "./app.js";
import { sb, api, currentSession, signInWithGoogle, storeGoogleToken, calendarCall, downloadFile, takeAuthError } from "./supabase.js";

let session = null;
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
