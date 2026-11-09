import { describe, expect, it } from "vitest";
import { CustomerRepository } from "../src/customers.js";

const fixed = () => new CustomerRepository({ now: () => new Date("2026-01-01T00:00:00.000Z"), newId: () => "id-1" });

describe("CustomerRepository", () => {
  it("returns a seeded customer", () => {
    expect(fixed().getCustomer("CUST-00001")?.name).toBe("Ada Lovelace");
  });
  it("returns undefined for unknown customer", () => {
    expect(fixed().getCustomer("CUST-99999")).toBeUndefined();
  });
  it("applies a refund with injected id and clock, reducing balance", () => {
    const repo = fixed();
    const r = repo.applyRefund("CUST-00001", 10.25, "Damaged item on arrival");
    expect(r).toMatchObject({ ok: true, refund: { refund_id: "id-1", created_at: "2026-01-01T00:00:00.000Z", new_balance: 239.75, amount: 10.25 } });
    expect(repo.getCustomer("CUST-00001")?.balance).toBe(239.75);
    expect(repo.getCustomer("CUST-00001")?.refunds).toHaveLength(1);
  });
  it("rejects refund above balance and leaves state unchanged", () => {
    const repo = fixed();
    const r = repo.applyRefund("CUST-00004", 1, "Customer requested refund");
    expect(r).toMatchObject({ ok: false, code: "INSUFFICIENT_BALANCE" });
    expect(repo.getCustomer("CUST-00004")?.refunds).toHaveLength(0);
  });
  it("allows refunding exactly the balance", () => {
    const r = fixed().applyRefund("CUST-00003", 50, "Full refund of balance");
    expect(r).toMatchObject({ ok: true, refund: { new_balance: 0 } });
  });
  it("reports NOT_FOUND on refund to unknown customer", () => {
    expect(fixed().applyRefund("CUST-12345", 1, "Some valid reason")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
  it("does not leak internal state through returned records", () => {
    const repo = fixed();
    const c = repo.getCustomer("CUST-00003")!;
    c.refunds.length = 0;
    expect(repo.getCustomer("CUST-00003")?.refunds).toHaveLength(1);
  });
});
