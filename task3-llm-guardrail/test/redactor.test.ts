import { describe, expect, it } from "vitest";
import { luhnValid } from "../src/detectors.js";
import { REDACTED, StreamRedactor, createRedactorTransform, redactText } from "../src/redactor.js";
import { randomChunks, randomText, seededRng, validCard } from "./helpers.js";

function streamThrough(chunks: readonly string[], r = new StreamRedactor()): { out: string; pieces: string[]; r: StreamRedactor } {
  const pieces = chunks.map((c) => r.push(c));
  pieces.push(r.flush());
  return { out: pieces.join(""), pieces, r };
}

const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe("streaming equals full-text redaction (property test)", () => {
  // With the default 320 cap no candidate is ever cut, even when tokens are glued into long
  // adversarial runs. A tight 64 cap is also checked, on prose, where candidates fit in it.
  const check = (seed: number, separated: boolean, maxHold: number): number => {
    const rng = seededRng(seed);
    let checked = 0;
    for (let t = 0; t < 200; t++) {
      const text = randomText(rng, separated);
      const expected = redactText(text);
      for (let v = 0; v < 20; v++) {
        const chunks = randomChunks(rng, text, v);
        expect(chunks.join("")).toBe(text);
        const r = new StreamRedactor({ maxHold });
        const { out } = streamThrough(chunks, r);
        if (out !== expected) {
          throw new Error(`mismatch\ntext=${JSON.stringify(text)}\nchunks=${JSON.stringify(chunks)}\nstream=${JSON.stringify(out)}\nfull  =${JSON.stringify(expected)}`);
        }
        expect(r.maxHeld).toBeLessThanOrEqual(maxHold);
        checked++;
      }
    }
    return checked;
  };

  it("holds for 200 adversarial texts x 20 random chunkings each (default 320 cap)", () => {
    expect(check(20261108, false, 320)).toBe(4000);
  });

  it("holds for 200 prose-like texts x 20 chunkings with a 64-char cap", () => {
    expect(check(424242, true, 64)).toBe(4000);
  });

  it("holds with typed labels too", () => {
    const rng = seededRng(7);
    for (let t = 0; t < 50; t++) {
      const text = randomText(rng);
      const chunks = randomChunks(rng, text, 2 + (t % 18));
      const { out } = streamThrough(chunks, new StreamRedactor({ typedLabels: true }));
      expect(out).toBe(redactText(text, { typedLabels: true }));
    }
  });

  it("generated PII is actually redacted (the generator is not vacuous)", () => {
    const rng = seededRng(99);
    let redactions = 0;
    for (let t = 0; t < 50; t++) redactions += count(redactText(randomText(rng)), REDACTED);
    expect(redactions).toBeGreaterThan(100);
  });
});

describe("boundary cases", () => {
  it("catches an email split as john.d | oe@exam | ple.com rest", () => {
    const r = new StreamRedactor();
    expect(r.push("Contact john.d")).toBe("Contact ");
    expect(r.push("oe@exam")).toBe("");
    expect(r.push("ple.com rest")).toBe(`${REDACTED} `);
    expect(r.flush()).toBe("rest");
  });

  it("catches an SSN split between every character", () => {
    const { out, r } = streamThrough("SSN: 123-45-6789.".split(""));
    expect(out).toBe(`SSN: ${REDACTED}.`);
    expect(r.stats.redactions.SSN).toBe(1);
  });

  it("catches a space-separated SSN split between every character", () => {
    expect(streamThrough("id 123 45 6789 ok".split("")).out).toBe(`id ${REDACTED} ok`);
  });

  it("catches a spaced card split mid-group", () => {
    const { out } = streamThrough(["pay with 4111 11", "11 1111 1", "111 today"]);
    expect(out).toBe(`pay with ${REDACTED} today`);
  });

  it("catches a card followed by another number (trims to the Luhn-valid prefix)", () => {
    expect(redactText("4111 1111 1111 1111 2024")).toBe(`${REDACTED} 2024`);
  });

  it("redacts two emails back to back", () => {
    const text = "a@x.com,b@y.org c@z.io";
    expect(streamThrough(text.split("")).out).toBe(`${REDACTED},${REDACTED} ${REDACTED}`);
  });

  it("reveals an email at the very end only on flush", () => {
    const r = new StreamRedactor();
    expect(r.push("write to ops@example.com")).toBe("write to ");
    expect(r.heldChars).toBe("ops@example.com".length);
    expect(r.flush()).toBe(REDACTED);
  });

  it("holds an email that could still grow (a@b.co then .uk)", () => {
    const r = new StreamRedactor();
    expect(r.push("x a@b.co")).toBe("x ");
    expect(r.push(".uk!")).toBe(`${REDACTED}!`);
  });

  it("streams PII-free text immediately, holding at most the last word", () => {
    const r = new StreamRedactor();
    const out = r.push("The quick brown fox jumps over the lazy dog");
    expect(out).toBe("The quick brown fox jumps over the lazy ");
    expect(r.heldChars).toBe(3);
    expect(r.flush()).toBe("dog");
    expect(r.maxHeld).toBeLessThanOrEqual(320);
  });

  it("never re-matches or holds a [REDACTED] token", () => {
    const r = new StreamRedactor();
    const out = r.push("a@b.com and ");
    expect(out).toBe(`${REDACTED} and `);
    expect(r.heldChars).toBe(0);
  });

  it("does not split a surrogate pair when the hold cap forces a cut", () => {
    const r = new StreamRedactor({ maxHold: 4 });
    const pieces = ["😀abcdefgh", "ij"].map((c) => r.push(c));
    pieces.push(r.flush());
    for (const p of pieces) expect(p).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(pieces.join("")).toBe("😀abcdefghij");
  });

  it("a lone high surrogate before a card does not pull the card's first digit out with it", () => {
    const text = "x\ud8344111 1111 1111 1111 ok";
    const r = new StreamRedactor();
    const out = r.push(text.slice(0, 6)) + r.push(text.slice(6)) + r.flush();
    expect(out).toBe(redactText(text));
    expect(out).toBe(`x\ud834${REDACTED} ok`);
  });
});

