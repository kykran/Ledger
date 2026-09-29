// POST /api/auth/store-token  {refresh_token}
// Called once right after Google sign-in. Stores the long-lived Google token server-side only.
import { admin, send, readJson, userFrom } from "../_lib.js";

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { message: "POST only" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { code: "needs_reauth" });
  const { refresh_token } = await readJson(req);
  if (!refresh_token || typeof refresh_token !== "string") return send(res, 400, { message: "Missing token" });
  const { error } = await admin.from("google_tokens").upsert({ user_id: user.id, refresh_token, updated_at: new Date().toISOString() });
  if (error) return send(res, 500, { message: "Couldn't save token" });
  return send(res, 200, { ok: true });
}
