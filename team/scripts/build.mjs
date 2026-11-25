import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFile(root + path, "utf8");
const files = Object.fromEntries(await Promise.all(
  ["index.html", "app.js", "movie.js", "production.js", "board-data.js", "storyboard.js", "style.css"].map(async (name) => [name, await read("client/" + name)]),
));
await mkdir(root + "dist/server", { recursive: true });
await mkdir(root + "dist/.openai", { recursive: true });
await copyFile(root + ".openai/hosting.json", root + "dist/.openai/hosting.json");
// The hosting entry is a single Worker module. Reuse the same board validation as the browser.
const shared = files["board-data.js"].replace(/^export /gm, "");
const worker = (await read("worker/index.js")).replace(/^import .* from "\.\.\/client\/board-data\.js";\n/m, "");
await writeFile(root + "dist/server/index.js", "const assets = " + JSON.stringify(files) + ";\n" + shared + "\n" + worker);
