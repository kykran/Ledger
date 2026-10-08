# Trainer Tally — handoff for the next agent

Last updated 2026-10-08. Read this first, then `README.md` for setup and launch details.

## Who you're working for

**Kyle Kranzky** owns and trains at Elite Training Group (ETG), a one-on-one personal training studio in Boston's South End. He uses Trainer Tally for his own clients every day, and his wife Tatjana trains some of the same clients. He tests on desktop in dark mode and on his phone.

How he likes to work:
- **Plain language.** He's a trainer, not a developer. Explain what changed on screen and what to tap. Skip file names and jargon.
- **Show, then ship.** Put changes on a Vercel preview with the demo link (`/programs?demo` or `/demo.html`) first. Merge when he says so ("lets do it", "good", "ship it"). Small fixes that unblock him on the live site can go straight out.
- **Short feedback, often a screenshot.** Read the screenshot carefully. It usually shows the live site, which may be behind the preview.
- He judges the app by speed during a live session. Fewer taps and less on screen beat more features.

## The product

Trainer Tally is a web app at **https://trainertally.app**. It has two halves:

1. **Billing:** counts sessions from Google Calendar and handles packages, monthly bills, studio rent, renewal reminders and client "sessions left" pages. This half is mature.
2. **Programs** (`/programs`), Kyle's replacement for TrueCoach: client programs, an exercise library, logging, progress charts and an AI assistant. This half is where active work happens.

The product direction Kyle chose is **"AI that makes the in-person trainer faster during the session."** That rules out "AI writes programs for online coaches to resell." The differentiator is a tool built for in-person studios that combines billing, programs and logging. He may sell it to other trainers and studios. The plan is $3/month for trainers, with Stripe already wired.

## Accounts and access

| What | Where | Notes |
|---|---|---|
| Code | GitHub **kykran/Ledger** | Use the **kykran** account only. Never touch Kyle's other GitHub account (kkranzky). |
| Hosting | Vercel team `ledger-7c96`, project `ledger` (`prj_L6gpSYPAFOTyyQHBXvfmH3qYJ33a`) | Every merge to `main` deploys to production. Each PR gets a preview. |
| Database + auth | Supabase project `qfxccxhltjavvztfvgqv` | Row-level security per trainer. Use the service role only in `/api`. |
| Domain | trainertally.app | Bought through Vercel. |

**Vercel environment variables are set for Production only.** Preview deployments have no database, so the real app shows "Your clients and numbers appear here once the app connects." Test previews with the demo pages, which run on sample data.

## Workflow that works here

- Branch, then open a PR **with the REST API** (`gh api repos/kykran/Ledger/pulls ...`), because GraphQL `gh pr create` is blocked in these sessions. Merge with `gh api -X PUT repos/kykran/Ledger/pulls/N/merge -f merge_method=squash`.
- Commit as `-c user.name=Kyle -c user.email=kykran@gmail.com`.
- **Shallow clone quirk:** after pushing a new branch, the stop hook may say "no remote branch". Fix it with `git config --add remote.origin.fetch '+refs/heads/BRANCH:refs/remotes/origin/BRANCH' && git fetch origin`.
- Don't commit `vite.log`; it's in `.gitignore`.
- **Testing:** `npx vite --port 5179`, then Playwright (Python, Chromium preinstalled) against `http://localhost:5179/demo.html` → Programs tab. Check desktop (1400px) and phone (390px, `is_mobile`), in light and dark mode. `window.TallyPrograms.state` exposes app state for assertions. Run `npx vite build` before every push.
- To look at a real client's numbers, query Supabase read-only. When checking client-page logic, rebuild the model locally from `profiles`, `clients` and `calendar_events` with `engine.compute`, the same way `api/_sync.js modelFor` does.

## Code map

```
src/app.js            billing app shell + screens (shared by hosted + claude.ai builds)
src/engine.js         billing engine: compute(), packageStats(), clientView() for /s/<token>
src/programs.js       Programs UI (big file, ~1500 lines): render + all handlers + CSS string
src/programs-core.js  pure helpers, testable in node: parsers, TrueCoach import, lift math
src/programs-voice.js mic capture + browser speech fallback for voice logging
src/client-page.js    client "sessions left" page (/s/<token>)
src/program-page.js   client program/homework page (/p/<token>)
src/adapter-hosted*.js  Supabase storage + /api calls; programs-demo.js = demo stand-in
api/                  Vercel functions: ai.js (Programs assistant), voice.js, program.js,
                      client-view.js, sync/cron/calendar, billing (Stripe), outbox (email)
supabase/*.sql        schema, applied in order: schema, studio, automation, signoff, programs, programs_sharing
```

## Programs: how it works now

