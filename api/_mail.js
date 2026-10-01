// Email through Resend (https://resend.com). Until RESEND_API_KEY and MAIL_FROM are set,
// messages stay queued in the app's outbox so you can see what would have gone out.
import { admin } from "./_lib.js";

export const mailReady = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

export async function sendMail({ to, subject, html, text, fromName, replyTo }){
  const name = String(fromName || "Trainer Tally").replace(/[<>"]/g, "");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: `${name === "Trainer Tally" ? name : name + " via Trainer Tally"} <${process.env.MAIL_FROM}>`,
      to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || "Email failed (" + r.status + ")");
  return j.id;
}

// Sends one outbox row if email is set up. Returns the row's new status.
export async function deliver(row, { trainerName, replyTo } = {}){
  if (!mailReady()){
    await admin.from("outbox").update({ status: "queued", error: "Email isn't set up yet" }).eq("id", row.id);
    return "queued";
  }
  if (!row.to_email){ await admin.from("outbox").update({ status: "failed", error: "No email address" }).eq("id", row.id); return "failed"; }
  try {
    const toClient = row.kind === "renewal";
    await sendMail({ to: row.to_email, subject: row.subject, html: row.html, text: row.body_text,
      fromName: toClient ? trainerName : "Trainer Tally", replyTo: toClient ? replyTo : undefined });
    await admin.from("outbox").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("id", row.id);
    return "sent";
  } catch (e) {
    await admin.from("outbox").update({ status: "failed", error: String(e.message).slice(0, 300) }).eq("id", row.id);
    return "failed";
  }
}
