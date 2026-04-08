import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyFormbody from "@fastify/formbody";
import { logger } from "./lib/logger.js";
import firebaseAuthPlugin from "./middlewares/firebase-auth.js";
import routes from "./routes/index.js";

export function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // AI generation can take up to 60s+ per provider, with retry and fallback
    requestTimeout: 120_000,
  });

  app.register(fastifyCors, { origin: false });
  app.register(fastifyFormbody);
  app.register(firebaseAuthPlugin);
  app.register(routes, { prefix: "/api" });

  return app;
}
