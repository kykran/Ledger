/* Trainer Tally · demo data.
 * Builds a realistic, made-up trainer (Alex Rivera) and studio (Harbor Strength Studio) around
 * today's date: a year of calendar sessions, clients on every billing type, and studio rent.
 * Deterministic, so every visitor sees the same demo. Nothing here is real. */

const DAY = 86400000;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const mkey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1);
const clone = o => JSON.parse(JSON.stringify(o));

export const ME = "alex@demo.trainertally.app";
export const STUDIO_CAL = "harbor-strength-demo";
export const STUDIO_NAME = "Harbor Strength Studio";
const CANCEL = /cancel/i;

export function buildDemo(now = new Date()){
  let seed = 20260929;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const Y = now.getFullYear();
  const from = new Date(Y, 0, 1), to = addDays(now, 42);
  let n = 0;
  const events = [];
  const ev = (title, start, mins, email, cal) => {
    const end = new Date(+start + mins * 60000);
    events.push({ id: "demo" + (n++), summary: title, status: "confirmed", cal,
      start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() },
      creator: { email }, organizer: { email } });
  };
  // slots: [weekday 0=Sun..6, hour, minute?]; one vacation week each in summer
  const gen = ({ titles, slots, cal, email = ME, since = from, until = to, skip = 0.06, cancel = 0.035, mins = 60 }) => {
    const vac = 22 + Math.floor(rnd() * 12);
    for (let d = new Date(since); d < until; d = addDays(d, 1)){
      const wk = Math.floor((d - new Date(Y, 0, 1)) / (7 * DAY));
      for (const [dow, h, m = 0] of slots){
        if (d.getDay() !== dow) continue;
        if (wk === vac || wk === vac + 1 && rnd() < 0.5) continue;
        const future = d > now;
        if (rnd() < (future ? skip / 3 : skip)) continue;
        const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
        let t = titles[Math.floor(rnd() * titles.length)];
        if (!future && rnd() < cancel) t = t + " - cancelled";
        ev(t, s, mins, email, cal);
      }
    }
  };

  /* ---- Alex's own clients ---- */
  const C = {
    maya:   { name: "Maya Chen",     titles: ["Maya Chen", "PT Maya"], slots: [[1, 7], [4, 7]], cal: STUDIO_CAL },
    jordan: { name: "Jordan Reyes",  titles: ["Jordan Reyes"], slots: [[2, 18], [5, 18]], cal: STUDIO_CAL, since: new Date(Y, 2, 3) },
    priya:  { name: "Priya Patel",   titles: ["Priya Patel"], slots: [[1, 9], [3, 9], [5, 9]], cal: STUDIO_CAL },
    sam:    { name: "Sam Okafor",    titles: ["Sam Okafor"], slots: [[3, 12], [6, 10]], cal: STUDIO_CAL },
    rossi:  { name: "Elena + Marco", titles: ["Elena + Marco"], slots: [[2, 17], [4, 17]], cal: STUDIO_CAL },
    taylor: { name: "Taylor Brooks", titles: ["Taylor Brooks"], slots: [[2, 6], [4, 6]], cal: STUDIO_CAL, since: addDays(now, -40) },
    chris:  { name: "Chris Walsh",   titles: ["Chris Walsh"], slots: [[6, 8]], cal: ME },
    nina:   { name: "Nina Alvarez",  titles: ["Nina Alvarez zoom"], slots: [[1, 19, 30]], cal: ME, mins: 45, since: new Date(Y, 4, 5) }
  };
  for (const c of Object.values(C)) gen(c);
  // things that aren't clients, to show the "Found on your calendar" list
  gen({ titles: ["Staff meeting"], slots: [[1, 12]], cal: ME, skip: 0.1, cancel: 0 });
  gen({ titles: ["Dana Lee intro"], slots: [[3, 16]], cal: STUDIO_CAL, since: addDays(now, -20), until: addDays(now, 8), skip: 0, cancel: 0 });
  ev("Dentist", new Date(Y, now.getMonth(), Math.max(1, now.getDate() - 9), 14), 60, ME, ME);

  events.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
  const sessionsOf = (titles, cal) => events.filter(e => e.cal === cal && titles.includes(e.summary.replace(/ - cancelled$/, "")) && !CANCEL.test(e.summary));
  const pastOf = c => sessionsOf(c.titles, c.cal).map(e => new Date(e.start.dateTime)).filter(d => d < now);

  // A package that has had `used` sessions so far: its start is the used-th most recent session.
  const pkg = (id, c, size, price, used, paid = true) => {
    const past = pastOf(c);
    const i = Math.max(0, past.length - used);
    const s = past[i] || addDays(now, -7);
    const start = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    const p = { id: id + "-cur", size, price, start: start.toISOString(), used0: 0 };
    if (paid) p.paidDate = ymd(start);
    // earlier packs, bought every `size` sessions going back
    const pays = paid ? [{ id: id + "-p0", date: ymd(start), amount: price, method: "Venmo", note: size + "-session package" }] : [];
    for (let k = 1, j = i - size; j >= 0; k++, j -= size) pays.push({ id: id + "-p" + k, date: ymd(past[j]), amount: price, method: k % 2 ? "Zelle" : "Venmo", note: size + "-session package" });
    return { packages: [p], payments: pays };
  };
  // Monthly bills paid in full through `paidThrough` (a month key), on the 5th of the next month.
  const monthPays = (id, c, amountFor, paidThrough, day = 5) => {
    const past = pastOf(c), byM = {};
    past.forEach(d => { const k = mkey(d); byM[k] = (byM[k] || 0) + 1; });
    const pays = [];
    for (let m = 0; m < 12; m++){
      const k = Y + "-" + pad(m + 1);
      if (k > paidThrough) break;
      const amt = amountFor(byM[k] || 0);
      if (amt > 0) pays.push({ id: id + "-m" + m, date: ymd(new Date(Y, m + 1, day)), amount: amt, method: "Zelle", note: "" });
    }
    return pays;
  };
  const curM = mkey(now), prevM = mkey(new Date(now.getFullYear(), now.getMonth() - 1, 1)), prev2M = mkey(new Date(now.getFullYear(), now.getMonth() - 2, 1));

  const clients = [
    { id: "maya", name: "Maya Chen", aliases: ["Maya"], billing: "package", rate: 110, packageSize: 24, packagePrice: 2640, email: "maya@example.com", phone: "(617) 555-0142", ...pkg("maya", C.maya, 24, 2640, 13) },
    { id: "jordan", name: "Jordan Reyes", billing: "package", rate: 120, packageSize: 10, packagePrice: 1200, phone: "(617) 555-0187", ...pkg("jordan", C.jordan, 10, 1200, 8) },
    { id: "priya", name: "Priya Patel", billing: "package", rate: 100, packageSize: 24, packagePrice: 2400, email: "priya@example.com", ...pkg("priya", C.priya, 24, 2400, 26) },
    { id: "taylor", name: "Taylor Brooks", billing: "package", rate: 115, packageSize: 12, packagePrice: 1380, phone: "(617) 555-0119", ...pkg("taylor", C.taylor, 12, 1380, 7, false) },
    { id: "sam", name: "Sam Okafor", billing: "tab", rate: 95, billingStart: Y + "-01-01", phone: "(617) 555-0163", payments: monthPays("sam", C.sam, n => n * 95, prev2M) },
    { id: "rossi", name: "Elena + Marco", aliases: ["Elena and Marco"], billing: "membership", fee: 600, included: 8, overageRate: 80, billingStart: Y + "-01-01", email: "rossi@example.com",
      payments: [...monthPays("rossi", C.rossi, n => 600 + Math.max(0, n - 8) * 80, prevM).map(p => { const d = new Date(p.date + "T12:00"); return { ...p, date: ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), method: "Card" }; }),
        { id: "rossi-cur", date: curM + "-01", amount: 600, method: "Card", note: "" }] },
    { id: "chris", name: "Chris Walsh", billing: "payg", rate: 90, noRent: false, email: "chris@example.com" },
    { id: "nina", name: "Nina Alvarez", billing: "payg", rate: 80, email: "nina@example.com" },
    { id: "ben", name: "Ben Foster", billing: "package", rate: 110, packageSize: 24, active: false, packages: [], payments: [] }
  ].map(c => ({ aliases: [], packages: [], payments: [], noRent: false, noRentNames: [], active: true, email: "", phone: "", ...c }));

  const profile = {
    schema: 1, setupDone: true, tourDone: false, trainerName: "Alex", myEmail: ME,
    calendars: [
      { id: STUDIO_CAL, name: STUDIO_NAME, use: true, studio: true, mineOnly: true },
      { id: ME, name: "Personal", use: true, studio: false, mineOnly: false }
    ],
    rent: { mode: "perSession", perSession: 20, monthly: 660, percent: 30, appliesTo: "studio" },
    defaults: { billing: "package", rate: 110, packageSize: 24 },
    threshold: 3, historyStart: Y + "-01-01",
    ignoreWords: ["cancel", "cancelled", "canceled", "free", "comp", "rescheduled", "tentative", "hold"], ignoredTitles: []
  };

  const calendars = [
    { id: STUDIO_CAL, summary: STUDIO_NAME },
    { id: ME, summary: "Personal", primary: true },
    { id: "family-demo", summary: "Family" }
  ];

  /* ---- Studio side: Alex plus three other trainers renting the space ---- */
  const studioEvents = events.filter(e => e.cal === STUDIO_CAL && e.creator.email === ME).map(clone);
  const push = e => studioEvents.push(e);
  const ev2 = (title, start, mins, email) => { const end = new Date(+start + mins * 60000); push({ id: "demo" + (n++), summary: title, status: "confirmed", cal: STUDIO_CAL, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, creator: { email }, organizer: { email } }); };
  const others = [
    { id: "jess", name: "Jess Morgan", email: "jess@harborstrength.demo", rent: { mode: "monthly", monthly: 660 },
      clients: ["Kara", "Dev", "Morgan L", "Omar", "Beth R", "Ivy"], slots: [[1, 6], [1, 17], [2, 7], [2, 16], [3, 6], [3, 17], [4, 7], [4, 18], [5, 6], [5, 16], [6, 8], [6, 9], [1, 18], [3, 19]] },
    { id: "devon", name: "Devon Clarke", email: "devon@harborstrength.demo", rent: { mode: "perSession", perSession: 25 },
      clients: ["Rae", "Tom H", "Leah", "Marcus"], slots: [[1, 8], [2, 12], [2, 19], [3, 8], [4, 12], [4, 19], [5, 8], [6, 11], [2, 20], [4, 20]] },
    { id: "riley", name: "Riley Park", email: "riley@harborstrength.demo", rent: { mode: "default" }, startDate: Y + "-06-01", since: new Date(Y, 5, 1),
      clients: ["Hannah", "Joe P", "Grace"], slots: [[1, 10], [2, 10], [3, 10], [4, 10], [5, 10], [6, 12], [3, 18], [5, 18]] }
  ];
  for (const o of others){
    const before = studioEvents.length;
    const vac = 24 + Math.floor(rnd() * 10);
    for (let d = new Date(o.since || from); d < to; d = addDays(d, 1)){
      const wk = Math.floor((d - new Date(Y, 0, 1)) / (7 * DAY));
      for (const [dow, h] of o.slots){
        if (d.getDay() !== dow || wk === vac) continue;
        if (rnd() < (d > now ? 0.03 : 0.1)) continue;
        let t = o.clients[Math.floor(rnd() * o.clients.length)];
        if (d < now && rnd() < 0.03) t += " - cancelled";
        ev2(t, new Date(d.getFullYear(), d.getMonth(), d.getDate(), h), 60, o.email);
      }
    }
    o.count = studioEvents.length - before;
  }
  // someone new booking on the studio calendar, to show "Found on the calendar"
  for (let i = 5; i >= -1; i--){ const d = addDays(now, -i * 6); ev2("Assessment", new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15), 60, "sam.intern@harborstrength.demo"); }
  studioEvents.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));

  const studioSessionsByMonth = email => {
    const byM = {};
    studioEvents.filter(e => e.creator.email === email && !CANCEL.test(e.summary) && new Date(e.start.dateTime) < now)
      .forEach(e => { const k = e.start.dateTime.slice(0, 7); byM[k] = (byM[k] || 0) + 1; });
    return byM;
  };
  const rentPays = (id, byM, amountFor, paidThrough, startK) => {
    const pays = [];
    for (let m = 0; m < 12; m++){
      const k = Y + "-" + pad(m + 1);
      if (k > paidThrough) break;
      if (startK && k < startK) continue;
      const amt = amountFor(byM[k] || 0);
      if (amt > 0) pays.push({ id: id + "-r" + m, date: ymd(new Date(Y, m + 1, 3)), amount: amt, method: m % 3 ? "Zelle" : "Venmo", note: "" });
    }
    return pays;
  };
  const alexByM = studioSessionsByMonth(ME);
  const trainers = [
    { id: "alex", name: "Alex Rivera", emails: [ME], rent: { mode: "default" }, email: ME, phone: "(617) 555-0100", active: true, linkedEmail: ME,
      payments: rentPays("alex", alexByM, n => n * 20, prevM) },
    { id: "jess", name: "Jess Morgan", emails: [others[0].email], rent: others[0].rent, email: others[0].email, phone: "(617) 555-0121", active: true,
      payments: rentPays("jess", studioSessionsByMonth(others[0].email), () => 660, prevM).map(p => ({ ...p, date: p.date.slice(0, 8) + "01" })) },
    { id: "devon", name: "Devon Clarke", emails: [others[1].email], rent: others[1].rent, email: others[1].email, phone: "(617) 555-0134", active: true,
      payments: rentPays("devon", studioSessionsByMonth(others[1].email), n => n * 25, prev2M) },
    { id: "riley", name: "Riley Park", emails: [others[2].email], rent: others[2].rent, startDate: others[2].startDate, email: others[2].email, active: true,
      payments: rentPays("riley", studioSessionsByMonth(others[2].email), n => n * 20, prevM, Y + "-06") }
  ];
  const studio = {
    id: "demo-studio", owner_id: "demo-owner",
    data: { setupDone: true, name: STUDIO_NAME, calendarId: STUDIO_CAL, calendarName: STUDIO_NAME, rooms: 2, open: 6, close: 21, days: [1, 2, 3, 4, 5, 6],
      rent: { mode: "perSession", perSession: 20, monthly: 660 }, historyStart: Y + "-01-01",
      ignoreWords: ["cancel", "cancelled", "canceled", "closed", "hold", "maintenance", "blocked"], ignoredEmails: [],
      statementTemplate: "Hi {first}! Your {studio} rent for {month} is ${amount} ({details}).{balance} Thanks!" }
  };

  // What Alex sees in his own app for the studio: the same statement the studio sends.
  const alexMonths = [];
  for (let m = Math.max(0, now.getMonth() - 3); m <= now.getMonth(); m++){
    const k = Y + "-" + pad(m + 1), cnt = alexByM[k] || 0, rent = cnt * 20, cur = k === curM;
    alexMonths.push({ month: k, n: cnt, rent, paid: cur ? 0 : rent, state: cur ? "running" : rent ? "paid" : "none", details: `${cnt} sessions × $20` });
  }
  const membership = { studioId: "demo-studio", studioName: STUDIO_NAME,
    trainer: { id: "alex", name: "Alex Rivera", statement: { rule: "$20/session", balance: 0, credit: 0, updatedAt: now.toISOString(), months: alexMonths } } };

  return { profile, clients, calendars, events, studio, trainers, studioEvents, membership, clone };
}

export function listEvents(all, input){
  const cal = !input.calendarId || input.calendarId === "primary" ? ME : input.calendarId;
  const a = input.startTime ? new Date(input.startTime) : new Date(0), b = input.endTime ? new Date(input.endTime) : new Date(8.64e15);
  const events = all.filter(e => e.cal === cal).filter(e => { const d = new Date(e.start.dateTime); return d >= a && d < b; }).map(({ cal, ...e }) => e);
  const size = Math.min(250, input.pageSize || 250), off = input.pageToken ? parseInt(input.pageToken, 10) : 0;
  const page = events.slice(off, off + size);
  return { events: page, nextPageToken: off + size < events.length ? String(off + size) : null, summary: cal === ME ? ME : cal };
}
