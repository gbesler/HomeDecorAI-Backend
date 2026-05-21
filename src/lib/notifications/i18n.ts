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
  ar: {
    completed: {
      title: "تصميمك جاهز! 🎨",
      body: "ألقِ نظرة على تصميم المنزل الجديد.",
    },
    failed: {
      title: "حدث خطأ ما",
      body: "لم نتمكن من إنشاء تصميمك. يرجى المحاولة مرة أخرى.",
    },
  },
  "zh-Hans": {
    completed: {
      title: "您的设计已就绪！🎨",
      body: "看看您的新室内设计吧。",
    },
    failed: {
      title: "出了点问题",
      body: "无法生成您的设计，请重试。",
    },
  },
  "zh-Hant": {
    completed: {
      title: "您的設計已準備好！🎨",
      body: "看看您的全新室內設計。",
    },
    failed: {
      title: "發生問題",
      body: "無法建立您的設計，請再試一次。",
    },
  },
  hr: {
    completed: {
      title: "Vaš dizajn je spreman! 🎨",
      body: "Pogledajte svoj novi dizajn interijera.",
    },
    failed: {
      title: "Nešto je pošlo po zlu",
      body: "Nismo mogli izraditi vaš dizajn. Pokušajte ponovno.",
    },
  },
  cs: {
    completed: {
      title: "Váš design je hotový! 🎨",
      body: "Podívejte se na svůj nový interiérový design.",
    },
    failed: {
      title: "Něco se pokazilo",
      body: "Nepodařilo se vytvořit váš design. Zkuste to prosím znovu.",
    },
  },
  da: {
    completed: {
      title: "Dit design er klar! 🎨",
      body: "Se dit nye interiørdesign.",
    },
    failed: {
      title: "Noget gik galt",
      body: "Vi kunne ikke oprette dit design. Prøv igen.",
    },
  },
  nl: {
    completed: {
      title: "Je ontwerp is klaar! 🎨",
      body: "Bekijk je nieuwe interieurontwerp.",
    },
    failed: {
      title: "Er ging iets mis",
      body: "We konden je ontwerp niet maken. Probeer het opnieuw.",
    },
  },
  fi: {
    completed: {
      title: "Suunnitelmasi on valmis! 🎨",
      body: "Katso uusi sisustussuunnitelmasi.",
    },
    failed: {
      title: "Jokin meni vikaan",
      body: "Suunnitelman luominen epäonnistui. Yritä uudelleen.",
    },
  },
  fr: {
    completed: {
      title: "Votre design est prêt ! 🎨",
      body: "Découvrez votre nouveau design d'intérieur.",
    },
    failed: {
      title: "Une erreur s'est produite",
      body: "Nous n'avons pas pu créer votre design. Veuillez réessayer.",
    },
  },
  de: {
    completed: {
      title: "Dein Design ist fertig! 🎨",
      body: "Sieh dir dein neues Interieur-Design an.",
    },
    failed: {
      title: "Etwas ist schiefgelaufen",
      body: "Wir konnten dein Design nicht erstellen. Bitte versuche es erneut.",
    },
  },
  el: {
    completed: {
      title: "Ο σχεδιασμός σας είναι έτοιμος! 🎨",
      body: "Δείτε τον νέο σχεδιασμό εσωτερικού χώρου.",
    },
    failed: {
      title: "Κάτι πήγε στραβά",
      body: "Δεν μπορέσαμε να δημιουργήσουμε τον σχεδιασμό σας. Παρακαλώ δοκιμάστε ξανά.",
    },
  },
  he: {
    completed: {
      title: "העיצוב שלך מוכן! 🎨",
      body: "צפה בעיצוב הפנים החדש שלך.",
    },
    failed: {
      title: "משהו השתבש",
      body: "לא הצלחנו ליצור את העיצוב שלך. נסה שוב.",
    },
  },
  hu: {
    completed: {
      title: "A terved elkészült! 🎨",
      body: "Nézd meg az új belsőépítészeti tervedet.",
    },
    failed: {
      title: "Valami hiba történt",
      body: "Nem sikerült létrehozni a tervedet. Kérjük, próbáld újra.",
    },
  },
  id: {
    completed: {
      title: "Desain Anda siap! 🎨",
      body: "Lihat desain interior baru Anda.",
    },
    failed: {
      title: "Terjadi kesalahan",
      body: "Kami tidak dapat membuat desain Anda. Silakan coba lagi.",
    },
  },
  it: {
    completed: {
      title: "Il tuo design è pronto! 🎨",
      body: "Dai un'occhiata al tuo nuovo design d'interni.",
    },
    failed: {
      title: "Qualcosa è andato storto",
      body: "Non siamo riusciti a creare il tuo design. Riprova.",
    },
  },
  ja: {
    completed: {
      title: "デザインが完成しました！🎨",
      body: "新しいインテリアデザインをご覧ください。",
    },
    failed: {
      title: "問題が発生しました",
      body: "デザインを作成できませんでした。もう一度お試しください。",
    },
  },
  ko: {
    completed: {
      title: "디자인이 준비되었어요! 🎨",
      body: "새로운 인테리어 디자인을 확인해 보세요.",
    },
    failed: {
      title: "문제가 발생했습니다",
      body: "디자인을 만들지 못했습니다. 다시 시도해 주세요.",
    },
  },
  ms: {
    completed: {
      title: "Reka bentuk anda sedia! 🎨",
      body: "Lihat reka bentuk dalaman baharu anda.",
    },
    failed: {
      title: "Ada masalah berlaku",
      body: "Kami tidak dapat membuat reka bentuk anda. Sila cuba lagi.",
    },
  },
  nb: {
    completed: {
      title: "Designet ditt er klart! 🎨",
      body: "Se det nye interiørdesignet ditt.",
    },
    failed: {
      title: "Noe gikk galt",
      body: "Vi klarte ikke å lage designet ditt. Vennligst prøv igjen.",
    },
  },
  pl: {
    completed: {
      title: "Twój projekt jest gotowy! 🎨",
      body: "Zobacz swój nowy projekt wnętrza.",
    },
    failed: {
      title: "Coś poszło nie tak",
      body: "Nie udało nam się utworzyć projektu. Spróbuj ponownie.",
    },
  },
  pt: {
    completed: {
      title: "Seu design está pronto! 🎨",
      body: "Confira seu novo design de interiores.",
    },
    failed: {
      title: "Algo deu errado",
      body: "Não conseguimos criar seu design. Tente novamente.",
    },
  },
  ro: {
    completed: {
      title: "Designul tău este gata! 🎨",
      body: "Aruncă o privire la noul tău design de interior.",
    },
    failed: {
      title: "Ceva nu a mers bine",
      body: "Nu am putut crea designul tău. Te rugăm să încerci din nou.",
    },
  },
  ru: {
    completed: {
      title: "Ваш дизайн готов! 🎨",
      body: "Посмотрите свой новый дизайн интерьера.",
    },
    failed: {
      title: "Что-то пошло не так",
      body: "Не удалось создать ваш дизайн. Попробуйте ещё раз.",
    },
  },
  sk: {
    completed: {
      title: "Váš dizajn je hotový! 🎨",
      body: "Pozrite si svoj nový interiérový dizajn.",
    },
    failed: {
      title: "Niečo sa pokazilo",
      body: "Nepodarilo sa vytvoriť váš dizajn. Skúste to znova.",
    },
  },
  es: {
    completed: {
      title: "¡Tu diseño está listo! 🎨",
      body: "Echa un vistazo a tu nuevo diseño de interiores.",
    },
    failed: {
      title: "Algo salió mal",
      body: "No pudimos crear tu diseño. Por favor, inténtalo de nuevo.",
    },
  },
};

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  "tr",
  "en",
  "ar",
  "zh-Hans",
  "zh-Hant",
  "hr",
  "cs",
  "da",
  "nl",
  "fi",
  "fr",
  "de",
  "el",
  "he",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "nb",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "es",
] as const;

/**
 * Normalize an arbitrary language input to a supported language code.
 * Accepts full BCP-47 tags (`tr-TR`, `en-US`, `zh-Hans-CN`, `pt-BR`).
 * Match order: exact rawValue → script-aware prefix (e.g. `zh-Hans-CN` →
 * `zh-Hans`) → primary subtag (e.g. `pt-BR` → `pt`). Falls back to `en`.
 */
export function resolveLanguage(raw: unknown): SupportedLanguage {
  if (typeof raw !== "string" || raw.length === 0) return "en";
  const tag = raw.trim();
  if (tag.length === 0) return "en";

  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(tag)) {
    return tag as SupportedLanguage;
  }

  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.includes("-") && tag.startsWith(lang + "-")) {
      return lang;
    }
  }

  const primary = tag.toLowerCase().split("-")[0];
  if (primary && (SUPPORTED_LANGUAGES as readonly string[]).includes(primary)) {
    return primary as SupportedLanguage;
  }
  return "en";
}
