import en from "./en.json";

const dictionary: Record<string, string> = en;
const KEY = "agent-graph-language";

function saved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Korean is the source text and the default. A change reloads the page. */
export const language = saved() === "en" ? "en" : "ko";
document.documentElement.lang = language;

export function t(text: string, ...values: unknown[]): string {
  // Spacing around a text belongs to its layout, so the dictionary leaves it out.
  const key = text.trim();
  const chosen =
    language === "en" && dictionary[key]
      ? text.replace(key, dictionary[key]!)
      : text;
  return values.length
    ? chosen.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)]))
    : chosen;
}

export function setLanguage(next: "ko" | "en"): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // The choice only lasts for this page, and the reload below drops it.
  }
  location.reload();
}
