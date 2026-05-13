import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import admin from "firebase-admin";
import { env } from "../lib/env.js";
import {
  applyIpThrottleHeaders,
  checkIpThrottle,
} from "../lib/rate-limiter.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
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

      // Pre-auth IP throttle. Authenticated requests (valid Bearer) and the
      // Swagger shared-secret path do NOT count against this bucket, so
      // legitimate users behind shared NATs are unaffected. Everything else
      // — Bearer-less requests and Bearer requests that fail verifyIdToken —
      // increments the IP counter. The counter is checked here for the
      // Bearer-less path and inside the verify-failure branch below.
      const ip = request.ip;

      if (!hasBearer && !hasValidApiKey) {
        const ipCheck = checkIpThrottle(ip);
        applyIpThrottleHeaders(reply, ipCheck.state, !ipCheck.allowed);
        if (!ipCheck.allowed) {
          request.log.warn(
            { ip, state: ipCheck.state },
            "Pre-auth IP throttle exhausted",
          );
          reply.code(429).send({
            error: "Too Many Requests",
            message:
              "Too many unauthenticated requests from this network. Try again later.",
            retryAfter: ipCheck.state.resetAfterSeconds,
          });
          return;
        }
      }

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
        const token = authHeader!.slice(7);
        try {
          const decodedToken = await admin.auth().verifyIdToken(token);
          request.userId = decodedToken.uid;
        } catch (error) {
          // Token verification failed — count this attempt against the
          // sender's IP so brute-force scanners cannot keep hitting Firebase.
          const ipCheck = checkIpThrottle(ip);
          applyIpThrottleHeaders(reply, ipCheck.state, !ipCheck.allowed);
          request.log.error(
            {
              error: error instanceof Error ? error.message : String(error),
              ip,
            },
            "Token verification failed",
          );
          if (!ipCheck.allowed) {
            reply.code(429).send({
              error: "Too Many Requests",
              message:
                "Too many failed authentications from this network. Try again later.",
              retryAfter: ipCheck.state.resetAfterSeconds,
            });
            return;
          }
          reply.code(401).send({
            error: "Unauthorized",
            message: "Invalid or expired token",
          });
          return;
        }
      } else if (hasValidApiKey) {
        // Swagger-only path (no Bearer): synthetic user for read-only endpoints
        // (e.g. GET /history). Reject mutating methods so the synthetic user
        // cannot reach create/sync handlers, burn AI provider credits, or
        // write under a shared `generations/swagger-test-user/...` S3 prefix.
        if (request.method !== "GET" && request.method !== "HEAD") {
          reply.code(401).send({
            error: "Unauthorized",
            message:
              "Swagger API key is read-only. Use a Bearer token for this endpoint.",
          });
          return;
        }
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
