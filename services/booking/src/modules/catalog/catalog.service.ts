import type { PrismaClient, Service } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";
import type { CalendarTransaction } from "../schedule/calendar-transaction.js";
import type { CreateServiceRequest, UpdateServiceRequest } from "./catalog.schema.js";

/** What guests and clients see: bookable services only, no internal state. */
export type PublicServiceView = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  currency: "EUR";
};

export type AdminServiceView = PublicServiceView & {
  bookable: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const toPublicServiceView = (service: Service): PublicServiceView => ({
  id: service.id,
  name: service.name,
  description: service.description,
  durationMinutes: service.durationMinutes,
  priceCents: service.priceCents,
  currency: "EUR",
});

export const toAdminServiceView = (service: Service): AdminServiceView => ({
  ...toPublicServiceView(service),
  bookable: service.archivedAt === null,
  archivedAt: service.archivedAt?.toISOString() ?? null,
  createdAt: service.createdAt.toISOString(),
  updatedAt: service.updatedAt.toISOString(),
});

export const serviceNotFound = () =>
  new AppError(404, "Service not found", { code: "SERVICE_NOT_FOUND" });

export type DeleteResult = { outcome: "deleted" } | { outcome: "archived"; service: Service };

export type CatalogService = ReturnType<typeof createCatalogService>;

/**
 * Catalogue of services. Bookings keep their own snapshot of name, duration
 * and price, so edits here never change existing bookings. A service that
 * has bookings is never deleted, only archived.
 */
export const createCatalogService = ({
  prisma,
  calendar,
  now,
}: {
  prisma: PrismaClient;
  calendar: CalendarTransaction;
  now: () => Date;
}) => {
  const listBookable = (): Promise<Service[]> =>
    prisma.service.findMany({ where: { archivedAt: null }, orderBy: [{ name: "asc" }, { id: "asc" }] });

  const listAll = (): Promise<Service[]> =>
    prisma.service.findMany({ orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }, { id: "asc" }] });

  /** A bookable service, or 404 (archived services are not public). */
  const getBookable = async (id: string): Promise<Service> => {
    const service = await prisma.service.findFirst({ where: { id, archivedAt: null } });
    if (service === null) {
      throw serviceNotFound();
    }
    return service;
  };

  const get = async (id: string): Promise<Service> => {
    const service = await prisma.service.findUnique({ where: { id } });
    if (service === null) {
      throw serviceNotFound();
    }
    return service;
  };

  const create = (request: CreateServiceRequest): Promise<Service> =>
    prisma.service.create({
      data: {
        name: request.name,
        description: request.description ?? null,
        durationMinutes: request.durationMinutes,
        priceCents: request.priceCents,
        currency: "EUR",
      },
    });

  const update = async (id: string, request: UpdateServiceRequest): Promise<Service> => {
    const current = await get(id);
    const archivedAt =
      request.bookable === undefined
        ? current.archivedAt
        : request.bookable
          ? null
          : (current.archivedAt ?? now());
    return prisma.service.update({
      where: { id },
      data: {
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.durationMinutes !== undefined ? { durationMinutes: request.durationMinutes } : {}),
        ...(request.priceCents !== undefined ? { priceCents: request.priceCents } : {}),
        archivedAt,
      },
    });
  };

  /**
   * Deletes a service nobody has booked; a service with bookings (any status)
   * is archived instead, so the history stays intact. Under the calendar lock,
   * so no booking can be created for it in between.
   */
  const remove = (id: string): Promise<DeleteResult> =>
    calendar(async (tx) => {
      const service = await tx.service.findUnique({ where: { id } });
      if (service === null) {
        throw serviceNotFound();
      }
      const used = await tx.booking.count({ where: { serviceId: id } });
      if (used === 0) {
        await tx.service.delete({ where: { id } });
        return { outcome: "deleted" };
      }
      const archived = await tx.service.update({
        where: { id },
        data: { archivedAt: service.archivedAt ?? now() },
      });
      return { outcome: "archived", service: archived };
    });

  return { listBookable, listAll, getBookable, get, create, update, remove };
};
