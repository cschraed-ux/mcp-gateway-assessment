import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

describe("source hygiene", () => {
  it("has no console.log( or process.stdout.write( in src", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
      if (!f.endsWith(".ts")) continue;
      const text = readFileSync(join(srcDir, f), "utf8");
      if (/console\.log\(|process\.stdout\.write\(/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
