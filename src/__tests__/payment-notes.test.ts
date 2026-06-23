import { describe, it, expect } from "vitest";
import { addPaymentNote, getPaymentNotes, recordRefundNote } from "@/lib/paymentNotes";

let n = 0;
function taskId(): string {
  n++;
  return `pn-task-${n}`;
}

describe("payment notes", () => {
  it("attaches a note and reads it back (trimmed)", () => {
    const t = taskId();
    expect(getPaymentNotes(t)).toEqual([]);
    const created = addPaymentNote(t, "dispute", "  output did not match the spec  ", "WalletX");
    expect(created.kind).toBe("dispute");
    expect(created.note).toBe("output did not match the spec");
    expect(created.author).toBe("WalletX");
    const notes = getPaymentNotes(t);
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toBe("output did not match the spec");
  });

  it("returns notes oldest-first", () => {
    const t = taskId();
    addPaymentNote(t, "note", "first");
    addPaymentNote(t, "dispute", "second");
    expect(getPaymentNotes(t).map((x) => x.note)).toEqual(["first", "second"]);
  });

  it("rejects an empty note and an invalid kind", () => {
    const t = taskId();
    expect(() => addPaymentNote(t, "dispute", "   ")).toThrow();
    // @ts-expect-error — invalid kind is rejected at runtime too
    expect(() => addPaymentNote(t, "bogus", "x")).toThrow();
  });

  it("records a system refund note carrying the failure reason", () => {
    const t = taskId();
    recordRefundNote(t, "agent timed out");
    const notes = getPaymentNotes(t);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("refund");
    expect(notes[0].note).toContain("agent timed out");
    expect(notes[0].author).toBeNull(); // system-generated
  });

  it("refund note falls back to a generic message when no reason is given", () => {
    const t = taskId();
    recordRefundNote(t);
    expect(getPaymentNotes(t)[0].note).toBe("Payment refunded to sender");
  });
});
