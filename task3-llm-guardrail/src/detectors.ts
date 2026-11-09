/**
 * PII detectors. Each detector is three compiled-once regexes plus an `accept` check:
 *
 *  - `full`   finds complete candidates (global flag; callers set `lastIndex` themselves).
 *  - `prefix` is anchored at the end of the text (`$`). It matches any suffix that is, or could
 *             still grow into, a match once more characters arrive. The redactor holds back exactly
 *             the leftmost such suffix, which is what lets a pattern split across chunks be caught
 *             without buffering the whole response.
 *  - `strongPrefix` is a stricter version used only by the idle flush: a suffix matching it has
 *             made real progress toward PII (an "@" for e-mail, any digit run for SSN/card), so it
 *             stays held even when the stream goes quiet. A bare trailing word is released.
 *  - `hint`   a cheap literal pre-filter (like grep's): if the scanned text lacks it ("@" for e-mail,
 *             a digit for SSN/card), the full regex cannot match and is skipped entirely.
 *  - `accept` validates a candidate and returns the accepted length (it may trim a card candidate
 *             to its longest Luhn-valid prefix) or `null` to reject it (SSN area 000/666/9xx, Luhn).
 *
 * Every quantifier is bounded (local part 64, domain 255, 19 card digits), so each regex does a
 * bounded amount of work per start position, and every `prefix` match is short enough to fit
 * the hold-back cap for realistic values. No lookbehind is used: word boundaries are resolved by
 * keeping one character of already-emitted context in front of the scanned text.
 */

export type PiiType = "EMAIL" | "SSN" | "CREDIT_CARD";

export const PII_TYPES: readonly PiiType[] = ["SSN", "CREDIT_CARD", "EMAIL"];

export interface Detector {
  readonly type: PiiType;
  readonly full: RegExp;
  readonly prefix: RegExp;
  readonly strongPrefix: RegExp;
  /** Pre-filter: a match is impossible unless `hint.test(text)` (non-global regex). */
  readonly hint: RegExp;
  /** Returns the accepted match length (<= candidate.length), or null to reject. */
  accept(candidate: string): number | null;
}

/** Luhn checksum over a string of ASCII digits. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const isDigitCode = (c: number): boolean => c >= 48 && c <= 57;

/** SSN: AAA-GG-SSSS or AAA GG SSSS with the same separator twice; SSA never issues area 000,
 *  666 or 900-999, group 00 or serial 0000, so those are rejected as false positives. */
export const ssnDetector: Detector = {
  type: "SSN",
  full: /\b\d{3}([- ])\d{2}\1\d{4}\b/g,
  prefix: /\b(?:\d{1,3}|\d{3}([- ])\d{0,2}|\d{3}([- ])\d{2}\2\d{0,4})$/g,
  strongPrefix: /\b(?:\d{1,3}|\d{3}([- ])\d{0,2}|\d{3}([- ])\d{2}\2\d{0,4})$/g,
  hint: /\d/,
  accept(candidate) {
    const area = Number(candidate.slice(0, 3));
    const group = candidate.slice(4, 6);
    const serial = candidate.slice(7, 11);
    if (area === 0 || area === 666 || area >= 900) return null;
    if (group === "00" || serial === "0000") return null;
    return candidate.length;
  },
};

/** Card: 13-19 digits, optionally separated by single spaces or dashes. The greedy candidate is
 *  trimmed back group by group to its longest Luhn-valid prefix of >= 13 digits, so a card that is
 *  followed by another number ("4111 1111 1111 1111 2024") is still caught, while order numbers,
 *  phone numbers and random 16-digit IDs (90% fail Luhn) pass through untouched. */
export const cardDetector: Detector = {
  type: "CREDIT_CARD",
  full: /\b(?:\d[ -]?){12,18}\d\b/g,
  prefix: /\b(?:\d[ -]?){1,19}$/g,
  strongPrefix: /\b(?:\d[ -]?){1,19}$/g,
  hint: /\d/,
  accept(candidate) {
    // Positions just after each digit; a cut is legal at the end or right before a separator.
    let digits = "";
    const ends: number[] = [];
    for (let i = 0; i < candidate.length; i++) {
      if (isDigitCode(candidate.charCodeAt(i))) {
        digits += candidate[i];
        ends.push(i + 1);
      }
    }
    for (let k = digits.length; k >= 13; k--) {
      const end = ends[k - 1];
      if (end === undefined) continue;
      const atBoundary = end === candidate.length || !isDigitCode(candidate.charCodeAt(end));
      if (atBoundary && luhnValid(digits.slice(0, k))) return end;
    }
    return null;
  },
};

/** E-mail: pragmatic RFC 5321-ish shape with bounded parts (local <= 64, domain <= 255). */
export const emailDetector: Detector = {
  type: "EMAIL",
  full: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,63}/g,
  prefix: /[A-Za-z0-9._%+-]{1,64}(?:@[A-Za-z0-9.-]{0,320})?$/g,
  strongPrefix: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{0,320}$/g,
  hint: /@/,
  accept(candidate) {
    return candidate.length;
  },
};

/** The "@domain.tld" rest of an e-mail whose local part an idle flush has already released. Sticky
 *  (`y`): they only ever match at the cut point, where the redactor sets `lastIndex`. */
export const orphanEmailTail = /@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,63}/y;
export const orphanEmailTailPrefix = /@[A-Za-z0-9.-]{0,320}$/y;
export const isEmailLocalChar = (c: string): boolean => /^[A-Za-z0-9._%+-]$/.test(c);

/** Priority order breaks ties between candidates with the same start and the same length. */
export const DEFAULT_DETECTORS: readonly Detector[] = [ssnDetector, cardDetector, emailDetector];
