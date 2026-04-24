import type { SupportedLanguage } from "../generation/types.js";

/**
 * 14-day pre-purchase notification campaign.
 *
 * Day 7 is intentionally omitted — a deliberate rest day in the campaign.
 * Slots are interpreted in the recipient's local timezone (fallback
 * Europe/Istanbul).
 *
 * Deep links use the `homedecorai://` scheme and are routed by the iOS
 * AppDelegate. Tool identifiers match the raw values of the iOS `HomeTool`
 * enum.
 */

export type CampaignDay = 1 | 2 | 3 | 4 | 5 | 6 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export const CAMPAIGN_DAYS: readonly CampaignDay[] = [
  1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14,
] as const;

export interface CampaignTemplateContent {
  title: string;
  body: string;
}

export interface CampaignTemplate {
  slotHour: number;
  slotMinute: number;
  deepLink: string;
  tr: CampaignTemplateContent;
  en: CampaignTemplateContent;
}

export const PRE_LAUNCH_TEMPLATES: Record<CampaignDay, CampaignTemplate> = {
  1: {
    slotHour: 19,
    slotMinute: 30,
    deepLink: "homedecorai://tool/interiorDesign",
    tr: {
      title: "🎨 Hoş geldin! İlk tasarımın seni bekliyor",
      body: "Bir fotoğraf çek, AI odanı 30 saniyede dönüştürsün ✨",
    },
    en: {
      title: "🎨 Welcome! Your first design is waiting",
      body: "Snap a photo — AI will transform your room in 30 seconds ✨",
    },
  },
  2: {
    slotHour: 19,
    slotMinute: 45,
    deepLink: "homedecorai://tool/interiorDesign?roomType=living_room",
    tr: {
      title: "🛋️ Oturma odan nasıl görünebilir?",
      body: "20+ stil arasından seç — modern, boho, minimalist. Hangisi sensin?",
    },
    en: {
      title: "🛋️ How could your living room look?",
      body: "Pick from 20+ styles — modern, boho, minimalist. Which one is you?",
    },
  },
  3: {
    slotHour: 15,
    slotMinute: 30,
    deepLink: "homedecorai://tool/referenceStyle",
    tr: {
      title: "📸 Bir fotoğraf = 20 farklı oda",
      body: "Odanın fotoğrafını çek, 20+ stilde nasıl göründüğünü gör.",
    },
    en: {
      title: "📸 One photo = 20 different rooms",
      body: "Take a photo of your room, see it in 20+ styles.",
    },
  },
  4: {
    slotHour: 19,
    slotMinute: 15,
    deepLink: "homedecorai://tool/interiorDesign?roomType=bathroom",
    tr: {
      title: "🚽 Banyonu da dönüştürmek ister misin?",
      body: "Banyo modu aktif — 15+ taze stil seni bekliyor.",
    },
    en: {
      title: "🚽 Want to transform your bathroom too?",
      body: "Bathroom mode is live — 15+ fresh styles waiting.",
    },
  },
  5: {
    slotHour: 11,
    slotMinute: 30,
    deepLink: "homedecorai://paywall?offer=trial",
    tr: {
      title: "💎 Premium'u 3 gün ücretsiz dene",
      body: "Sınırsız tasarım + HD indirme + tüm stiller. İptal etmesi kolay.",
    },
    en: {
      title: "💎 Try Premium free for 3 days",
      body: "Unlimited designs + HD downloads + all styles. Easy to cancel.",
    },
  },
  6: {
    slotHour: 14,
    slotMinute: 0,
    deepLink: "homedecorai://tool/interiorDesign?roomType=living_room",
    tr: {
      title: "🛋️ Cumartesi keyfi: Oturma odanı yeniden tasarla",
      body: "Kahveni al, 5 dakikada odana 10 farklı stil dene.",
    },
    en: {
      title: "🛋️ Saturday vibes: Redesign your living room",
      body: "Grab a coffee — try 10 styles on your room in 5 minutes.",
    },
  },
  8: {
    slotHour: 19,
    slotMinute: 30,
    deepLink: "homedecorai://tool/interiorDesign?roomType=kitchen",
    tr: {
      title: "🍳 Mutfağına yeni bir hava ver",
      body: "Tek fotoğraf, tek dokunuş, sonsuz olasılık.",
    },
    en: {
      title: "🍳 Give your kitchen a fresh look",
      body: "One photo, one tap, endless possibilities.",
    },
  },
  9: {
    slotHour: 19,
    slotMinute: 0,
    deepLink: "homedecorai://tool/gardenDesign",
    tr: {
      title: "🌷 Bahçe tasarımı moduna göz at",
      body: "Dış mekânlar da dönüşümü hak ediyor — dene.",
    },
    en: {
      title: "🌷 Check out garden design mode",
      body: "Outdoor spaces deserve a makeover too — give it a try.",
    },
  },
  10: {
    slotHour: 15,
    slotMinute: 45,
    deepLink: "homedecorai://tool/virtualStaging",
    tr: {
      title: "🪑 Boş oda mı? AI senin için döşesin",
      body: 'Yeni "Oda Doldur" özelliği — 10 saniyede bitiyor.',
    },
    en: {
      title: "🪑 Empty room? Let AI furnish it for you",
      body: 'New "Fill the Room" feature — done in 10 seconds.',
    },
  },
  11: {
    slotHour: 19,
    slotMinute: 30,
    deepLink: "homedecorai://tool/replaceAddObject",
    tr: {
      title: "🪑 Kanepeni sevmiyor musun?",
      body: "Odanın fotoğrafında sadece kanepeyi değiştir — gerisi aynı kalsın.",
    },
    en: {
      title: "🪑 Don't love your sofa?",
      body: "Replace just the sofa in your photo — keep the rest as is.",
    },
  },
  12: {
    slotHour: 19,
    slotMinute: 15,
    deepLink: "homedecorai://gallery",
    tr: {
      title: "🎨 Bu hafta 8 tasarım yaptın!",
      body: "Galerini görmek için dokun — gerçek bir tasarımcı oluyorsun.",
    },
    en: {
      title: "🎨 You made 8 designs this week!",
      body: "Tap to see your gallery — you're becoming a real designer.",
    },
  },
  13: {
    slotHour: 19,
    slotMinute: 30,
    deepLink: "homedecorai://paywall?offer=half-off",
    tr: {
      title: "💫 Premium'a geç — ilk ay %50 indirim",
      body: "Yaptığın tasarımları beğendin mi? Sınırsız yapmaya devam et. 48 saat geçerli.",
    },
    en: {
      title: "💫 Go Premium — 50% off your first month",
      body: "Loved your designs? Keep creating, unlimited. 48 hours only.",
    },
  },
  14: {
    slotHour: 11,
    slotMinute: 0,
    deepLink: "homedecorai://tool/referenceStyle",
    tr: {
      title: "🖼️ Haftanın en popüler 5 stili",
      body: "Diğer tasarımcılar neler yapıyor? İlham al.",
    },
    en: {
      title: "🖼️ The week's top 5 styles",
      body: "See what other designers are creating — get inspired.",
    },
  },
};

export function getCampaignTemplate(
  day: CampaignDay,
  language: SupportedLanguage,
): CampaignTemplateContent {
  return PRE_LAUNCH_TEMPLATES[day][language];
}

export function isCampaignDay(value: unknown): value is CampaignDay {
  return (
    typeof value === "number" &&
    (CAMPAIGN_DAYS as readonly number[]).includes(value)
  );
}
