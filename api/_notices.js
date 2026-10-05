// Decides which automatic emails are due for one trainer and puts them in the outbox.
// Times are the trainer's local time (profile.timeZone, saved by the app).
import { admin } from "./_lib.js";
import { attention, weeklySummary, monthlySummary, renewalEmail, billTo, DEFAULTS, ymd } from "../src/engine.js";
import { deliver, mailReady } from "./_mail.js";
import { sessionForDate, workoutEmail } from "../src/programs-core.js";
import { randomBytes } from "node:crypto";

const cfgOf = profile => ({ ...DEFAULTS.notices, ...((profile && profile.notices) || {}) });
const summaryTo = (profile, authEmail) => cfgOf(profile).email || profile.myEmail || authEmail || "";

// Adds a message unless one with the same key exists. Returns the new row or null.
async function enqueue(userId, row){
  const { data, error } = await admin.from("outbox").insert({ user_id: userId, ...row }).select().maybeSingle();
  if (error){ if (error.code === "23505") return null; throw error; }
  return data;
}

export function dueNotices(model, { authEmail, appUrl, now = new Date() } = {}){
  const { profile, M } = model, cfg = cfgOf(profile), out = [];
  const dow = now.getDay(), hour = now.getHours();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const to = summaryTo(profile, authEmail);
  // Weekly: Saturday from 8pm.
  if (cfg.weekly !== false && dow === 6 && hour >= 20){
    const m = weeklySummary(M, { appUrl });
    out.push({ kind: "weekly", dedupe_key: "weekly:" + ymd(now), to_email: to, subject: m.subject, html: m.html, body_text: m.text, status: "queued" });
  }
  // Monthly: two days before the month ends, from 8am (catches up on the last two days if missed).
  if (cfg.monthly !== false && now.getDate() >= lastDay - 2 && (now.getDate() > lastDay - 2 || hour >= 8)){
    const m = monthlySummary(M, { appUrl });
    out.push({ kind: "monthly", dedupe_key: "monthly:" + ymd(now).slice(0, 7), to_email: to, subject: m.subject, html: m.html, body_text: m.text, status: "queued" });
  }
  // Renewal reminders to clients, between 9am and 7pm.
  if (cfg.renewals && cfg.renewals !== "off" && hour >= 9 && hour < 19){
    for (const a of attention(M)){
      const to = billTo(M, a.c).email;
      if (a.kind !== "renew" || a.c.noAutoNotice || !to || !a.st.current) continue;
      const pkg = a.st.current.id || a.st.current.start || a.st.current.index;
      const m = renewalEmail(M, a.c);
      out.push({ kind: "renewal", client_id: a.c.id, dedupe_key: `renewal:${a.c.id}:${pkg}`, to_email: to,
        subject: m.subject, html: m.html, body_text: m.text, status: cfg.renewals === "auto" ? "queued" : "held" });
    }
  }
  return out;
}

/* The client's private program link (made if they don't have one yet). */
export async function programLinkFor(userId, clientId){
  const { data } = await admin.from("program_links").select("token").eq("user_id", userId).eq("client_id", clientId).is("revoked_at", null).order("created_at", { ascending: false }).limit(1);
  if (data && data[0]) return data[0].token;
  const token = randomBytes(18).toString("base64url");
  const { error } = await admin.from("program_links").insert({ token, user_id: userId, client_id: clientId });
  return error ? null : token;
}
export async function activeProgram(userId, clientId){
  const { data } = await admin.from("programs").select("id,client_id,data").eq("user_id", userId).eq("client_id", clientId);
  return (data || []).map(r => ({ ...r.data, id: r.id })).filter(p => p.status !== "archived" && p.startDate).sort((a, b) => b.startDate.localeCompare(a.startDate))[0] || null;
}
/* Workout emails: clients set to "evening" get tomorrow's session from 7 to 11pm; "morning" get today's from 6 to 10am,
 * if the session hasn't started. Only on days they're on the calendar, and only if that day's workout is written. */
async function workoutNotices(userId, model, { appUrl, now = new Date() } = {}){
  const { profile, clients, M } = model, hour = now.getHours(), out = [];
  const want = (clients || []).filter(c => c.active !== false && c.email && (c.workoutEmail === "evening" || c.workoutEmail === "morning"));
  for (const c of want){
    const evening = c.workoutEmail === "evening";
    if (evening ? !(hour >= 19 && hour < 23) : !(hour >= 6 && hour < 10)) continue;
    const st = M.stats[c.id]; if (!st) continue;
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (evening ? 1 : 0));
    const dates = [...st.past, ...st.future].map(s => s.date);
    const that = dates.filter(d => d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth() && d.getDate() === target.getDate()).sort((a, b) => a - b)[0];
    if (!that || (!evening && that < now)) continue;
    const prog = await activeProgram(userId, c.id); if (!prog) continue;
    const hit = sessionForDate(prog, that, dates); if (!hit) continue;
    const token = await programLinkFor(userId, c.id);
    const m = workoutEmail({ first: String(c.name || "").trim().split(/[\s+&]/)[0] || "there", trainer: profile.trainerName, session: hit.session,
      weekLabel: hit.week.label, when: that, link: token && appUrl ? appUrl + "/p/" + token : "" });
    out.push({ kind: "workout", client_id: c.id, dedupe_key: `workout:${c.id}:${ymd(target)}`, to_email: c.email, subject: m.subject, html: m.html, body_text: m.text, status: "queued" });
  }
  return out;
}

export async function runNotices(userId, model, opts = {}){
  const sent = [];
  const replyTo = model.profile.myEmail || opts.authEmail;
  try {
    for (const n of await workoutNotices(userId, model, opts)){
      const row = await enqueue(userId, n);
      if (row) sent.push({ kind: "workout", status: await deliver(row, { trainerName: model.profile.trainerName, replyTo }) });
    }
  } catch (e){ sent.push({ kind: "workout", error: String(e.message).slice(0, 120) }); }
  for (const n of dueNotices(model, opts)){
    const row = await enqueue(userId, n);
    if (!row) continue;
    sent.push({ kind: row.kind, status: row.status === "queued" ? await deliver(row, { trainerName: model.profile.trainerName, replyTo }) : row.status });
  }
  // Retry anything still waiting for email setup (only messages from the last 3 days).
  if (!mailReady()) return sent;
  const { data: waiting } = await admin.from("outbox").select("*").eq("user_id", userId).eq("status", "queued")
    .gte("created_at", new Date(Date.now() - 3 * 86400000).toISOString()).limit(20);
  // A workout email that waited more than 12 hours is out of date; skip it rather than send it late.
  for (const row of waiting || []){
    if (row.kind === "workout" && Date.now() - new Date(row.created_at).getTime() > 12 * 3600000){ await admin.from("outbox").update({ status: "skipped", error: "Too late to send" }).eq("id", row.id); continue; }
    await deliver(row, { trainerName: model.profile.trainerName, replyTo });
  }
  return sent;
}
