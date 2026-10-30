// The shell's words. The table is the `desktop.*` slice of the one language
// pack (`static/strings.json`, built by scripts/strings.mjs).
//
// Two ways to read it:
//  - `t()` follows the page. Once the page has loaded it tells us its language
//    and the strings it resolved (`setLocale`), so the tray and menus match a
//    pack the page fetched after this build — newer wording, same keys.
//  - `frozen()` never does. A confirmation dialog is the one place the page must
//    not be able to choose the words: a card running in the page can call the
//    bridge, and a dialog it could rewrite would confirm whatever it liked.

export type StringTable = Record<string, Record<string, string>>;

const MAX_LEN = 300;

export class Strings {
  private lang: string;
  private overrides: Record<string, string> = {};

  constructor(private table: StringTable, locale: string) {
    this.lang = Strings.pickLang(table, locale);
  }

  /** `zh`, `zh-CN`, `zh-Hans-CN` … → the zh-Hans pack; an exact pack name wins;
   *  anything else reads English. */
  static pickLang(table: StringTable, locale: string): string {
    if (locale in table) return locale;
    const lower = locale.toLowerCase();
    if (lower.startsWith("zh") && "zh-Hans" in table) return "zh-Hans";
    const base = lower.split(/[-_]/)[0];
    const match = Object.keys(table).find((l) => l.toLowerCase() === base);
    return match ?? "en";
  }

  get language(): string {
    return this.lang;
  }

  /** The page's language and wording. Unknown keys and over-long values are
   *  ignored; an unknown language keeps the current one. */
  setLocale(lang: string, strings: Record<string, unknown>): void {
    this.lang = Strings.pickLang(this.table, lang);
    const known = this.table.en ?? {};
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(strings ?? {})) {
      if (k in known && typeof v === "string" && v.length > 0 && v.length <= MAX_LEN) next[k] = v;
    }
    this.overrides = next;
  }

  t(key: string, vars?: Record<string, string | number>): string {
    return fill(this.overrides[key] ?? this.base(key), vars);
  }

  frozen(key: string, vars?: Record<string, string | number>): string {
    return fill(this.base(key), vars);
  }

  private base(key: string): string {
    return this.table[this.lang]?.[key] ?? this.table.en?.[key] ?? key;
  }
}

const fill = (s: string, vars?: Record<string, string | number>): string =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
