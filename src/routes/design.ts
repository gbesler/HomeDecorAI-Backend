import type { FastifyPluginAsync } from "fastify";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  createInteriorDesign,
  getHistory,
} from "../controllers/design.controller.js";

const designRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/interior",
    {
      preHandler: [
        app.authenticate,
        createRateLimitPreHandler("interiorDesign"),
      ],
    },
    createInteriorDesign,
  );

  app.get(
    "/history",
    { preHandler: [app.authenticate] },
    getHistory,
  );
};

export default designRoutes;
