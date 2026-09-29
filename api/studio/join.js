// POST /api/studio/join  {code}
// Links the signed-in trainer's account to their row at a studio using an invite code.
import { admin, send, readJson, userFrom } from "../_lib.js";

export default async function handler(req, res){
  if (req.method !== "POST") return send(res, 405, { message: "POST only" });
  const user = await userFrom(req);
  if (!user) return send(res, 401, { code: "needs_reauth", message: "Sign in again" });
  const { code } = await readJson(req);
  const clean = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean) return send(res, 400, { message: "Enter the code your studio sent you." });

  const { data: inv } = await admin.from("studio_invites").select("code,studio_id,trainer_id,expires_at").eq("code", clean).maybeSingle();
  if (!inv) return send(res, 404, { message: "That code isn't valid. Ask your studio for a new one." });
  if (new Date(inv.expires_at).getTime() < Date.now()) return send(res, 410, { message: "That code has expired. Ask your studio for a new one." });

  const { data: st } = await admin.from("studios").select("id,owner_id,data").eq("id", inv.studio_id).maybeSingle();
  if (!st) return send(res, 404, { message: "That studio no longer exists." });

  // One account per trainer row: replace any earlier link to this row.
  await admin.from("studio_members").delete().eq("studio_id", inv.studio_id).eq("trainer_id", inv.trainer_id);
  const { error } = await admin.from("studio_members").upsert({ studio_id: inv.studio_id, user_id: user.id, trainer_id: inv.trainer_id });
  if (error) return send(res, 500, { message: "Couldn't join the studio. Try again." });

  // Note the link on the trainer row so the owner sees it, and use up the code.
  const { data: tr } = await admin.from("studio_trainers").select("data").eq("studio_id", inv.studio_id).eq("id", inv.trainer_id).maybeSingle();
  if (tr) await admin.from("studio_trainers").update({ data: { ...tr.data, linkedEmail: user.email, linkedAt: new Date().toISOString() }, updated_at: new Date().toISOString() }).eq("studio_id", inv.studio_id).eq("id", inv.trainer_id);
  await admin.from("studio_invites").delete().eq("code", clean);

  return send(res, 200, { ok: true, studioName: (st.data && st.data.name) || "your studio" });
}
