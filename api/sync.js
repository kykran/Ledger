// POST /api/sync — sync the signed-in trainer's calendars now.
import { send, readJson, userFrom, hasAccess } from "./_lib.js";
import { syncUser } from "./_sync.js";

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { code: "bad_request", message: "POST only" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { code: "needs_reauth", message: "Sign in again" });
  if (!(await hasAccess(user))) return send(res, 402, { code: "subscription_required", message: "Your free trial has ended" });
  const { full } = await readJson(req);
  try { return send(res, 200, await syncUser(user.id, { full: !!full })); }
  catch (e) { return send(res, e.status || 500, { code: e.code || "server_unavailable", message: e.message }); }
}
