import type { PrismaClient, Service } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";

/**
 * Public view of a service: what the frontend needs to show and book it.
 * Photos, long descriptions and card design live in the frontend, keyed by
 * the service id.
 */
export type PublicServiceView = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  currency: "EUR";
};

export const toPublicServiceView = (service: Service): PublicServiceView => ({
  id: service.id,
  name: service.name,
  durationMinutes: service.durationMinutes,
  priceCents: service.priceCents,
  currency: "EUR",
});

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
