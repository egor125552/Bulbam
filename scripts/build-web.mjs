import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";

const checkOnly = process.argv.includes("--check");
const result = await build({
  entryPoints: ["web/boot.js"],
  bundle: true,
  write: false,
  format: "esm",
  minify: true,
  target: ["safari16", "chrome110", "firefox115"],
  legalComments: "none"
});
const bytes = result.outputFiles[0].contents;
const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const file = `boot.${hash}.js`;
const indexPath = "web/index.html";
const index = await readFile(indexPath, "utf8");
const revised = index.replace(/\/boot(?:\.bundle|\.[a-f0-9]{12})?\.js/g, `/${file}`);
if (revised === index && !index.includes(`/${file}`)) throw Error("Boot import not found in HTML");
const oldBundles = (await readdir("web")).filter((name) => /^boot\.[a-f0-9]{12}\.js$/.test(name));
const swPath = "web/sw.js";
const swOriginal = await readFile(swPath, "utf8");
const shellDigest = createHash("sha256").update(bytes)
  .update(await readFile("web/styles.css"))
  .update(await readFile("web/canonical-ui.css"))
  .digest("hex").slice(0, 12);
const swRevised = swOriginal.replace(/const SHELL_CACHE = "bulbam-shell-[^"]+";/,
  `const SHELL_CACHE = "bulbam-shell-${shellDigest}";`);
if (checkOnly) {
  if (revised !== index || swRevised !== swOriginal ||
      oldBundles.length !== 1 || oldBundles[0] !== file ||
      !Buffer.from(await readFile(`web/${file}`)).equals(Buffer.from(bytes))) {
    throw Error("Boot bundle is out of sync. Run npm run build:web and commit the generated HTML/bundle.");
  }
} else {
  for (const name of oldBundles) if (name !== file) await unlink(`web/${name}`);
  await writeFile(`web/${file}`, bytes);
  if (revised !== index) await writeFile(indexPath, revised);
  if (swRevised !== swOriginal) await writeFile(swPath, swRevised);
}
console.log(`Boot bundle: ${file}, ${bytes.length} bytes${checkOnly ? " (verified)" : ""}`);
