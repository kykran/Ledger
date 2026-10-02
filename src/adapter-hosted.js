/* Trainer Tally adapter for the hosted web app.
 * Data: Supabase (row-level security keeps each trainer's rows private).
 * Calendar: /api/calendar, which calls Google with the trainer's stored refresh token.
 * Same contract as adapter-claude.js — see the top of app.js. */
import "./styles.css";
import "./engine-global.js";
import "./app.js";
import "./programs.js";
import adapter from "./adapter-hosted-core.js";

window.TrainerTally.start(adapter);
