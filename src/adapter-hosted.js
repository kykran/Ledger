/* Trainer Tally adapter for the hosted web app.
 * Data: Supabase (row-level security keeps each trainer's rows private).
 * Calendar: /api/calendar, which calls Google with the trainer's stored refresh token.
 * Same contract as adapter-claude.js — see the top of app.js. */
import "./styles.css";
import "./app.js";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
let session = null;

const fail = (error) => { const e = new Error(error && error.message || "Request failed"); e.code = error && (error.code === "42501" ? "invalid_argument" : "unavailable"); return e; };
async function token(){ const { data } = await sb.auth.getSession(); session = data.session; return session ? session.access_token : null; }
async function api(path, body){
  const t = await token();
  const r = await fetch(path, { method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer " + t }, body: JSON.stringify(body || {}) });
  let j = {}; try { j = await r.json(); } catch(e){}
  if (!r.ok){ const e = new Error(j.message || ("HTTP " + r.status)); e.code = j.code || (r.status >= 500 ? "server_unavailable" : "tool_error"); throw e; }
  return j;
}

// Small cache so the app's month-by-month reads don't hit Google twice within 5 minutes.
const cache = new Map();
const TTL = 5 * 60 * 1000;

const adapter = {
  name: "hosted",
  calendar: {
    async call(tool, input, opts){
      const key = tool + ":" + JSON.stringify(input);
      const hit = cache.get(key);
      if (hit && !(opts && opts.refresh) && Date.now() - hit.at < TTL) return hit.data;
      const data = await api("/api/calendar", { tool, input });
      cache.set(key, { at: Date.now(), data });
      return data;
    }
  },
  async init(){
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (!session) return { status: "signin" };
    // Right after Google sign-in, hand the long-lived Google token to the server once.
    if (session.provider_refresh_token){
      try { await api("/api/auth/store-token", { refresh_token: session.provider_refresh_token }); } catch(e){ console.warn("Couldn't store Google token", e); }
    }
    sb.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_OUT") location.reload(); });
    const u = session.user;
    return { status: "ready", account: { email: u.email, name: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name) || "").split(" ")[0] } };
  },
  signIn(){
    return sb.auth.signInWithOAuth({ provider: "google", options: {
      scopes: CAL_SCOPE, redirectTo: location.origin,
      queryParams: { access_type: "offline", prompt: "consent" }
    }});
  },
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

  async saveFile({ filename, data }){
    const type = filename.endsWith(".json") ? "application/json" : "text/csv";
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
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
