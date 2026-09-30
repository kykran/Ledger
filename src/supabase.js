/* Shared Supabase client + small API helper for the hosted app's pages (trainer and studio). */
import { createClient } from "@supabase/supabase-js";

export const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
export const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export async function currentSession(){ const { data } = await sb.auth.getSession(); return data.session; }

export async function api(path, body){
  const s = await currentSession();
  const r = await fetch(path, { method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer " + (s ? s.access_token : "") }, body: JSON.stringify(body || {}) });
  let j = {}; try { j = await r.json(); } catch(e){}
  if (!r.ok){ const e = new Error(j.message || ("HTTP " + r.status)); e.code = j.code || (r.status >= 500 ? "server_unavailable" : "tool_error"); throw e; }
  return j;
}

export function signInWithGoogle(returnPath){
  return sb.auth.signInWithOAuth({ provider: "google", options: {
    scopes: CAL_SCOPE, redirectTo: location.origin + (returnPath || "/"),
    queryParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" }
  }});
}

// If Google sent the user back with an error (e.g. an approval page reused with Back), read and clear it.
export function takeAuthError(){
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const code = q.get("error_code") || h.get("error_code") || q.get("error") || h.get("error");
  if (!code) return null;
  const desc = q.get("error_description") || h.get("error_description") || "";
  history.replaceState(null, "", location.pathname);
  if (/state/i.test(code + desc)) return "That Google approval page had expired, usually from going back to it. Press Continue with Google once more and approve on the fresh page.";
  if (/access_denied/i.test(code)) return "Google sign-in was cancelled. Press Continue with Google to try again.";
  return "Google sign-in didn't finish" + (desc ? ": " + desc.replace(/\+/g, " ") : ".") + " Press Continue with Google to try again.";
}

// Right after Google sign-in, hand the long-lived Google token to the server once.
export async function storeGoogleToken(session){
  if (session && session.provider_refresh_token){
    try { await api("/api/auth/store-token", { refresh_token: session.provider_refresh_token }); } catch(e){ console.warn("Couldn't store Google token", e); }
  }
}

// Calendar reads with a 5-minute cache so month-by-month loads don't hit Google twice.
const cache = new Map();
export async function calendarCall(tool, input, opts){
  const key = tool + ":" + JSON.stringify(input);
  const hit = cache.get(key);
  if (hit && !(opts && opts.refresh) && Date.now() - hit.at < 300000) return hit.data;
  const data = await api("/api/calendar", { tool, input });
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function downloadFile(filename, data){
  const type = filename.endsWith(".json") ? "application/json" : "text/csv";
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
