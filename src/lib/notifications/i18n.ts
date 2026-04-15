import type { SupportedLanguage } from "../generation/types.js";

/**
 * Localization map for FCM push notification content.
 *
 * Design note: snapshot-at-enqueue semantics. The generation doc stores the
 * language the user had when they started the job, so push content matches the
 * context in which the job was requested — even if the user later switches the
 * app locale. See plan R10.
 *
 * To add a language: extend SupportedLanguage in `lib/generation/types.ts`,
 * then add the corresponding entry here. The FCM layer falls back to `en`
 * when the doc has no language (legacy records) or an unknown value.
 */

export type NotificationKind = "completed" | "failed";

export interface LocalizedNotification {
  title: string;
  body: string;
}

export const LOCALIZED_MESSAGES: Record<
  SupportedLanguage,
  Record<NotificationKind, LocalizedNotification>
> = {
  tr: {
    completed: {
      title: "Tasarımınız hazır! 🎨",
      body: "Yeni iç mekan tasarımınıza göz atın.",
    },
    failed: {
      title: "Bir sorun oluştu",
      body: "Tasarımınız oluşturulamadı. Lütfen tekrar deneyin.",
    },
  },
  en: {
    completed: {
      title: "Your design is ready! 🎨",
      body: "Take a look at your new interior design.",
    },
    failed: {
      title: "Something went wrong",
      body: "We couldn't create your design. Please try again.",
    },
  },
};

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["tr", "en"] as const;

/**
 * Normalize an arbitrary language input to a supported language code.
 * Accepts full tags (`tr-TR`, `en-US`) by splitting on `-`. Falls back to `en`.
 */
export function resolveLanguage(raw: unknown): SupportedLanguage {
  if (typeof raw !== "string" || raw.length === 0) return "en";
  const primary = raw.toLowerCase().split("-")[0];
  if (primary && (SUPPORTED_LANGUAGES as readonly string[]).includes(primary)) {
    return primary as SupportedLanguage;
  }
  return "en";
}
