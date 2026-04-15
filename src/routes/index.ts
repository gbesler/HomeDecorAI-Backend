import type { FastifyPluginAsync } from "fastify";
import healthRoutes from "./health.js";
import designRoutes from "./design.js";
import usersRoutes from "./users.js";

const routes: FastifyPluginAsync = async (app) => {
  app.register(healthRoutes);
  app.register(designRoutes, { prefix: "/design" });
  app.register(usersRoutes, { prefix: "/users" });
};

export default routes;
