// Builds the single-file claude.ai artifact from the shared sources.
// Usage: node scripts/build-artifact.mjs   ->  dist-artifact/index.html
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(join(root, p), "utf8");
const safeScript = s => s.replace(/<\/script/gi, "<\\/script");

const html = `<title>Trainer Tally</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
${read("src/styles.css")}
</style>
${read("src/shell.html")}
<script>
${safeScript(read("src/app.js"))}
</script>
<script>
${safeScript(read("src/adapter-claude.js"))}
</script>
`;
mkdirSync(join(root, "dist-artifact"), { recursive: true });
writeFileSync(join(root, "dist-artifact/index.html"), html);
console.log("dist-artifact/index.html", (html.length / 1024).toFixed(1) + " KB");
