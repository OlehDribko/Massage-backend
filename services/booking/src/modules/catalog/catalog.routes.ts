import { Router, type Request } from "express";
import { serviceIdSchema } from "./catalog.schema.js";
import { serviceNotFound, toPublicServiceView, type CatalogService } from "./catalog.service.js";

/** Service id from the path; a malformed id is simply not found. */
export const serviceIdFrom = (req: Request): string => {
  const parsed = serviceIdSchema.safeParse(req.params.serviceId);
  if (!parsed.success) {
    throw serviceNotFound();
  }
  return parsed.data;
};

/**
 * Public: GET /api/services, GET /api/services/:serviceId. No token needed;
 * only bookable services. There are no admin catalogue routes: the catalogue
 * is changed by data migrations.
 */
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
