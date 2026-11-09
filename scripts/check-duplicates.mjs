// Repo-wide hygiene checks run by `npm run check`:
//  1. No console.log / console.info / console.debug in any task's src/ (stdout must stay clean).
//  2. No duplicate test names within a task.
//  3. Report (not fail) source files whose basenames repeat across tasks, except the allow-list,
//     so accidental copy-paste between tasks is visible.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tasks = readdirSync(root).filter((d) => /^task\d-/.test(d));
const allowShared = new Set(["index.ts", "logger.ts", "config.ts", "jsonrpc.ts", "errors.ts", "http.ts", "types.ts", "gateway.ts", "server.ts", "helpers.ts"]);
let failures = 0;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const seenBasenames = new Map();
for (const t of tasks) {
  const src = join(root, t, "src");
  const test = join(root, t, "test");
  for (const f of walk(src)) {
    const text = readFileSync(f, "utf8");
    const bad = text.match(/^\s*console\.(log|info|debug)\(/gm);
    if (bad) {
      console.error(`FAIL ${relative(root, f)}: ${bad.length} console.${bad[0].match(/console\.(\w+)/)[1]} call(s) write to stdout`);
      failures++;
    }
    const b = basename(f);
    if (!allowShared.has(b)) seenBasenames.set(b, [...(seenBasenames.get(b) ?? []), relative(root, f)]);
  }
  const names = new Map();
  for (const f of walk(test)) {
    for (const m of readFileSync(f, "utf8").matchAll(/^\s*(?:it|test)\(\s*(["'`])(.*?)\1/gm)) {
      const key = `${f}::${m[2]}`;
      if (names.has(key)) { console.error(`FAIL duplicate test name in ${relative(root, f)}: "${m[2]}"`); failures++; }
      names.set(key, true);
    }
  }
}
for (const [b, files] of seenBasenames) {
  if (files.length > 1) console.error(`note: basename ${b} appears in ${files.length} tasks: ${files.join(", ")}`);
}
if (failures) { console.error(`${failures} hygiene failure(s)`); process.exit(1); }
console.error("hygiene checks passed");
