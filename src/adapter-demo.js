/* Public demo of the trainer app: sample data, no sign-in, nothing saved. */
import "./styles.css";
import "./engine-global.js";
import "./app.js";
import { demoAdapter } from "./demo-core.js";
window.TrainerTally.start(demoAdapter());
