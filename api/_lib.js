// Shared server helpers (files starting with _ are not routes on Vercel).
import { createClient } from "@supabase/supabase-js";

export const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

export function send(res, status, body){
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export async function readJson(req){
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// Returns the signed-in Supabase user, or null.
export async function userFrom(req){
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

// Trial / subscription gate. Off unless REQUIRE_SUBSCRIPTION=true.
export async function hasAccess(user){
  if (process.env.REQUIRE_SUBSCRIPTION !== "true") return true;
  const trialDays = Number(process.env.TRIAL_DAYS || 14);
  if (Date.now() - new Date(user.created_at).getTime() < trialDays * 86400000) return true;
  const { data } = await admin.from("subscriptions").select("access_until").eq("user_id", user.id).maybeSingle();
  return !!(data && data.access_until && new Date(data.access_until).getTime() > Date.now());
}

export const origin = req => process.env.APP_URL || `https://${req.headers.host}`;
