/* "Client app" on the trainer side: one button next to a client makes a 4-digit code and a link (/c/<key>).
 * The client opens the link once, types the code, and stays signed in on that device.
 * Used by the client card in Trainer Tally (data-act="ca-*") and the Programs share sheet ("pg-ca-*"). */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const first = n => String(n || "").trim().split(/[\s+&]/)[0] || "there";
const fmt = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function accessMessage(c, L){
  return `Hi ${first(c.name)}! Here's your training app: ${L.url}\nYour code: ${L.code}\nOpen the link, enter the code, then add it to your home screen. You'll stay signed in.`;
}

/* L: undefined = not asked yet, null = loading, false = none, or {key, url, code, expiresAt, lastLoginAt}. */
export function accessBlock(c, L, { readOnly, prefix = "ca-" } = {}){
  const nm = esc(first(c.name)), id = esc(c.id);
  if (L === undefined || L === null) return `<p class="small muted">Checking…</p>`;
  if (!L) return `<p class="small muted">${nm} signs in once with a 4-digit code and stays signed in. They see their program, homework with videos, and every session date (no prices). They can tap a date to flag it for you.</p>
    <div class="actions"><button class="btn primary" data-act="${prefix}make" data-cid="${id}" ${readOnly ? "disabled" : ""}>Make code + link</button></div>`;
  const expired = L.expiresAt && new Date(L.expiresAt) < new Date();
  const msg = accessMessage(c, L);
  return `<div class="ca-box"><div class="ca-code ${expired ? "old" : ""}" aria-label="Code ${esc(L.code.split("").join(" "))}">${esc(L.code)}</div>
      <div class="ca-meta"><div class="small"><a href="${esc(L.url)}" target="_blank" rel="noopener">${esc(L.url.replace(/^https?:\/\//, ""))}</a></div>
      <div class="small muted">${expired ? "Code expired. Make a new one if they need to sign in again." : L.expiresAt ? `Code works until ${esc(fmt(L.expiresAt))}.` : ""} ${L.lastLoginAt ? `Last signed in ${esc(fmt(L.lastLoginAt))}.` : "Not signed in yet."}</div></div></div>
    <div class="actions"><button class="btn primary" data-act="${prefix}copy" data-cid="${id}">Copy message</button>
      <a class="btn" href="sms:${esc(String(c.phone || "").replace(/[^\d+]/g, ""))}?&body=${encodeURIComponent(msg)}">Text it</a>
      <button class="btn ghost" data-act="${prefix}make" data-cid="${id}" ${readOnly ? "disabled" : ""}>New code</button>
      <button class="btn ghost danger" data-act="${prefix}off" data-cid="${id}" ${readOnly ? "disabled" : ""}>Turn off</button></div>
    <p class="small muted">A new code doesn't sign anyone out. Turn off signs them out everywhere and stops the link.</p>`;
}

export const ACCESS_CSS = `.ca-box{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.ca-code{font-size:32px;font-weight:700;letter-spacing:.28em;padding:6px 6px 6px 14px;border:1.5px dashed var(--line);border-radius:12px;font-variant-numeric:tabular-nums}
.ca-code.old{opacity:.45;text-decoration:line-through}
.ca-meta{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}.ca-meta a{word-break:break-all}`;

/* Loads a client's access into store[id] once, calling redraw when it arrives. */
export function loadAccess(A, store, id, redraw){
  if (!A.access || store[id] !== undefined) return;
  store[id] = null;
  A.access.get(id).then(x => { store[id] = x || false; redraw(); }).catch(() => { store[id] = false; redraw(); });
}

/* Handles a ca-* click. Returns true when it was one. */
export async function accessAct(el, { A, store, clientOf, redraw, toast, prefix = "ca-" }){
  const full = el.getAttribute("data-act"); if (!full || !full.startsWith(prefix)) return false;
  const act = "ca-" + full.slice(prefix.length);
  const id = el.getAttribute("data-cid"), c = clientOf(id);
  if (act === "ca-make"){
    el.disabled = true;
    try { store[id] = await A.access.make(id); toast("New code ready"); } catch (e){ toast(e.message || "Couldn't make a code"); }
    redraw();
  } else if (act === "ca-copy"){
    const t = accessMessage(c, store[id]);
    try { await navigator.clipboard.writeText(t); toast("Copied. Paste it in a text to " + first(c.name)); } catch (e){ prompt("Copy this message", t); }
  } else if (act === "ca-off"){
    if (!confirm(`Turn off ${first(c.name)}'s app? They'll be signed out and the link stops working.`)) return true;
    try { await A.access.off(id); store[id] = false; toast("Turned off"); } catch (e){ toast("Couldn't turn it off"); }
    redraw();
  }
  return true;
}

// app.js is a classic script (shared with the claude.ai build), so it reaches these through a global.
globalThis.TallyAccess = { accessBlock, accessAct, loadAccess };
if (typeof document !== "undefined") document.head.insertAdjacentHTML("beforeend", `<style>${ACCESS_CSS}</style>`);
