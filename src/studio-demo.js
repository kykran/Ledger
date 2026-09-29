/* Public demo of the studio side. Installs the in-memory backend, then loads the real studio app. */
import { demoStudioBackend } from "./demo-core.js";
window.__ttStudioBackend = demoStudioBackend();
import("./studio.js");
