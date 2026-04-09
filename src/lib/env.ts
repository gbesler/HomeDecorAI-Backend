import { z } from "zod/v4";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  REPLICATE_API_TOKEN: z.string().min(1),
  FAL_AI_API_KEY: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_KEY: z
    .string()
    .min(1)
    .transform((val) => {
      let parsed: Record<string, unknown>;
      try {
        const decoded = Buffer.from(val, "base64").toString("utf-8");
        parsed = JSON.parse(decoded) as Record<string, unknown>;
      } catch {
        throw new Error(
          "FIREBASE_SERVICE_ACCOUNT_KEY must be a valid base64-encoded JSON string",
        );
      }
      const required = ["project_id", "private_key", "client_email"] as const;
      for (const field of required) {
        if (typeof parsed[field] !== "string" || parsed[field] === "") {
          throw new Error(
            `FIREBASE_SERVICE_ACCOUNT_KEY is missing required field: ${field}`,
          );
        }
      }
      return parsed;
    }),
  AWS_S3_BUCKET: z.string().min(1),
  AWS_S3_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_CLOUDFRONT_HOST: z.string().min(1).optional(),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().optional().default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .optional()
    .default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
