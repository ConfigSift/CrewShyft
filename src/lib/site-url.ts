function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

export function getSiteUrl() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.SITE_URL?.trim();
  if (configured) {
    return trimTrailingSlash(configured);
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return trimTrailingSlash(`https://${vercelUrl}`);
  }

  return 'http://localhost:3000';
}

export function getAuthCallbackUrl() {
  return `${getSiteUrl()}/auth/callback`;
}
