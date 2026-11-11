import { vi } from './vi';
import { en } from './en';

export type Locale = 'vi' | 'en';
export type Translations = typeof vi;

export const translations: Record<Locale, Translations> = {
  vi,
  en,
};

/**
 * Nested key path type for type-safe key lookup
 * e.g. "common.dashboard" | "status.running"
 */
type NestedKeyOf<ObjectType extends object> = {
  [Key in keyof ObjectType & (string | number)]: ObjectType[Key] extends object
    ? `${Key}.${NestedKeyOf<ObjectType[Key]>}`
    : `${Key}`;
}[keyof ObjectType & (string | number)];

export type TranslationKey = NestedKeyOf<Translations>;

export function getNestedValue(obj: any, path: string): string | undefined {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number | undefined | null>,
): string {
  const dict = translations[locale] || translations.vi;
  let text = getNestedValue(dict, key) || getNestedValue(translations.vi, key) || key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{\\{?${k}\\}?\\}`, 'g'), v !== undefined && v !== null ? String(v) : '');
    }
  }

  if (params?.appName !== undefined && params.appName !== null) {
    text = text.replace(/AgentHub/g, String(params.appName));
  }

  return text;
}
