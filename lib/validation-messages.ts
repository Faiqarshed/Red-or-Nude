// Field-check messages, shared by the admin panel and the customer site.
//
// Their own module so the site can say the same sentences as the admin forms
// without shipping every admin string to the browser. lib/admin/validate.ts
// builds each message from these; the admin strings file re-exports them.

const ar = {
  summary: (n: number) => (n === 1 ? "قبل الحفظ، يرجى تصحيح ما يلي:" : `قبل الحفظ، يرجى تصحيح ${n} أمور:`),
  required: (f: string) => `«${f}» مطلوب`,
  number: (f: string) => `«${f}» يجب أن يكون رقماً`,
  whole: (f: string) => `«${f}» يجب أن يكون عدداً صحيحاً بدون كسور`,
  min: (f: string, n: number) => `«${f}» يجب ألا يقل عن ${n.toLocaleString("en-US")}`,
  max: (f: string, n: number) => `«${f}» يجب ألا يزيد عن ${n.toLocaleString("en-US")}`,
  positive: (f: string) => `«${f}» يجب أن يكون أكبر من صفر`,
  nonZero: (f: string) => `«${f}» لا يمكن أن يكون صفراً`,
  tooShort: (f: string, n: number) => `«${f}» يجب أن يكون ${n} أحرف على الأقل`,
  tooLong: (f: string, n: number) => `«${f}» يجب ألا يتجاوز ${n} حرفاً`,
  email: (f: string) => `«${f}» ليس بريداً إلكترونياً صحيحاً (مثال: name@example.com)`,
  mobile: (f: string) => `«${f}» يجب أن يكون رقم جوال سعودي: 05 ثم 8 أرقام`,
  after: (f: string, other: string) => `«${f}» يجب أن يكون بعد «${other}»`,
  notBefore: (f: string, other: string) => `«${f}» لا يمكن أن يكون قبل «${other}»`,
  future: (f: string) => `«${f}» يجب أن يكون تاريخاً في الماضي`,
  letters: (f: string) => `«${f}» يجب أن يحتوي على حروف، لا أرقام أو رموز فقط`,
  arabic: (f: string) =>
    `«${f}» يجب أن يُكتب بالحروف العربية، أو يطابق الاسم الإنجليزي تماماً إذا كان اسماً تجارياً مثل BIAB`,
  notArabic: (f: string) => `«${f}» يجب أن يُكتب بالإنجليزية، ففيه حروف عربية`,
  decimals: (f: string, n: number) => `«${f}» يقبل ${n} خانات عشرية كحد أقصى (مثال: 99.50)`,
  repeated: (f: string, word: string) => `«${f}»: «${word}» فيها نفس الحرف 3 مرات متتالية. تحققي من الكتابة`,
  gibberish: (f: string, word: string) => `«${f}»: «${word}» لا تبدو كلمة حقيقية. تحققي من الكتابة`,
  blocked: (ch: string, allowed: string) => `لا يمكن استخدام «${ch}» هنا. المسموح: حروف وأرقام و ${allowed}`,
  blockedArabic: "الحروف العربية تُكتب في الخانة العربية",
  blockedName: (ch: string, allowed: string) => `لا يمكن استخدام «${ch}» في الاسم. المسموح: حروف ومسافات و ${allowed}`,
  blockedEmail: (ch: string, allowed: string) =>
    `لا يمكن استخدام «${ch}» في البريد الإلكتروني. المسموح: حروف إنجليزية وأرقام و ${allowed}`,
  emailOneAt: "البريد الإلكتروني يحتوي على علامة @ واحدة فقط",
  emailNoAt: (f: string) => `«${f}» يحتاج إلى علامة @، مثل name@example.com`,
  emailNoLocal: (f: string) => `«${f}» ينقصه الجزء قبل علامة @`,
  emailNoDomain: (f: string) => `«${f}» ينقصه النطاق بعد علامة @، مثل example.com`,
  emailDots: (f: string) => `«${f}» لا يمكن أن يبدأ أو ينتهي بنقطة قبل @، ولا أن يحتوي على نقطتين متتاليتين`,
  emailTld: (f: string) => `«${f}» يجب أن ينتهي بحروف بعد آخر نقطة، مثل ‎.com أو ‎.sa`,
  emailGibberish: (f: string, part: string) => `«${f}»: «${part}» لا يبدو بريداً حقيقياً. تحققي منه.`,
  passwordWeak: "كلمة المرور تحتاج إلى حرف ورقم واحد على الأقل",
  passwordEdges: "كلمة المرور لا يمكن أن تبدأ أو تنتهي بمسافة",
  cut: (n: number) => `الحد ${n} حرفاً، وتم قص الزائد`,
  notFound: "لم يعد هذا العنصر موجوداً. أغلقي النافذة وحدّثي الصفحة",
};

