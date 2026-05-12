export const BILIBILI_COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3'] as const;

export type BrowserCookiePreset = 'bilibili';

export interface SourceCookieAuthConfig {
  url?: string;
  domain?: string;
  names?: string[];
  requiredNames?: string[];
  preset?: BrowserCookiePreset;
}

export interface BrowserCookieCredentialCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  expires?: number;
}

export interface SourceCookieCredentialValue {
  version: 1;
  cookieHeader: string;
  cookies: BrowserCookieCredentialCookie[];
  source: {
    preset?: BrowserCookiePreset;
    url?: string;
    domain?: string;
    names: string[];
  };
  createdAt: number;
  expiresAt?: number;
}

export function getCookiePresetNames(preset: string | undefined): string[] {
  if (preset === 'bilibili') return [...BILIBILI_COOKIE_NAMES];
  return [];
}

export function resolveCookieAuthNames(config?: SourceCookieAuthConfig | null): string[] {
  const names = config?.names?.filter(Boolean) ?? [];
  if (names.length > 0) return names;
  return getCookiePresetNames(config?.preset);
}

export function resolveRequiredCookieNames(config?: SourceCookieAuthConfig | null): string[] {
  const required = config?.requiredNames?.filter(Boolean) ?? [];
  if (required.length > 0) return required;
  return resolveCookieAuthNames(config);
}

export function serializeCookieHeader(cookies: Array<Pick<BrowserCookieCredentialCookie, 'name' | 'value'>>): string {
  return cookies
    .filter((cookie) => cookie.name && cookie.value !== undefined)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function computeCookieCredentialExpiry(cookies: BrowserCookieCredentialCookie[]): number | undefined {
  const expires = cookies
    .map((cookie) => cookie.expires)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (expires.length === 0) return undefined;
  return Math.min(...expires) * 1000;
}

export function createSourceCookieCredentialValue(args: {
  cookies: BrowserCookieCredentialCookie[];
  preset?: BrowserCookiePreset;
  url?: string;
  domain?: string;
  names: string[];
  createdAt?: number;
}): SourceCookieCredentialValue {
  const createdAt = args.createdAt ?? Date.now();
  const credential: SourceCookieCredentialValue = {
    version: 1,
    cookieHeader: serializeCookieHeader(args.cookies),
    cookies: args.cookies,
    source: {
      preset: args.preset,
      url: args.url,
      domain: args.domain,
      names: args.names,
    },
    createdAt,
    expiresAt: computeCookieCredentialExpiry(args.cookies),
  };
  return credential;
}

export function parseSourceCookieCredentialValue(value: string): SourceCookieCredentialValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<SourceCookieCredentialValue>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.cookieHeader !== 'string' || !parsed.cookieHeader) return null;
    if (!Array.isArray(parsed.cookies)) return null;
    return parsed as SourceCookieCredentialValue;
  } catch {
    return null;
  }
}

export function getCookieHeaderFromCredentialValue(value: string): string | null {
  const parsed = parseSourceCookieCredentialValue(value);
  return parsed?.cookieHeader || null;
}
