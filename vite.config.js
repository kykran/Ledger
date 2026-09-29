import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

// Injects src/shell.html into index.html so the hosted app and the claude.ai build share one markup file.
const shell = () => ({
  name: "tally-shell",
  transformIndexHtml: html => html.replace("<!-- shell -->", readFileSync(new URL("./src/shell.html", import.meta.url), "utf8"))
});

export default defineConfig({ plugins: [shell()] });
