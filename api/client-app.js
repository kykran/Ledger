// /api/client-app — the client app at /c/<key>. The client signs in once with the 4-digit code their trainer sent,
// and a long-lived cookie keeps that device signed in. Never prices.
//   GET  ?k=KEY                         -> signed in: program view + sessions + their flags. Not yet: {signin:true, first, trainer, canEmail}
//   POST {k, action:"login", code}      -> checks the code, sets the cookie
//   POST {k, action:"email"}            -> emails the client a new code (to the email the trainer has on file)
//   POST {k, action:"logout"}
//   POST {k, action:"log"|"weight"|"flag"|"unflag", ...}   -> same as /api/program, plus flagging a session date
import { randomInt } from "node:crypto";
import { admin, send, readJson } from "./_lib.js";
import { programView, clientAction, flagsFor, sha, randomToken } from "./_client.js";
import { sendMail, mailReady } from "./_mail.js";

const KEY = /^[A-Za-z0-9_-]{8,40}$/;
const CODE_DAYS = 30, MAX_FAILS = 5, LOCK_MIN = 15;
const cookieName = k => "tt_" + k;
const firstOf = n => String(n || "").trim().split(/[\s+&]/)[0] || "there";
const maskEmail = e => { const [u, d] = String(e).split("@"); return d ? u.slice(0, 1) + "•••@" + d : ""; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const newCode = () => String(randomInt(10000)).padStart(4, "0");

function readCookie(req, name){
  for (const part of String(req.headers.cookie || "").split(/;\s*/)){ const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1)); }
  return "";
}
function setCookie(res, name, value, maxAge){
  res.setHeader("set-cookie", `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

async function accessFor(k){
  if (!KEY.test(k)) return null;
  const { data } = await admin.from("client_access").select("*").eq("key", k).maybeSingle();
  return data && !data.revoked_at ? data : null;
}
async function deviceFor(req, acc){
  const tok = readCookie(req, cookieName(acc.key));
  if (!tok) return null;
  const { data } = await admin.from("client_devices").select("token_hash,last_seen_at").eq("token_hash", sha(tok)).eq("key", acc.key).maybeSingle();
  if (data && Date.now() - new Date(data.last_seen_at).getTime() > 3600000) admin.from("client_devices").update({ last_seen_at: new Date().toISOString() }).eq("token_hash", data.token_hash).then(() => {}, () => {});
  return data;
}
async function clientInfo(acc){
  const [{ data: cl }, { data: prof }] = await Promise.all([
    admin.from("clients").select("data").eq("user_id", acc.user_id).eq("id", acc.client_id).maybeSingle(),
    admin.from("profiles").select("data").eq("user_id", acc.user_id).maybeSingle()
  ]);
  const c = (cl && cl.data) || {}, p = (prof && prof.data) || {};
  return { first: firstOf(c.name), email: String(c.email || "").trim(), trainer: p.trainerName || "", replyTo: p.myEmail || "" };
}

export default async function handler(req, res){
  res.setHeader("x-robots-tag", "noindex");
  try {
    const q = new URL(req.url, "http://x").searchParams;
    const b = req.method === "POST" ? await readJson(req) : {};
    const k = String((req.query && req.query.k) || q.get("k") || b.k || "");
    const acc = await accessFor(k);
    if (!acc) return send(res, 404, { message: "This link has been turned off. Ask your trainer for a new one." });

    if (req.method === "GET"){
      if (!(await deviceFor(req, acc))){
        const info = await clientInfo(acc);
        return send(res, 401, { signin: true, first: info.first, trainer: info.trainer, canEmail: mailReady() && !!info.email, emailHint: info.email ? maskEmail(info.email) : "" });
      }
      const v = await programView(acc.user_id, acc.client_id);
      if (!v) return send(res, 404, { message: "This link has been turned off. Ask your trainer for a new one." });
      v.flags = await flagsFor(acc.user_id, acc.client_id);
      return send(res, 200, v);
    }
    if (req.method !== "POST") return send(res, 405, { message: "Method not allowed" });

    if (b.action === "login"){
      if (acc.locked_until && new Date(acc.locked_until).getTime() > Date.now()) return send(res, 429, { message: `Too many tries. Wait ${LOCK_MIN} minutes, or ask for a new code.` });
      const code = String(b.code || "").replace(/\D/g, "");
      const ok = acc.code && code === acc.code && (!acc.code_expires_at || new Date(acc.code_expires_at).getTime() > Date.now());
      if (!ok){
        const fails = (acc.fails || 0) + 1, lock = fails >= MAX_FAILS;
        await admin.from("client_access").update(lock ? { fails: 0, locked_until: new Date(Date.now() + LOCK_MIN * 60000).toISOString() } : { fails }).eq("key", acc.key);
        const expired = acc.code && code === acc.code;
        return send(res, 401, { message: expired ? "That code has expired. Ask your trainer for a new one, or email yourself one." : lock ? `That's not it. Too many tries, so wait ${LOCK_MIN} minutes.` : "That's not the right code. Try again." });
      }
      const tok = randomToken(32);
      const { error } = await admin.from("client_devices").insert({ token_hash: sha(tok), key: acc.key });
      if (error) throw error;
      await admin.from("client_access").update({ fails: 0, locked_until: null, last_login_at: new Date().toISOString() }).eq("key", acc.key);
      setCookie(res, cookieName(acc.key), tok, 400 * 86400);
      return send(res, 200, { ok: true });
    }

    if (b.action === "email"){
      const info = await clientInfo(acc);
      if (!mailReady() || !info.email) return send(res, 400, { message: `Ask ${info.trainer || "your trainer"} to send you a new code.` });
      if (acc.code_emailed_at && Date.now() - new Date(acc.code_emailed_at).getTime() < 60000) return send(res, 429, { message: "A code is on its way. Check your email (and spam) in a minute." });
      const code = newCode(), url = (process.env.APP_URL || `https://${req.headers.host}`) + "/c/" + acc.key;
      await admin.from("client_access").update({ code, code_expires_at: new Date(Date.now() + CODE_DAYS * 86400000).toISOString(), code_emailed_at: new Date().toISOString(), fails: 0, locked_until: null }).eq("key", acc.key);
      const text = `Hi ${info.first}, your code is ${code}. Open ${url} and enter it to get back in.`;
      await sendMail({ to: info.email, subject: `Your code: ${code}`, text, fromName: info.trainer || "Trainer Tally", replyTo: info.replyTo || undefined,
        html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1d1a14"><p>Hi ${esc(info.first)},</p><p>Your code is</p><p style="font-size:34px;font-weight:700;letter-spacing:.2em;margin:8px 0">${code}</p><p><a href="${esc(url)}">Open your training app</a> and enter it to get back in.</p></div>` });
      return send(res, 200, { ok: true, to: maskEmail(info.email) });
    }

    const dev = await deviceFor(req, acc);
    if (b.action === "logout"){
      if (dev) await admin.from("client_devices").delete().eq("token_hash", dev.token_hash);
      setCookie(res, cookieName(acc.key), "", 0);
      return send(res, 200, { ok: true });
    }
    if (!dev) return send(res, 401, { signin: true, message: "Enter your code again to continue." });
    const r = await clientAction(acc.user_id, acc.client_id, b, { flags: true });
    return send(res, r.status, r.body);
  } catch (e){
    return send(res, 500, { message: "Couldn't load right now. Try again in a minute." });
  }
}
