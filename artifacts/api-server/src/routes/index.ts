import type { FastifyPluginAsync } from "fastify";
import healthRoutes from "./health.js";
import designRoutes from "./design.js";

const routes: FastifyPluginAsync = async (app) => {
  app.register(healthRoutes);
  app.register(designRoutes, { prefix: "/design" });
};

export default routes;
