/**
 * Zod 4 input/output schemas for both tools. Policy decisions live in named constants so they
 * are easy to change: "XXXXX" in CUST-XXXXX is interpreted as exactly five digits; money has at
 * most two decimal places (so at least 0.01); a single refund may not exceed MAX_REFUND_AMOUNT (env-overridable).
 * Object schemas are strict so unknown fields are rejected rather than silently dropped.
 */
import { z } from "zod";

export const CUSTOMER_ID_PATTERN = /^CUST-\d{5}$/;

function readMax(): number {
  const n = Number(process.env["MAX_REFUND_AMOUNT"]);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}
export const MAX_REFUND_AMOUNT = readMax();
export const REASON_MIN = 10;
export const REASON_MAX = 500;

export const CustomerId = z
  .string()
  .regex(CUSTOMER_ID_PATTERN, "customer_id must match CUST-XXXXX (exactly five digits)");

/** True when the amount has at most 2 decimal places (tolerant of float representation). */
function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(Math.round(n * 100) - n * 100) < 1e-7;
}

export const Amount = z
  .number()
  .min(0.01, "amount must be at least 0.01")
  .finite("amount must be finite")
  .refine(hasAtMostTwoDecimals, "amount must have at most 2 decimal places")
  .max(MAX_REFUND_AMOUNT, `amount must not exceed ${MAX_REFUND_AMOUNT}`);

export const Reason = z
  .string()
  .trim()
  .min(REASON_MIN, `reason must be at least ${REASON_MIN} characters (after trimming)`)
  .max(REASON_MAX, `reason must be at most ${REASON_MAX} characters`);

export const GetCustomerRecordInput = z.strictObject({ customer_id: CustomerId });
export const TriggerRefundInput = z.strictObject({
  customer_id: CustomerId,
  amount: Amount,
  reason: Reason,
});

const RefundRecord = z.object({
  refund_id: z.string(),
  amount: z.number(),
  reason: z.string(),
  created_at: z.string(),
});

export const CustomerRecordOutput = z.object({
  customer_id: z.string(),
  name: z.string(),
  email: z.string(),
  balance: z.number(),
  refunds: z.array(RefundRecord),
});

export const RefundOutput = z.object({
  refund_id: z.string(),
  customer_id: z.string(),
  amount: z.number(),
  reason: z.string(),
  created_at: z.string(),
  new_balance: z.number(),
});

export type GetCustomerRecordArgs = z.infer<typeof GetCustomerRecordInput>;
export type TriggerRefundArgs = z.infer<typeof TriggerRefundInput>;
export type CustomerRecordResult = z.infer<typeof CustomerRecordOutput>;
export type RefundResult = z.infer<typeof RefundOutput>;
