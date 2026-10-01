// Background calendar sync: copies each trainer's sessions from Google into calendar_events,
// so the app opens instantly and the server can send summaries and client pages.
import { admin } from "./_lib.js";
import { accessToken, allEvents } from "./_google.js";
import { keepEvent, historyFrom, normalizeEvents, compute } from "../src/engine.js";

const DAY = 86400000;
const BACK_DAYS = 35, AHEAD_DAYS = 70;

const trim = e => ({ id: e.id, summary: e.summary || "", status: e.status, start: e.start, end: e.end,
  creator: e.creator && { email: e.creator.email }, organizer: e.organizer && { email: e.organizer.email } });

export async function loadUser(userId){
  const [{ data: p }, { data: cl }] = await Promise.all([
    admin.from("profiles").select("data").eq("user_id", userId).maybeSingle(),
    admin.from("clients").select("id,data").eq("user_id", userId)
  ]);
  return { profile: (p && p.data) || null, clients: (cl || []).map(r => ({ id: r.id, ...r.data })) };
}

export async function syncUser(userId, { profile, clients, full = false } = {}){
  if (!profile){ ({ profile, clients } = await loadUser(userId)); }
  const cals = ((profile && profile.calendars) || []).filter(c => c.use);
  if (!cals.length) return { calendars: [] };
  const access = await accessToken(userId);
  const want = historyFrom(profile, clients);
  const { data: state } = await admin.from("calendar_sync").select("calendar_id,synced_from").eq("user_id", userId);
  const have = Object.fromEntries((state || []).map(r => [r.calendar_id, r.synced_from ? new Date(r.synced_from) : null]));
  const now = Date.now(), to = new Date(now + AHEAD_DAYS * DAY), out = [];
  for (const cal of cals){
    const runAt = new Date().toISOString();
    const needsFull = full || !have[cal.id] || have[cal.id] > want;
    const from = needsFull ? want : new Date(now - BACK_DAYS * DAY);
    try {
      const evs = (await allEvents(access, cal.id, from, to)).filter(e => keepEvent(e, cal, profile));
      const rows = evs.map(e => ({ user_id: userId, calendar_id: cal.id, event_id: e.id, start_at: new Date(e.start.dateTime).toISOString(), data: trim(e), synced_at: runAt }));
      for (let i = 0; i < rows.length; i += 500){
        const { error } = await admin.from("calendar_events").upsert(rows.slice(i, i + 500));
        if (error) throw error;
      }
      // Anything in the window that Google no longer returned was deleted or moved out.
      await admin.from("calendar_events").delete().eq("user_id", userId).eq("calendar_id", cal.id)
        .gte("start_at", from.toISOString()).lt("start_at", to.toISOString()).lt("synced_at", runAt);
      await admin.from("calendar_sync").upsert({ user_id: userId, calendar_id: cal.id, last_synced_at: runAt, last_error: null,
        synced_from: (needsFull ? from : (have[cal.id] && have[cal.id] < from ? have[cal.id] : from)).toISOString() });
      out.push({ id: cal.id, events: rows.length, full: needsFull });
    } catch (e) {
      await admin.from("calendar_sync").upsert({ user_id: userId, calendar_id: cal.id, last_error: String(e.code || e.message).slice(0, 200) });
      if (["calendar_scope", "needs_reauth", "server_not_connected"].includes(e.code)) throw e;
      out.push({ id: cal.id, error: e.code || e.message });
    }
  }
  return { calendars: out };
}

// Synced events for the trainer's calendars, in [googleEvent, calendarConfig] pairs.
export async function storedRows(userId, profile){
  const cals = ((profile && profile.calendars) || []).filter(c => c.use);
  if (!cals.length) return [];
  const byId = Object.fromEntries(cals.map(c => [c.id, c]));
  const rows = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await admin.from("calendar_events").select("calendar_id,data").eq("user_id", userId)
      .in("calendar_id", cals.map(c => c.id)).order("start_at").range(from, from + 999);
    if (error) throw error;
    for (const r of data) rows.push([r.data, byId[r.calendar_id]]);
    if (data.length < 1000) break;
  }
  return rows;
}

// Runs the shared engine for one trainer, in their own time zone.
export async function modelFor(userId, loaded){
  const { profile, clients } = loaded || await loadUser(userId);
  if (!profile) return null;
  process.env.TZ = profile.timeZone || process.env.DEFAULT_TZ || "America/New_York";
  const events = normalizeEvents(await storedRows(userId, profile), profile);
  return { profile, clients, M: compute({ profile, clients, events, now: new Date() }) };
}
