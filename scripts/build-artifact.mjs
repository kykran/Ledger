// Builds the single-file claude.ai artifact from the shared sources.
// Usage: node scripts/build-artifact.mjs   ->  dist-artifact/index.html
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(join(root, p), "utf8");
const safeScript = s => s.replace(/<\/script/gi, "<\\/script");
// The engine is an ES module for the server; here it becomes a plain script that sets globalThis.TallyEngine.
function engineScript(){
  const src = read("src/engine.js");
  const names = [...src.matchAll(/^export (?:const|function|async function|let) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  return "(function(){\n" + src.replace(/^export /gm, "") + "\nglobalThis.TallyEngine = {" + names.join(", ") + "};\n})();";
}

const html = `<title>Trainer Tally</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
${read("src/styles.css")}
</style>
${read("src/shell.html")}
<script>
${safeScript(engineScript())}
</script>
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
