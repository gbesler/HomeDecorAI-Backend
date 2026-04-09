import type { FastifyPluginAsync } from "fastify";
import { HealthCheckResponse } from "../schemas/index.js";

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/healthz",
    {
      schema: {
        tags: ["Health"],
        summary: "Health check",
        description: "Returns server health status. Used by Render for uptime monitoring.",
        response: {
          200: {
            type: "object",
            description: "Server is healthy",
            properties: {
              status: { type: "string", example: "ok" },
            },
            required: ["status"],
          },
        },
      },
    },
    async (_request, reply) => {
      const data = HealthCheckResponse.parse({ status: "ok" });
      return reply.send(data);
    },
  );
};

export default healthRoutes;
