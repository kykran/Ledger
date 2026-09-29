import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));

// Injects src/shell.html into each page so the hosted app, the studio side and the claude.ai build share one markup file.
const shell = () => ({
  name: "tally-shell",
  transformIndexHtml: html => html.replace("<!-- shell -->", readFileSync(new URL("./src/shell.html", import.meta.url), "utf8"))
});

export default defineConfig({
  plugins: [shell()],
  build: { rollupOptions: { input: { main: resolve(here, "index.html"), studio: resolve(here, "studio.html") } } }
});
