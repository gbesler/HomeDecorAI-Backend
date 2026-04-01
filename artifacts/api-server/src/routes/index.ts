import type { FastifyPluginAsync } from "fastify";
import healthRoutes from "./health";

const routes: FastifyPluginAsync = async (app) => {
  app.register(healthRoutes);
};

export default routes;
