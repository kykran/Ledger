// Decides which automatic emails are due for one trainer and puts them in the outbox.
// Times are the trainer's local time (profile.timeZone, saved by the app).
import { admin } from "./_lib.js";
import { attention, weeklySummary, monthlySummary, renewalEmail, DEFAULTS, ymd } from "../src/engine.js";
import { deliver, mailReady } from "./_mail.js";

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
      if (a.kind !== "renew" || a.c.noAutoNotice || !a.c.email || !a.st.current) continue;
      const pkg = a.st.current.id || a.st.current.start || a.st.current.index;
      const m = renewalEmail(M, a.c);
      out.push({ kind: "renewal", client_id: a.c.id, dedupe_key: `renewal:${a.c.id}:${pkg}`, to_email: a.c.email,
        subject: m.subject, html: m.html, body_text: m.text, status: cfg.renewals === "auto" ? "queued" : "held" });
    }
  }
  return out;
}

export async function runNotices(userId, model, opts = {}){
  const sent = [];
  const replyTo = model.profile.myEmail || opts.authEmail;
  for (const n of dueNotices(model, opts)){
    const row = await enqueue(userId, n);
    if (!row) continue;
    sent.push({ kind: row.kind, status: row.status === "queued" ? await deliver(row, { trainerName: model.profile.trainerName, replyTo }) : row.status });
  }
  // Retry anything still waiting for email setup (only messages from the last 3 days).
  if (!mailReady()) return sent;
  const { data: waiting } = await admin.from("outbox").select("*").eq("user_id", userId).eq("status", "queued")
    .gte("created_at", new Date(Date.now() - 3 * 86400000).toISOString()).limit(20);
  for (const row of waiting || []) await deliver(row, { trainerName: model.profile.trainerName, replyTo });
  return sent;
}
