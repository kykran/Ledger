// Runs every hour (Supabase pg_cron calls it; on Vercel Pro you can use a Vercel cron instead).
// For each trainer: sync calendars, then queue/send any weekly, monthly or renewal emails that are due.
import { admin, send, origin } from "../_lib.js";
import { syncUser, loadUser, modelFor } from "../_sync.js";
import { runNotices } from "../_notices.js";

async function authorized(req){
  const h = req.headers.authorization || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!got) return false;
  if (process.env.CRON_SECRET && got === process.env.CRON_SECRET) return true;
  const { data } = await admin.from("app_secrets").select("value").eq("name", "cron").maybeSingle();
  return !!(data && data.value && got === data.value);
}

export default async function handler(req, res){
  if (!(await authorized(req))) return send(res, 401, { message: "Not allowed" });
  const started = Date.now(), report = [];
  const { data: users } = await admin.from("google_tokens").select("user_id");
  const { data: authList } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emailOf = Object.fromEntries(((authList && authList.users) || []).map(u => [u.id, u.email]));
  for (const { user_id } of users || []){
    if (Date.now() - started > 45000) { report.push({ user_id, skipped: "time" }); continue; }
    const r = { user: user_id.slice(0, 8) };
    try {
      const loaded = await loadUser(user_id);
      if (!loaded.profile || !loaded.profile.setupDone){ r.skipped = "not set up"; report.push(r); continue; }
      try { r.sync = (await syncUser(user_id, loaded)).calendars.length; } catch (e) { r.syncError = e.code || e.message; }
      const model = await modelFor(user_id, loaded);
      r.notices = await runNotices(user_id, model, { authEmail: emailOf[user_id], appUrl: origin(req) });
    } catch (e) { r.error = String(e.message).slice(0, 200); }
    report.push(r);
  }
  return send(res, 200, { ok: true, ms: Date.now() - started, report });
}
