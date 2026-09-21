import { describe, it, expect } from "vitest";
import { formatLeft } from "@/app/burn/BurnClient";

// The countdown ran as mm:ss whatever the size of the wait, so a pot sitting below the minimum
// showed "1427:51" on the page: correct to the second, and indistinguishable from a broken clock.
describe("the burn countdown", () => {
  it("reads as mm:ss inside the hour, which is the ordinary thirty minute wait", () => {
    expect(formatLeft(0)).toBe("00:00");
    expect(formatLeft(59)).toBe("00:59");
    expect(formatLeft(61)).toBe("01:01");
    expect(formatLeft(1799)).toBe("29:59");
    expect(formatLeft(3599)).toBe("59:59");
  });

  it("switches to hours past the hour, so most of a day never reads as 1427 minutes", () => {
    expect(formatLeft(3600)).toBe("1h 00m");
    expect(formatLeft(3660)).toBe("1h 01m");
    expect(formatLeft(85671)).toBe("23h 47m");
    expect(formatLeft(86400)).toBe("24h 00m");
  });

  it("never shows a minute field of 60 or more", () => {
    for (let s = 0; s <= 86400; s += 7) {
      const minutes = Number(formatLeft(s).replace(/.*?(\d+)m?$/, "$1").replace(/\D/g, ""));
      expect(minutes).toBeLessThan(60);
    }
  });
});
