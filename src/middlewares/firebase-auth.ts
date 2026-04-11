import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import admin from "firebase-admin";
import { env } from "../lib/env.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    /**
     * Raw Firebase ID token string extracted from the Authorization header,
     * *after* successful verification. Exposed so the async generation
     * pipeline can pass the token through to Cloud Tasks → processor →
     * Cognito federation without re-minting it.
     *
     * Never log this field. It's a short-lived credential.
     */
    firebaseIdToken?: string;
  }
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

let firebaseInitialized = false;

function initializeFirebase(): void {
  if (firebaseInitialized) return;

  admin.initializeApp({
    credential: admin.credential.cert(
      env.FIREBASE_SERVICE_ACCOUNT_KEY as admin.ServiceAccount,
    ),
  });

  firebaseInitialized = true;
}

async function firebaseAuthPlugin(fastify: FastifyInstance) {
  initializeFirebase();

  fastify.decorateRequest("userId", undefined);
  fastify.decorateRequest("firebaseIdToken", undefined);

  fastify.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      // API key bypass for Swagger testing (development only)
      if (env.NODE_ENV === "development") {
        const apiKey = request.headers["x-api-key"] as string | undefined;
        if (apiKey && env.SWAGGER_API_KEY && apiKey === env.SWAGGER_API_KEY) {
          request.userId = "swagger-test-user";
          return;
        }
      }

      const userAgent = request.headers["user-agent"];

      if (!userAgent || !userAgent.startsWith("HomeDecorAI/")) {
        request.log.error({ userAgent }, "Invalid User-Agent");
        reply.code(403).send({
          error: "Forbidden",
          message: "Only the HomeDecorAI app is allowed to use this API",
        });
        return;
      }

      const authHeader = request.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        reply.code(401).send({
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <token>",
        });
        return;
      }

      const token = authHeader.slice(7);

      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        request.userId = decodedToken.uid;
        request.firebaseIdToken = token;
      } catch (error) {
        request.log.error(
          {
            error:
              error instanceof Error ? error.message : String(error),
          },
          "Token verification failed",
        );
        reply.code(401).send({
          error: "Unauthorized",
          message: "Invalid or expired token",
        });
        return;
      }
    },
  );
}

export default fp(firebaseAuthPlugin, { name: "firebase-auth" });
