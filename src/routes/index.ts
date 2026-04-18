import type { FastifyPluginAsync } from "fastify";
import healthRoutes from "./health.js";
import designRoutes from "./design.js";
import usersRoutes from "./users.js";
import albumsRoutes from "./albums.js";

const routes: FastifyPluginAsync = async (app) => {
  app.register(healthRoutes);
  app.register(designRoutes, { prefix: "/design" });
  app.register(usersRoutes, { prefix: "/users" });
  app.register(albumsRoutes, { prefix: "/albums" });
};

export default routes;
