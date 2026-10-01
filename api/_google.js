// Google Calendar access with the trainer's stored refresh token (server only).
import { admin } from "./_lib.js";

export const G = "https://www.googleapis.com/calendar/v3";
const tokens = new Map(); // warm-instance cache: userId -> {access, exp}

export async function accessToken(userId){
  const hit = tokens.get(userId);
  if (hit && hit.exp > Date.now() + 60000) return hit.access;
  const { data } = await admin.from("google_tokens").select("refresh_token").eq("user_id", userId).maybeSingle();
  if (!data) throw Object.assign(new Error("Google Calendar isn't connected"), { code: "server_not_connected", status: 401 });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: data.refresh_token, grant_type: "refresh_token" })
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error("Google access expired"), { code: j.error === "invalid_grant" ? "needs_reauth" : "server_unavailable", status: j.error === "invalid_grant" ? 401 : 502 });
  if (j.scope && !/calendar(\.readonly)?(\s|$)/.test(j.scope)) throw Object.assign(new Error("Calendar permission wasn't granted"), { code: "calendar_scope", status: 403 });
  tokens.set(userId, { access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

export async function google(url, access){
  const r = await fetch(url, { headers: { authorization: "Bearer " + access } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || "Google Calendar error"), { code: /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(JSON.stringify(j)) ? "calendar_scope" : r.status === 401 ? "needs_reauth" : r.status === 404 ? "calendar_missing" : r.status >= 500 || r.status === 429 ? "server_unavailable" : "tool_error", status: r.status === 401 ? 401 : 502 });
  return j;
}

// Every timed event in a range, following pagination.
export async function allEvents(access, calendarId, from, to){
  const out = []; let pageToken = null, pages = 0;
  do {
    const q = new URLSearchParams({ singleEvents: "true", maxResults: "2500", timeMin: from.toISOString(), timeMax: to.toISOString() });
    q.append("eventTypes", "default");
    if (pageToken) q.set("pageToken", pageToken);
    const j = await google(`${G}/calendars/${encodeURIComponent(calendarId)}/events?${q}`, access);
    out.push(...(j.items || []));
    pageToken = j.nextPageToken || null;
  } while (pageToken && ++pages < 40);
  return out;
}