**Data model** (`programs.data` JSON): `{name, clientId, status, startDate, imported?, weeks:[{id,label,sessions:[{id,name,day?,homework,notes,rows:[{id,exId,name,group,sets,reps,weight,note}]}]}]}`
- `day` is the weekday (0 = Sunday) and is optional. A program week N covers `startDate + 7N` days. `sessionForDate()` in core puts a dated workout on its weekday and fills the remaining booked calendar days with undated workouts in order. Workout emails and the Calendar view both use it.
- `program_logs` stores one row per set (`reps`, `weight`, `done`, `logged_on`) and snapshots `ex_name`, so history survives edits. Lift history, "Last time" and change badges all key on the exercise name (case-insensitive).

**Modes and views** (top bar of a program):
- **Record** is the default. Each exercise is a single text line. Clicking the exercise name edits it in place, and the 🎙 button does voice logging.
- **Plan** shows the **week board**: weeks stacked vertically, each a row of day columns. A week with nothing written yet always opens in Plan (`modeFor()` / `PG.draftWeek`).
- **Days / Calendar.** Calendar scrolls through all weeks with a summary of each workout. Tapping "nothing written" creates a workout on that day in Plan.
- Board features: day picker on each card, ⋯ menu, drag the ⠿ grip to another day or onto another workout to swap them (keyboard ← →), "⧉ Copy Day A" on booked empty days, and older undated workouts are auto-placed on their booked day.

**Number formats. Kyle cares about these; don't change them:**
- **Log line = weight × reps.** `215x5 215x5 225x4`, `215x5x3` (3 sets), `8 8 6` (reps at the planned weight), `12 12 bw`. Parser: `parseSetLog` / `fmtSetLog`.
- **Plan field = sets × reps.** `3x8`, `3x8,8,6`, `4x8-10`, `3x8 each`. Parser: `parseSetsReps`. The plan is displayed in words ("4 sets of 5 @ 215") so it can't be confused with the log line.

**Multiple weeks on screen:** every handler calls `wkFrom(el)` to set `PG.week` from the nearest `[data-wk]`, and lookups use `inWk(selector)`. Follow this pattern for anything new on the board, or actions will land in the wrong week.

**Other features:**
- **AI assistant** (`api/ai.js`, Claude Haiku 4.5): Draft, Critique and Progress (with a direction such as stability or strength). Reads the client's programming notes and flags contraindications. The trainer reviews everything before anything saves.
- **Voice logging** (`api/voice.js`): transcribes (OpenAI, optional) or uses the browser's own speech recognition, then Haiku maps the words onto that day's exercises. A card to confirm appears; nothing saves until the trainer confirms.
- **TrueCoach import** (⋯ More → Import from TrueCoach): reads TrueCoach's per-client workout .txt export (`parseTrueCoach` / `truecoachToProgram`, including fixes for common typos). History is saved as an archived program flagged `imported: "truecoach"` (never added to the library), plus set logs. Optionally it starts a new program from the latest week. Tested on a real 336-workout, 3-year export.
- **Progress:** Bench / Back squat / Deadlift cards (`STANDARD_LIFTS`, `standardLiftHistory`), bodyweight, 4-site body fat (Jackson-Pollock) and a chart for any lift.
- **Client sessions page** (`/s/<token>`): package clients see sessions numbered 1–N for the current package (including `used0` carry-over), then a separate "Next package" card.

## Open items, most useful first

1. **`ANTHROPIC_API_KEY` is not set in Vercel**, so the ✦ AI assistant and voice logging are off on the live site. `OPENAI_API_KEY` (optional) improves voice accuracy. Kyle has to add the keys himself; never ask for them in chat.
2. **The `program_shares` table doesn't exist** in the live database (`supabase/programs_sharing.sql` was never run), so "Share with a trainer" stays hidden. Apply it when Kyle wants to share programs with Tatjana.
3. **Mary Hunt's TrueCoach history isn't imported yet.** Kyle has the file and the feature is live.
4. **Untested on real hardware:** dragging workouts by finger on a phone, and voice logging in the gym.
5. **Client renewal:** Chris Amory is 4 sessions past his 24-pack (package started 6/25, last covered session 9/24). His link: https://trainertally.app/s/5_EvHpv2nPU4ZiDJiUxX8mn2
6. **Before selling to other trainers:** Google OAuth verification (the `calendar.readonly` scope; see README §5), Stripe live mode, and per-trainer onboarding.
7. **Ideas Kyle liked, not built yet:** a pre-session brief (last numbers, what to progress, flags), one-tap live exercise swaps that respect injuries, auto wrap-up (homework + recap text), pattern spotting across weeks, and "switch from TrueCoach in 10 minutes" as a sales hook.

## Gotchas

- `src/programs.js` holds its CSS in one string. Global class names collide with app styles (`.mini` already did once and collapsed cards to 22px), so prefix new classes with `pg-`.
- `redraw()` keeps focus by rebuilding a selector from `data-*` attributes. When the same field exists twice (hidden builder row plus a visible editor), it picks the visible one. Keep that in mind when adding duplicate inputs.
- Flex children with `overflow` can shrink to nothing. The board uses `flex:0 0 auto`, and snap scrolling is turned off while dragging.
- Calendar event titles map to clients by name or alias (e.g. "Chris / Kyle - remote!"). Titles with no-rent words count as sessions but owe no rent.
