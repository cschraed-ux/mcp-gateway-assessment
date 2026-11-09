/**
 * In-memory customer repository. Pure (no I/O) so tests are deterministic; clock and id
 * generator are injectable. Amounts are handled in integer cents internally to avoid float drift.
 */
import { randomUUID } from "node:crypto";
import type { CustomerRecordResult, RefundResult } from "./schemas.js";

export interface Deps {
  now: () => Date;
  newId: () => string;
}

export type RefundOutcome =
  | { ok: true; refund: RefundResult }
  | { ok: false; code: "NOT_FOUND" | "INSUFFICIENT_BALANCE"; message: string };

interface Stored {
  customer_id: string;
  name: string;
  email: string;
  balanceCents: number;
  refunds: { refund_id: string; amount: number; reason: string; created_at: string }[];
}

const SEED: Stored[] = [
  { customer_id: "CUST-00001", name: "Ada Lovelace", email: "ada@example.com", balanceCents: 25_000, refunds: [] },
  { customer_id: "CUST-00002", name: "Grace Hopper", email: "grace@example.com", balanceCents: 120_050, refunds: [] },
  {
    customer_id: "CUST-00003", name: "Alan Turing", email: "alan@example.com", balanceCents: 5_000,
    refunds: [{ refund_id: "00000000-0000-4000-8000-000000000001", amount: 12.5, reason: "Duplicate charge on invoice", created_at: "2025-01-15T10:00:00.000Z" }],
  },
  { customer_id: "CUST-00004", name: "Edsger Dijkstra", email: "edsger@example.com", balanceCents: 0, refunds: [] },
  { customer_id: "CUST-00005", name: "Barbara Liskov", email: "barbara@example.com", balanceCents: 5_000_000, refunds: [] },
];

export class CustomerRepository {
  private readonly data = new Map<string, Stored>();
  private readonly deps: Deps;

  constructor(deps: Partial<Deps> = {}) {
    this.deps = { now: deps.now ?? (() => new Date()), newId: deps.newId ?? (() => randomUUID()) };
    for (const s of SEED) this.data.set(s.customer_id, structuredClone(s));
  }

  private view(s: Stored): CustomerRecordResult {
    return {
      customer_id: s.customer_id,
      name: s.name,
      email: s.email,
      balance: s.balanceCents / 100,
      refunds: s.refunds.map((r) => ({ ...r })),
    };
  }

  getCustomer(id: string): CustomerRecordResult | undefined {
    const s = this.data.get(id);
    return s ? this.view(s) : undefined;
  }

  applyRefund(id: string, amount: number, reason: string): RefundOutcome {
    const s = this.data.get(id);
    if (!s) return { ok: false, code: "NOT_FOUND", message: `Customer ${id} not found` };
    const cents = Math.round(amount * 100);
    if (cents > s.balanceCents) {
      return {
        ok: false,
        code: "INSUFFICIENT_BALANCE",
        message: `Refund of ${amount.toFixed(2)} exceeds available balance of ${(s.balanceCents / 100).toFixed(2)} for ${id}`,
      };
    }
    s.balanceCents -= cents;
    const rec = {
      refund_id: this.deps.newId(),
      amount: cents / 100,
      reason,
      created_at: this.deps.now().toISOString(),
    };
    s.refunds.push(rec);
    return { ok: true, refund: { ...rec, customer_id: id, new_balance: s.balanceCents / 100 } };
  }
}
