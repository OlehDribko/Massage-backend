import { describe, expect, it } from "vitest";
import { pricingAt } from "../src/modules/catalog/pricing.js";

const END = new Date("2026-11-30T23:00:00.000Z"); // 1 Dec 2026 00:00 Paris

describe("service pricing at a moment", () => {
  it("no sale: the regular price", () => {
    expect(pricingAt({ priceCents: 8500, salePriceCents: null, saleEndsAt: null }, END)).toEqual({
      priceCents: 8500,
      effectivePriceCents: 8500,
      salePriceCents: null,
      saleEndsAt: null,
    });
  });

  it("an active sale: the sale price, with its end", () => {
    expect(pricingAt({ priceCents: 8500, salePriceCents: 6900, saleEndsAt: END }, new Date("2026-11-15T10:00:00Z"))).toEqual({
      priceCents: 8500,
      effectivePriceCents: 6900,
      salePriceCents: 6900,
      saleEndsAt: END,
    });
  });

  it("one millisecond before the end the sale applies; exactly at the end and later the regular price", () => {
    const sale = { priceCents: 8500, salePriceCents: 6900, saleEndsAt: END };
    expect(pricingAt(sale, new Date(END.getTime() - 1)).effectivePriceCents).toBe(6900);
    expect(pricingAt(sale, END)).toEqual({ priceCents: 8500, effectivePriceCents: 8500, salePriceCents: null, saleEndsAt: null });
    expect(pricingAt(sale, new Date(END.getTime() + 1)).effectivePriceCents).toBe(8500);
  });

  it("a free sale (0 cents) is a valid sale price", () => {
    expect(pricingAt({ priceCents: 5000, salePriceCents: 0, saleEndsAt: END }, new Date(END.getTime() - 1000)).effectivePriceCents).toBe(0);
  });
});
