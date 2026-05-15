import type { FastifyPluginAsync } from "fastify";
import healthRoutes from "./health.js";
import designRoutes from "./design.js";
import usersRoutes from "./users.js";
import albumsRoutes from "./albums.js";
import exploreRoutes from "./explore.js";
import accountRoutes from "./account.js";
import objectInspirationsRoutes from "./object-inspirations.js";

const routes: FastifyPluginAsync = async (app) => {
  app.register(healthRoutes);
  app.register(designRoutes, { prefix: "/design" });
  app.register(usersRoutes, { prefix: "/users" });
  app.register(albumsRoutes, { prefix: "/albums" });
  app.register(exploreRoutes, { prefix: "/explore" });
  app.register(accountRoutes, { prefix: "/account" });
  app.register(objectInspirationsRoutes, { prefix: "/object-inspirations" });
};

export default routes;