describe("false positives", () => {
  const untouched = [
    "order 1234-5678 shipped",
    "call 555-123-4567 now",
    "call (555) 123-4567 now",
    "ref 1234567812345678 is not a card",
    "ISBN 978-0-306-40615-7 is a book",
    "user_12345678901234 is an id",
    "date 2024-01-15 and 01/15/2024",
    "SSN-like 000-12-3456, 666-12-3456, 912-12-3456, 123-00-4567, 123-45-0000",
    "mixed separators 123-45 6789",
    "version v1.2.3 and a@ alone and @handle",
  ];
  for (const text of untouched) {
    it(`leaves "${text}" untouched`, () => {
      expect(redactText(text)).toBe(text);
      expect(streamThrough(text.split("")).out).toBe(text);
    });
  }

  it("checks the ISBN fixture really fails Luhn", () => {
    expect(luhnValid("9780306406157")).toBe(false);
  });
});

describe("stats and the hold cap", () => {
  it("counts redactions by type", () => {
    const rng = seededRng(3);
    const text = `a@b.com 123-45-6789 ${validCard(rng)} c@d.org`;
    const { r } = streamThrough(text.split(""));
    expect(r.stats.redactions).toEqual({ EMAIL: 2, SSN: 1, CREDIT_CARD: 1, total: 4 });
    expect(r.stats.charsIn).toBe(text.length);
    expect(r.stats.heldChars).toBe(0);
  });

  it("never holds more than maxHold, even for a pathological unbroken token", () => {
    const r = new StreamRedactor({ maxHold: 16 });
    for (let i = 0; i < 500; i++) {
      r.push(i % 7 === 0 ? "a.b" : "x");
      expect(r.heldChars).toBeLessThanOrEqual(16);
    }
    expect(r.maxHeld).toBeLessThanOrEqual(16);
  });

  it("supports typed labels", () => {
    expect(redactText("mail a@b.com, ssn 123-45-6789", { typedLabels: true })).toBe("mail [REDACTED:EMAIL], ssn [REDACTED:SSN]");
  });
});

describe("TransformStream wrapper", () => {
  async function run(chunks: string[], opts = {}): Promise<string[]> {
    const ts = createRedactorTransform(opts);
    const writer = ts.writable.getWriter();
    const read = (async () => {
      const out: string[] = [];
      for await (const c of ts.readable as unknown as AsyncIterable<string>) out.push(c);
      return out;
    })();
    for (const c of chunks) await writer.write(c);
    await writer.close();
    return read;
  }

  it("redacts across chunk boundaries", async () => {
    const out = await run(["mail jane", "@exa", "mple.com", " now"]);
    expect(out.join("")).toBe(`mail ${REDACTED} now`);
  });

  it("idle flush releases a held plain word but keeps a partial email held", async () => {
    const fns: (() => void)[] = [];
    const timers = { setTimeout: (fn: () => void) => (fns.push(fn), fns.length), clearTimeout: () => undefined };
    const ts = createRedactorTransform({ idleFlushMs: 100, timers });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    // The readable side has no buffer, so a write completes only once a read is pending.
    const step = async (chunk: string): Promise<string | undefined> => {
      const read = reader.read();
      await writer.write(chunk);
      return (await read).value;
    };
    expect(await step("hello wor")).toBe("hello ");
    const released = reader.read();
    fns.at(-1)!();
    expect((await released).value).toBe("wor");
    expect(await step("ld, mail jane@exa")).toBe("ld, mail ");
    fns.at(-1)!();
    expect(ts.redactor.heldChars).toBe("jane@exa".length);
    expect(await step("mple.com. ok")).toBe(`${REDACTED}. `);
    const last = reader.read();
    await writer.close();
    expect((await last).value).toBe("ok");
  });

  it("idle flush right before the @ still redacts the domain that follows", () => {
    const r = new StreamRedactor();
    expect(r.push("Mail john.doe")).toBe("Mail ");
    expect(r.releaseIdle()).toBe("john.doe");
    // "@exa" may be the rest of that address: held, and kept held by a second idle flush.
    expect(r.push("@exa")).toBe("");
    expect(r.releaseIdle()).toBe("");
    expect(r.push("mple.com now")).toBe(`${REDACTED} `);
    expect(r.flush()).toBe("now");
    expect(r.stats.redactions.EMAIL).toBe(1);
  });

  it("idle flush before the @ of an address at the very end redacts it on flush", () => {
    const r = new StreamRedactor();
    const out = r.push("to ops") + r.releaseIdle() + r.push("@example.com") + r.flush();
    expect(out).toBe(`to ops${REDACTED}`);
  });

  it("after an idle flush an @handle that is not a domain passes through", () => {
    const r = new StreamRedactor();
    const out = r.push("ping bob") + r.releaseIdle() + r.push("@ and @team now") + r.flush();
    expect(out).toBe("ping bob@ and @team now");
  });
});
