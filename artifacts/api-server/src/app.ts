import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyFormbody from "@fastify/formbody";
import { logger } from "./lib/logger";
import routes from "./routes";

export function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
  });

  app.register(fastifyCors);
  app.register(fastifyFormbody);
  app.register(routes, { prefix: "/api" });

  return app;
}
