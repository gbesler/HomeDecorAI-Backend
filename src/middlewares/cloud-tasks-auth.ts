import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { OAuth2Client } from "google-auth-library";
import { env } from "../lib/env.js";

/**
 * OIDC verification middleware for the internal generation processor endpoint.
 *
 * Cloud Tasks sends an OIDC ID token signed by Google for the configured
 * service account. We validate:
 *   1. The token is signed by Google (via OAuth2Client.verifyIdToken)
 *   2. The audience matches INTERNAL_TASK_AUDIENCE (our internal URL)
 *   3. The email matches our configured task runner service account
 *
 * Cloud Tasks also attaches diagnostic headers (X-CloudTasks-*) which we
 * surface on the request object so the processor can log retry count and
 * detect tasks at the end of their retry budget.
 */

declare module "fastify" {
  interface FastifyRequest {
    cloudTask?: CloudTaskContext;
  }
  interface FastifyInstance {
    verifyCloudTask: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

export interface CloudTaskContext {
  queueName: string | null;
  taskName: string | null;
  retryCount: number;
  executionCount: number;
}

const authClient = new OAuth2Client();

function readNumericHeader(
  headers: FastifyRequest["headers"],
  name: string,
): number {
  const raw = headers[name];
  if (typeof raw !== "string") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readStringHeader(
  headers: FastifyRequest["headers"],
  name: string,
): string | null {
  const raw = headers[name];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

async function cloudTasksAuthPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest("cloudTask", undefined);

  fastify.decorate(
    "verifyCloudTask",
    async function (request: FastifyRequest, reply: FastifyReply) {
      // Async path env vars are optional while /sync testing is active.
      // If this handler is invoked without them configured, fail fast —
      // the internal endpoint is unreachable anyway without them.
      if (!env.INTERNAL_TASK_AUDIENCE || !env.GCP_SERVICE_ACCOUNT_EMAIL) {
        request.log.warn(
          { event: "cloudtasks.auth.not_configured" },
          "Cloud Tasks env vars not configured — async pipeline disabled",
        );
        reply.code(503).send({
          error: "Service Unavailable",
          message: "Async Cloud Tasks pipeline is not configured",
        });
        return;
      }
      const expectedAudience = env.INTERNAL_TASK_AUDIENCE;
      const expectedEmail = env.GCP_SERVICE_ACCOUNT_EMAIL;

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        request.log.warn(
          { event: "cloudtasks.auth.missing" },
          "Missing Authorization header on internal endpoint",
        );
        reply.code(401).send({
          error: "Unauthorized",
          message: "Missing OIDC token",
        });
        return;
      }

      const token = authHeader.slice("Bearer ".length);

      try {
        const ticket = await authClient.verifyIdToken({
          idToken: token,
          audience: expectedAudience,
        });
        const payload = ticket.getPayload();

        if (!payload) {
          throw new Error("OIDC token has no payload");
        }

        if (payload.email !== expectedEmail) {
          request.log.warn(
            {
              event: "cloudtasks.auth.email_mismatch",
              expected: expectedEmail,
              actual: payload.email,
            },
            "OIDC token email does not match configured service account",
          );
          reply.code(403).send({
            error: "Forbidden",
            message: "Unrecognised service account",
          });
          return;
        }

        if (!payload.email_verified) {
          reply.code(403).send({
            error: "Forbidden",
            message: "Service account email not verified",
          });
          return;
        }

        const ctx: CloudTaskContext = {
          queueName: readStringHeader(request.headers, "x-cloudtasks-queuename"),
          taskName: readStringHeader(request.headers, "x-cloudtasks-taskname"),
          retryCount: readNumericHeader(
            request.headers,
            "x-cloudtasks-taskretrycount",
          ),
          executionCount: readNumericHeader(
            request.headers,
            "x-cloudtasks-taskexecutioncount",
          ),
        };
        request.cloudTask = ctx;

        request.log.info(
          {
            event: "cloudtasks.auth.ok",
            queue: ctx.queueName,
            task: ctx.taskName,
            retryCount: ctx.retryCount,
            executionCount: ctx.executionCount,
          },
          "Cloud Tasks OIDC verified",
        );
      } catch (err) {
        request.log.warn(
          {
            event: "cloudtasks.auth.verify_failed",
            error: err instanceof Error ? err.message : String(err),
          },
          "OIDC verification failed",
        );
        reply.code(401).send({
          error: "Unauthorized",
          message: "Invalid OIDC token",
        });
        return;
      }
    },
  );
}

export default fp(cloudTasksAuthPlugin, { name: "cloud-tasks-auth" });
