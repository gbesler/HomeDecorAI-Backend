import type { FastifyPluginAsync } from "fastify";
import { HealthCheckResponse } from "@workspace/api-zod";

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async (_request, reply) => {
    const data = HealthCheckResponse.parse({ status: "ok" });
    return reply.send(data);
  });
};

export default healthRoutes;
