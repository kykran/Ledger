/* Makes the shared engine available to app.js (a classic script shared with the claude.ai build). */
import * as Engine from "./engine.js";
globalThis.TallyEngine = Engine;
