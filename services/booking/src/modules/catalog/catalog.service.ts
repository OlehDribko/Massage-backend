import type { PrismaClient, Service } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";
import { pricingAt } from "./pricing.js";

/**
 * Public view of a service: what the frontend needs to show and book it.
 * Photos, long descriptions and card design live in the frontend, keyed by
 * the service id.
 */
export type PublicServiceView = {
  id: string;
  name: string;
  durationMinutes: number;
  /** Regular price (integer euro cents). */
  priceCents: number;
  /** Price of a booking created now: the sale price while a sale is active, otherwise priceCents. */
  effectivePriceCents: number;
  /** Only while a sale is active; otherwise both null. */
  salePriceCents: number | null;
  saleEndsAt: string | null;
  currency: "EUR";
};

/** `now` is the server time of this request (sales are decided per request). */
export const toPublicServiceView = (service: Service, now: Date): PublicServiceView => {
  const pricing = pricingAt(service, now);
  return {
    id: service.id,
    name: service.name,
    durationMinutes: service.durationMinutes,
    priceCents: pricing.priceCents,
    effectivePriceCents: pricing.effectivePriceCents,
    salePriceCents: pricing.salePriceCents,
    saleEndsAt: pricing.saleEndsAt?.toISOString() ?? null,
    currency: "EUR",
  };
};

export const serviceNotFound = () =>
  new AppError(404, "Service not found", { code: "SERVICE_NOT_FOUND" });

export type CatalogService = ReturnType<typeof createCatalogService>;

/**
 * Fixed catalogue of services, read-only for the application. The list is
 * maintained with data migrations (docs/booking.md, "Каталог послуг"): no
 * admin routes create, change or delete services. A service is bookable while
 * archivedAt is null. Bookings keep their own snapshot of name, duration and
 * price, so a catalogue change never alters existing bookings.
 */
export const createCatalogService = ({ prisma }: { prisma: PrismaClient }) => {
  const listBookable = (): Promise<Service[]> =>
    prisma.service.findMany({ where: { archivedAt: null }, orderBy: [{ name: "asc" }, { id: "asc" }] });

  /** A bookable service, or 404 (services that are not bookable are not public). */
  const getBookable = async (id: string): Promise<Service> => {
    const service = await prisma.service.findFirst({ where: { id, archivedAt: null } });
    if (service === null) {
      throw serviceNotFound();
    }
    return service;
  };

  return { listBookable, getBookable };
};
