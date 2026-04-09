import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyFormbody from "@fastify/formbody";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { logger } from "./lib/logger.js";
import firebaseAuthPlugin from "./middlewares/firebase-auth.js";
import routes from "./routes/index.js";

export function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // AI generation can take up to 60s+ per provider, with retry and fallback
    requestTimeout: 120_000,
  });

  app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "HomeDecorAI API",
        description:
          "AI-powered interior design API. Upload a room photo and get a redesigned version using Replicate or fal.ai providers with automatic fallback via circuit breaker.",
        version: "1.0.0",
      },
      servers: [
        {
          url: "https://homedecorai-backend-pv3k.onrender.com",
          description: "Production (Render)",
        },
        {
          url: "http://localhost:10000",
          description: "Local development",
        },
      ],
      tags: [
        {
          name: "Health",
          description: "Health check endpoints",
        },
        {
          name: "Design",
          description: "AI interior design generation and history",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Firebase ID Token",
            description:
              "Firebase Authentication ID token. Obtain via Firebase Auth SDK on the client. Requests must also include a `User-Agent: HomeDecorAI/<version>` header.",
          },
        },
      },
    },
  });

  app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    baseDir: join(dirname(fileURLToPath(import.meta.url)), "static"),
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      persistAuthorization: true,
    },
  });

  app.register(fastifyCors, { origin: false });
  app.register(fastifyFormbody);
  app.register(firebaseAuthPlugin);
  app.register(routes, { prefix: "/api" });

  // Root health check for Render
  app.get("/", async () => ({ status: "ok" }));

  return app;
}
