import type { Service } from "../../generated/prisma/client.js";

/**
 * Price of a service for a new booking at `at` (server time). A sale is
 * active when both sale fields are set and `at` is strictly before
 * saleEndsAt; exactly at saleEndsAt the regular price applies again. Decided
 * per request: nothing clears expired sale fields.
 */
export type ServicePricing = {
  /** Regular price (integer euro cents). */
  priceCents: number;
  /** What a booking created at `at` costs. */
  effectivePriceCents: number;
  /** Only while the sale is active; otherwise both null. */
  salePriceCents: number | null;
  saleEndsAt: Date | null;
};

export const pricingAt = (
  service: Pick<Service, "priceCents" | "salePriceCents" | "saleEndsAt">,
  at: Date,
): ServicePricing => {
  const { priceCents, salePriceCents, saleEndsAt } = service;
  if (salePriceCents !== null && saleEndsAt !== null && at.getTime() < saleEndsAt.getTime()) {
    return { priceCents, effectivePriceCents: salePriceCents, salePriceCents, saleEndsAt };
  }
  return { priceCents, effectivePriceCents: priceCents, salePriceCents: null, saleEndsAt: null };
};
