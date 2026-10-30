import { Router, type Request } from "express";
import { withValidatedBody } from "../../shared/http/validated-body.js";
import { createServiceSchema, serviceIdSchema, updateServiceSchema } from "./catalog.schema.js";
import {
  serviceNotFound,
  toAdminServiceView,
  toPublicServiceView,
  type CatalogService,
} from "./catalog.service.js";

/** Service id from the path; a malformed id is simply not found. */
export const serviceIdFrom = (req: Request): string => {
  const parsed = serviceIdSchema.safeParse(req.params.serviceId);
  if (!parsed.success) {
    throw serviceNotFound();
  }
  return parsed.data;
};

/** Public: GET /api/services, GET /api/services/:serviceId. No token needed. */
export const createPublicCatalogRouter = (catalog: CatalogService): Router => {
  const router = Router();

  router.get("/", async (_req, res) => {
    const services = await catalog.listBookable();
    res.status(200).json({ services: services.map(toPublicServiceView) });
  });

  router.get("/:serviceId", async (req, res) => {
    res.status(200).json({ service: toPublicServiceView(await catalog.getBookable(serviceIdFrom(req))) });
  });

  return router;
};

/** Admin: /api/admin/services. Mount behind authenticate + requireAdmin. */
export const createAdminCatalogRouter = (catalog: CatalogService): Router => {
  const router = Router();

  router.get("/", async (_req, res) => {
    const services = await catalog.listAll();
    res.status(200).json({ services: services.map(toAdminServiceView) });
  });

  router.post(
    "/",
    withValidatedBody(createServiceSchema, async (body, res) => {
      res.status(201).json({ service: toAdminServiceView(await catalog.create(body)) });
    }),
  );

  router.get("/:serviceId", async (req, res) => {
    res.status(200).json({ service: toAdminServiceView(await catalog.get(serviceIdFrom(req))) });
  });

  router.patch(
    "/:serviceId",
    withValidatedBody(updateServiceSchema, async (body, res, _next, req) => {
      res.status(200).json({ service: toAdminServiceView(await catalog.update(serviceIdFrom(req), body)) });
    }),
  );

  // Deletes an unused service; one with bookings is archived (200, outcome
  // "archived"), keeping the booking history.
  router.delete("/:serviceId", async (req, res) => {
    const result = await catalog.remove(serviceIdFrom(req));
    res
      .status(200)
      .json(result.outcome === "deleted" ? result : { outcome: result.outcome, service: toAdminServiceView(result.service) });
  });

  return router;
};