export type ValidationMessages = typeof ar;

const en: ValidationMessages = {
  summary: (n: number) => (n === 1 ? "Fix this before saving:" : `Fix these ${n} things before saving:`),
  required: (f: string) => `${f} is required`,
  number: (f: string) => `${f} must be a number`,
  whole: (f: string) => `${f} must be a whole number`,
  min: (f: string, n: number) => `${f} must be at least ${n.toLocaleString("en-US")}`,
  max: (f: string, n: number) => `${f} can't be more than ${n.toLocaleString("en-US")}`,
  positive: (f: string) => `${f} must be more than 0`,
  nonZero: (f: string) => `${f} can't be 0`,
  tooShort: (f: string, n: number) => `${f} needs at least ${n} characters`,
  tooLong: (f: string, n: number) => `${f} can't be longer than ${n} characters`,
  email: (f: string) => `${f} isn't a valid email address (e.g. name@example.com)`,
  mobile: (f: string) => `${f} must be a Saudi mobile: 05 followed by 8 digits`,
  after: (f: string, other: string) => `${f} must be after ${other}`,
  notBefore: (f: string, other: string) => `${f} can't be before ${other}`,
  future: (f: string) => `${f} must be a date in the past`,
  letters: (f: string) => `${f} must contain letters, not only numbers or symbols`,
  arabic: (f: string) =>
    `${f} must be written in Arabic letters, or match the English name exactly for a brand term like BIAB`,
  notArabic: (f: string) => `${f} must be in English, but it contains Arabic letters`,
  decimals: (f: string, n: number) => `${f} can have at most ${n} decimal places (e.g. 99.50)`,
  repeated: (f: string, word: string) => `${f}: "${word}" has the same letter 3 times in a row. Please check the spelling.`,
  gibberish: (f: string, word: string) => `${f}: "${word}" doesn't look like a real word. Please check the spelling.`,
  blocked: (ch: string, allowed: string) => `"${ch}" can't be used here. Allowed: letters, numbers and ${allowed}`,
  blockedArabic: "Arabic letters go in the Arabic box",
  blockedName: (ch: string, allowed: string) => `"${ch}" can't be used in a name. Allowed: letters, spaces and ${allowed}`,
  blockedEmail: (ch: string, allowed: string) =>
    `"${ch}" can't be used in an email. Allowed: English letters, numbers and ${allowed}`,
  emailOneAt: "An email address has only one @",
  emailNoAt: (f: string) => `${f} needs an @, like name@example.com`,
  emailNoLocal: (f: string) => `${f} is missing the part before the @`,
  emailNoDomain: (f: string) => `${f} is missing the domain after the @, like example.com`,
  emailDots: (f: string) => `${f} can't start or end with a dot before the @, or have two dots in a row`,
  emailTld: (f: string) => `${f} must end in letters after the last dot, like .com or .sa`,
  emailGibberish: (f: string, part: string) => `${f}: "${part}" doesn't look like a real email. Please check it.`,
  passwordWeak: "Password needs at least one letter and one number",
  passwordEdges: "Password can't start or end with a space",
  cut: (n: number) => `The limit is ${n} characters, so the extra was cut off`,
  notFound: "This item no longer exists. Close this and refresh the page.",
};

export const validationMessages = { ar, en } as const;
