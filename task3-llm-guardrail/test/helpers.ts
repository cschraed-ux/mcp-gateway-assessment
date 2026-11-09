// Shared test utilities: a seeded RNG and a generator of PII-laden text.
import { luhnValid } from "../src/detectors.js";

/** mulberry32: tiny deterministic PRNG so property tests are reproducible. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const int = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const digits = (rng: () => number, n: number): string => Array.from({ length: n }, () => String(int(rng, 0, 9))).join("");

export function luhnCheckDigit(body: string): string {
  for (let d = 0; d <= 9; d++) if (luhnValid(body + d)) return String(d);
  throw new Error("unreachable");
}

export function validCard(rng: () => number): string {
  const body = pick(rng, ["4", "51", "37", "6011"]);
  const len = body === "37" ? 15 : 16;
  const raw = body + digits(rng, len - 1 - body.length);
  const full = raw + luhnCheckDigit(raw);
  return groupDigits(rng, full);
}

export function invalidLuhn16(rng: () => number): string {
  const raw = "4" + digits(rng, 14);
  const good = Number(luhnCheckDigit(raw));
  const full = raw + String((good + int(rng, 1, 9)) % 10);
  return groupDigits(rng, full);
}

function groupDigits(rng: () => number, s: string): string {
  const sep = pick(rng, ["", " ", "-"]);
  if (sep === "") return s;
  return s.match(/.{1,4}/g)!.join(sep);
}

export function validSsn(rng: () => number): string {
  const area = String(int(rng, 1, 899)).padStart(3, "0");
  const a = area === "666" ? "667" : area;
  const sep = pick(rng, ["-", " "]);
  return `${a}${sep}${String(int(rng, 1, 99)).padStart(2, "0")}${sep}${String(int(rng, 1, 9999)).padStart(4, "0")}`;
}

export function email(rng: () => number): string {
  const local = pick(rng, ["john", "jane.doe", "a.b+tag", "x_99", "ops-team", "Q"]) + (rng() < 0.5 ? String(int(rng, 0, 99)) : "");
  const domain = pick(rng, ["example.com", "mail.example.co.uk", "corp-1.io", "x.org"]);
  return `${local}@${domain}`;
}

const SAFE = ["the", "quick", "brown", "fox", "Hello,", "world.", "order", "total:", "is", "and", "(see", "note)", "café", "naïve", "😀", "data-driven", "v1.2.3", "a@", "@b", "re:"];

/**
 * Random text mixing safe words, PII, and look-alikes. By default separators are random and
 * sometimes empty, which glues tokens into long adversarial runs; `separated` always puts
 * whitespace or punctuation-plus-space between tokens, like prose.
 */
export function randomText(rng: () => number, separated = false): string {
  const n = int(rng, 1, 40);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    let tok: string;
    if (r < 0.45) tok = pick(rng, SAFE);
    else if (r < 0.55) tok = email(rng);
    else if (r < 0.65) tok = validSsn(rng);
    else if (r < 0.75) tok = validCard(rng);
    else if (r < 0.82) tok = invalidLuhn16(rng);
    else if (r < 0.9) tok = pick(rng, ["555-123-4567", "(555) 123-4567", "+1 555 123 4567"]);
    else tok = pick(rng, ["2024-01-15", "01/15/2024", "15.01.2024", String(int(rng, 0, 99999))]);
    parts.push(tok);
    parts.push(separated ? pick(rng, [" ", ", ", ". ", "\n", "\t"]) : pick(rng, [" ", " ", " ", ", ", ". ", "\n", "", "-", "\t"]));
  }
  return parts.join("");
}

/** Splits text into chunks; strategy chosen by index so 1-char and whole-text cases always occur. */
export function randomChunks(rng: () => number, text: string, variant: number): string[] {
  if (variant === 0) return text.split("");
  if (variant === 1) return [text];
  const max = variant % 3 === 0 ? 3 : variant % 3 === 1 ? 12 : 70;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = int(rng, 1, max);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}
