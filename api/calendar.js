// POST /api/calendar  {tool, input}
// Reads the trainer's Google Calendar with their stored refresh token and answers in the
// same shapes the claude.ai Google Calendar connector uses, so the shared app needs no changes.
import { admin, send, readJson, userFrom, hasAccess } from "./_lib.js";

const G = "https://www.googleapis.com/calendar/v3";
const tokens = new Map(); // warm-instance cache: userId -> {access, exp}

async function accessToken(userId){
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
  tokens.set(userId, { access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

async function google(url, access){
  const r = await fetch(url, { headers: { authorization: "Bearer " + access } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || "Google Calendar error"), { code: /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(JSON.stringify(j)) ? "calendar_scope" : r.status === 401 ? "needs_reauth" : r.status >= 500 || r.status === 429 ? "server_unavailable" : "tool_error", status: r.status === 401 ? 401 : 502 });
  return j;
}

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { code: "bad_request", message: "POST only" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { code: "needs_reauth", message: "Sign in again" });
  if (!(await hasAccess(user))) return send(res, 402, { code: "subscription_required", message: "Your free trial has ended" });
  const { tool, input = {} } = await readJson(req);
  try {
    const access = await accessToken(user.id);
    if (tool === "list_calendars"){
      const q = new URLSearchParams({ maxResults: String(Math.min(250, input.pageSize || 250)) });
      if (input.pageToken) q.set("pageToken", input.pageToken);
      const j = await google(`${G}/users/me/calendarList?${q}`, access);
      return send(res, 200, { calendars: (j.items || []).map(c => ({ id: c.id, summary: c.summaryOverride || c.summary, timeZone: c.timeZone, primary: !!c.primary })), nextPageToken: j.nextPageToken || null });
    }
    if (tool === "list_events"){
      const cal = !input.calendarId || input.calendarId === "primary" ? "primary" : input.calendarId;
      const q = new URLSearchParams({ singleEvents: "true", maxResults: String(Math.min(250, input.pageSize || 250)) });
      if (input.startTime) q.set("timeMin", input.startTime);
      if (input.endTime) q.set("timeMax", input.endTime);
      if (input.orderBy === "startTime") q.set("orderBy", "startTime");
      if (input.pageToken) q.set("pageToken", input.pageToken);
      q.append("eventTypes", "default");
      const j = await google(`${G}/calendars/${encodeURIComponent(cal)}/events?${q}`, access);
      return send(res, 200, { events: j.items || [], nextPageToken: j.nextPageToken || null, summary: j.summary, timeZone: j.timeZone });
    }
    return send(res, 400, { code: "bad_request", message: "Unknown tool" });
  } catch (e) {
    return send(res, e.status || 500, { code: e.code || "server_unavailable", message: e.message });
  }
}
