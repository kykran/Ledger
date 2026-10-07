/* Trainer Tally · voice logging while recording a session.
 * Tap the mic, say "goblet squat ten at thirty-five", tap again. The words go to /api/voice, which
 * returns the sets it heard. They show up as a card to confirm; nothing is saved until the trainer taps Save.
 *
 * Two ways to hear: the server transcribes the recording (best, needs OPENAI_API_KEY), or the browser's own
 * speech recognition (free, no key, a bit less accurate in a noisy gym). Chosen automatically. */

const MAX_MS = 20000; // a spoken log is a sentence or two
const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);

export function createVoice({ api, onState, onResult }){
  let cfg = null, rec = null, chunks = [], stream = null, timer = null, recog = null, heard = "", mime = "";
  const V = { state: "idle", error: "" }; // idle | listening | thinking
  const set = (state, error = "") => { V.state = state; V.error = error; onState(V); };

  const canRecord = () => typeof MediaRecorder !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  async function config(){
    if (cfg) return cfg;
    try { cfg = await api({ action: "config" }); } catch (e){ cfg = { serverStt: false }; }
    cfg.mode = cfg.serverStt && canRecord() ? "server" : SR ? "browser" : null;
    return cfg;
  }
  V.supported = () => !!(canRecord() || SR);

  async function start(context){
    if (V.state !== "idle") return;
    const c = await config();
    if (!c.mode) return set("idle", "This browser can't use the microphone here. Try Chrome or Safari.");
    V.context = context;
    if (c.mode === "server"){
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e){ return set("idle", "Microphone access was blocked. Allow it in the browser's site settings."); }
      mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
      chunks = [];
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => finishAudio();
      rec.start();
    } else {
      heard = "";
      recog = new SR(); recog.lang = "en-US"; recog.interimResults = false; recog.continuous = true; recog.maxAlternatives = 1;
      recog.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard += " " + e.results[i][0].transcript; };
      recog.onerror = e => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { recog = null; clearTimeout(timer); set("idle", "Microphone access was blocked. Allow it in the browser's site settings."); } };
      recog.onend = () => { if (recog){ recog = null; send({ text: heard.trim() }); } };
      try { recog.start(); } catch (e){ recog = null; return set("idle", "Couldn't start the microphone. Try again."); }
    }
    clearTimeout(timer); timer = setTimeout(stop, MAX_MS);
    set("listening");
  }

  function stop(){
    clearTimeout(timer);
    if (V.state !== "listening") return;
    set("thinking");
    if (rec && rec.state !== "inactive") rec.stop();
    else if (recog) recog.stop();
  }

  function cancel(){
    clearTimeout(timer);
    if (rec){ rec.onstop = null; if (rec.state !== "inactive") rec.stop(); }
    if (recog){ const r = recog; recog = null; try { r.abort(); } catch (e){} }
    release(); rec = null; set("idle");
  }

  function release(){ if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; } }

  async function finishAudio(){
    release();
    const blob = new Blob(chunks, { type: mime || "audio/webm" }); rec = null; chunks = [];
    if (blob.size < 1500) return set("idle", "Didn't catch anything. Tap the mic, speak, then tap again.");
    const audio = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1] || ""); fr.onerror = no; fr.readAsDataURL(blob); });
    send({ audio, mime: blob.type });
  }

  async function send(payload){
    if (!payload.text && !payload.audio) return set("idle", "Didn't catch anything. Try again a little closer to the phone.");
    try {
      const r = await api({ action: "parse", ...payload, ...V.context });
      set("idle"); onResult(r);
    } catch (e){
      // The server lost its transcription key mid-session: fall back to the browser.
      if (e.code === "stt_not_setup" && SR){ cfg.mode = "browser"; return set("idle", "Switched to the browser's speech recognition. Tap the mic again."); }
      set("idle", e.message || "Couldn't read that. Try again.");
    }
  }

  V.start = start; V.stop = stop; V.cancel = cancel; V.config = config;
  return V;
}

/* What the server needs to know about the session being recorded. */
export function voiceContext(s, logs, lastRowId){
  const rows = (s.rows || []).filter(r => r.name).map(r => ({ id: r.id, name: r.name, group: r.group || "", sets: String(r.sets ?? ""), reps: String(r.reps ?? ""), weight: String(r.weight ?? ""),
    logged: logs.filter(l => l.session_id === s.id && l.row_id === r.id).map(l => ({ set_no: l.set_no, reps: l.reps, weight: l.weight, done: !!l.done })) }));
  return { rows, lastRowId: lastRowId || "" };
}

export const VOICE_CSS = `
.pg-mic{display:inline-flex;align-items:center;gap:6px}
.pg-mic.on{background:var(--neg,#c0392b);border-color:var(--neg,#c0392b);color:#fff;animation:pg-pulse 1.2s ease-in-out infinite}
@keyframes pg-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--neg,#c0392b) 45%,transparent)}50%{box-shadow:0 0 0 7px transparent}}
@media (prefers-reduced-motion: reduce){.pg-mic.on{animation:none}}
.pg-voice{border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--surface)}
.pg-voice q{font-style:italic;color:var(--muted)}
.pg-voice ul{list-style:none;margin:8px 0;padding:0;display:grid;gap:6px}
.pg-voice li{display:flex;align-items:center;gap:8px;justify-content:space-between;border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--bg)}
.pg-voice .actions{display:flex;gap:8px;justify-content:flex-end}
`;
