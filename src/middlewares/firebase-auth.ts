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
      // Two ways to relax the HomeDecorAI/* User-Agent gate:
      //   1. A valid Bearer token — strong Firebase auth subsumes the UA
      //      heuristic, so any browser / Swagger UI presenting a verified
      //      token is allowed through.
      //   2. A valid SWAGGER_API_KEY — shared-secret bypass for endpoints
      //      that don't need a real user (e.g. GET /history via Swagger).
      // Rotate SWAGGER_API_KEY if it leaks.
      const apiKey = request.headers["x-api-key"] as string | undefined;
      const hasValidApiKey = Boolean(
        apiKey && env.SWAGGER_API_KEY && apiKey === env.SWAGGER_API_KEY,
      );

      const authHeader = request.headers.authorization;
      const hasBearer = Boolean(authHeader && authHeader.startsWith("Bearer "));

      // User-Agent gate — skipped when either a Bearer token is presented
      // (token validity is enforced below) or a valid Swagger API key is
      // present. An invalid Bearer that bypasses the UA here will still be
      // rejected by verifyIdToken with 401, so the net surface area exposed
      // by this relaxation is "presence of Authorization header" not "valid
      // identity."
      if (!hasBearer && !hasValidApiKey) {
        const userAgent = request.headers["user-agent"];
        if (!userAgent || !userAgent.startsWith("HomeDecorAI/")) {
          request.log.error({ userAgent }, "Invalid User-Agent");
          reply.code(403).send({
            error: "Forbidden",
            message: "Only the HomeDecorAI app is allowed to use this API",
          });
          return;
        }
      }

      if (hasBearer) {
        // Real Firebase token path — populates both userId and firebaseIdToken
        // so downstream handlers can federate into Cognito.
        const token = authHeader!.slice(7);
        try {
          const decodedToken = await admin.auth().verifyIdToken(token);
          request.userId = decodedToken.uid;
          request.firebaseIdToken = token;
        } catch (error) {
          request.log.error(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            "Token verification failed",
          );
          reply.code(401).send({
            error: "Unauthorized",
            message: "Invalid or expired token",
          });
          return;
        }
      } else if (hasValidApiKey) {
        // Swagger-only path (no Bearer): synthetic user for endpoints that do
        // not need firebaseIdToken (e.g. GET /history). Endpoints requiring
        // the token will still reject with 401 at the handler level.
        request.userId = "swagger-test-user";
      } else {
        reply.code(401).send({
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <token>",
        });
        return;
      }
    },
  );
}

export default fp(firebaseAuthPlugin, { name: "firebase-auth" });
