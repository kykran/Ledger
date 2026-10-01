// POST /api/calendar  {tool, input}
// Reads the trainer's Google Calendar with their stored refresh token and answers in the
// same shapes the claude.ai Google Calendar connector uses, so the shared app needs no changes.
import { send, readJson, userFrom, hasAccess } from "./_lib.js";
import { G, accessToken, google } from "./_google.js";


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
