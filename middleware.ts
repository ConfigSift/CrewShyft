import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { parseBillingCookie } from '@/lib/billing/cookie';

const ROOT_DOMAIN = 'crewshyft.com';
const WWW_DOMAIN = 'www.crewshyft.com';
const LOGIN_SUBDOMAIN = 'login.crewshyft.com';
const APP_SUBDOMAIN = 'app.crewshyft.com';
const NO_ORG_REDIRECT_PATH = '/restaurants';
const APP_HOME_REDIRECT_PATH = '/dashboard';

const MARKETING_ROUTES = ['/', '/pricing', '/features', '/privacy', '/terms'];
const LOGIN_ROUTE_PREFIXES = ['/login', '/signup', '/start', '/onboarding', '/auth', '/reset-passcode'];
const APP_ROUTE_PREFIXES = [
  '/admin',
  '/dashboard',
  '/restaurants',
  '/join',
  '/staff',
  '/reports',
  '/chat',
  '/blocked-days',
  '/business-hours',
  '/schedule',
  '/profile',
  '/review-requests',
  '/time-off',
  '/billing',
  '/manager',
  '/shift-exchange',
  '/subscribe',
];

const PUBLIC_EXACT_PATHS = ['/'];
const PUBLIC_PATH_PREFIXES = ['/login', '/signup', '/start', '/onboarding', '/setup', '/auth/callback', '/auth/error'];
const AUTH_ENTRY_PATH_PREFIXES = ['/login', '/signup'];
const INVITE_ALLOWED_PATH_PREFIXES = ['/auth/invite', '/set-password', '/login', '/signup', '/start', '/onboarding', '/setup', '/auth'];
const RECOVERY_ALLOWED_PATH_PREFIXES = ['/auth/recovery', '/reset-password', '/login', '/signup', '/start', '/onboarding', '/setup', '/auth'];
const PROTECTED_APP_ROUTE_PREFIXES = [
  '/admin',
  '/join',
  '/dashboard',
  '/restaurants',
  '/staff',
  '/reports',
  '/chat',
  '/blocked-days',
  '/business-hours',
  '/schedule',
  '/profile',
  '/review-requests',
  '/time-off',
  '/billing',
  '/manager',
  '/shift-exchange',
  '/subscribe',
];

/** Routes that skip the subscription billing gate entirely */
const BILLING_EXEMPT_PREFIXES = [
  '/admin',
  '/subscribe',
  '/api/billing/',
  '/api/auth/',
  '/api/orgs/',
  '/api/organizations/',
  '/restaurants',
  '/manager',
  '/billing',
  '/login',
  '/signup',
  '/setup',
  '/pricing',
  '/start',
  '/onboarding',
  '/demo',
];

const BILLING_EXEMPT_EXACT = ['/', '/restaurants', '/start', '/onboarding'];
const SUPABASE_URL_REGEX = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
const SUPABASE_JWT_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function normalizeHost(rawHost: string | null) {
  return String(rawHost ?? '').split(':')[0].trim().toLowerCase();
}

function normalizeEnvValue(value?: string): string {
  if (!value) return '';
  let normalized = value.replace(/\r?\n/g, '').trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function getSupabaseEnvEdgeSafe() {
  const supabaseUrl = normalizeEnvValue(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseAnonKey = normalizeEnvValue(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const isValid =
    Boolean(supabaseUrl)
    && Boolean(supabaseAnonKey)
    && SUPABASE_URL_REGEX.test(supabaseUrl)
    && SUPABASE_JWT_REGEX.test(supabaseAnonKey);
  return { supabaseUrl, supabaseAnonKey, isValid };
}

function isManagerRole(value: unknown): boolean {
  const role = String(value ?? '').trim().toUpperCase();
  return role === 'ADMIN' || role === 'MANAGER';
}

let cachedPlatformAdminIds: string[] | null = null;
function getPlatformAdminIds(): string[] {
  if (cachedPlatformAdminIds) return cachedPlatformAdminIds;
  const raw = process.env.ADMIN_AUTH_USER_IDS ?? '';
  cachedPlatformAdminIds = raw.split(',').map((id) => id.trim()).filter(Boolean);
  return cachedPlatformAdminIds;
}

function isPlatformAdmin(authUserId: string): boolean {
  return getPlatformAdminIds().includes(authUserId);
}

function pathMatchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isMarketingRoute(pathname: string) {
  return MARKETING_ROUTES.some((route) => pathMatchesPrefix(pathname, route));
}

function isLoginRoute(pathname: string) {
  return LOGIN_ROUTE_PREFIXES.some((route) => pathMatchesPrefix(pathname, route));
}

function isAppRoute(pathname: string) {
  return APP_ROUTE_PREFIXES.some((route) => pathMatchesPrefix(pathname, route));
}

function isAuthEntryPath(pathname: string) {
  return AUTH_ENTRY_PATH_PREFIXES.some((route) => pathMatchesPrefix(pathname, route));
}

function isPublicPath(pathname: string) {
  if (PUBLIC_EXACT_PATHS.includes(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((route) => pathMatchesPrefix(pathname, route));
}

function isProtectedAppRoute(pathname: string) {
  return PROTECTED_APP_ROUTE_PREFIXES.some((route) => pathMatchesPrefix(pathname, route));
}

function isInviteAllowedPath(pathname: string) {
  return INVITE_ALLOWED_PATH_PREFIXES.some((route) => pathMatchesPrefix(pathname, route));
}

function isRecoveryAllowedPath(pathname: string) {
  return RECOVERY_ALLOWED_PATH_PREFIXES.some((route) => pathMatchesPrefix(pathname, route));
}

function isBillingExempt(pathname: string): boolean {
  if (BILLING_EXEMPT_EXACT.includes(pathname)) return true;
  return BILLING_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isNonPageAsset(pathname: string) {
  return (
    pathname.startsWith('/_next/')
    || pathname.startsWith('/api/')
    || pathname.startsWith('/favicon')
    || pathname.startsWith('/manifest')
    || pathname === '/robots.txt'
    || pathname === '/sitemap.xml'
    || /\.[A-Za-z0-9]+$/.test(pathname)
  );
}

function isLocalOrPreviewHost(host: string) {
  return (
    host.includes('localhost')
    || host.startsWith('127.0.0.1')
    || host.endsWith('.vercel.app')
  );
}

function isMarketingHost(host: string) {
  return host === ROOT_DOMAIN || host === WWW_DOMAIN;
}

function mapToLoginSubdomainPath(pathname: string) {
  if (pathMatchesPrefix(pathname, '/login')) {
    return '/';
  }
  return pathname;
}

function mapToAppSubdomainPath(pathname: string) {
  if (pathMatchesPrefix(pathname, '/dashboard')) {
    return '/';
  }
  return pathname;
}

function buildHostRedirectUrl(req: NextRequest, targetHost: string, targetPathname: string) {
  const url = req.nextUrl.clone();
  url.protocol = 'https';
  url.host = targetHost;
  url.pathname = targetPathname;
  return url;
}

function cloneSupabaseCookies(source: NextResponse, target: NextResponse) {
  source.cookies.getAll().forEach((cookie) => {
    target.cookies.set(cookie);
  });
}

function buildLoginRedirectUrl(req: NextRequest, localOrPreviewHost: boolean, nextPath: string) {
  // Keep auth redirects same-origin when the request is already on app.crewshyft.com
  // so Supabase session cookies are preserved on the same host.
  const host = normalizeHost(req.headers.get('host'));
  const sameOrigin = localOrPreviewHost || host === APP_SUBDOMAIN;
  const loginUrl = sameOrigin
    ? new URL('/login', req.url)
    : buildHostRedirectUrl(req, LOGIN_SUBDOMAIN, '/login');
  // Clear any inherited query from the source URL; only carry intent via `next`.
  loginUrl.search = '';
  if (nextPath) {
    loginUrl.searchParams.set('next', nextPath);
  }
  return loginUrl;
}

function buildAdminLoginRedirectUrl(req: NextRequest, localOrPreviewHost: boolean, nextPath: string) {
  const loginUrl = localOrPreviewHost
    ? new URL('/admin/login', req.url)
    : buildHostRedirectUrl(req, APP_SUBDOMAIN, '/admin/login');
  loginUrl.search = '';
  if (nextPath) {
    loginUrl.searchParams.set('next', nextPath);
  }
  return loginUrl;
}

function shouldRedirectToLoginSubdomain(host: string, pathname: string) {
  return isMarketingHost(host) && isLoginRoute(pathname);
}

function shouldRedirectToAppSubdomain(host: string, pathname: string) {
  return (isMarketingHost(host) && isAppRoute(pathname)) || (host === LOGIN_SUBDOMAIN && isAppRoute(pathname));
}

/** @deprecated Login is now served same-origin on app.crewshyft.com. */
function shouldRedirectToLoginFromApp() {
  return false;
}

async function runMiddleware(req: NextRequest) {
  const host = normalizeHost(req.headers.get('host'));
  const localOrPreviewHost = isLocalOrPreviewHost(host);
  const requestUrl = req.nextUrl.clone();
  const originalPathname = requestUrl.pathname;
  const requestPathWithQuery = `${originalPathname}${requestUrl.search}`;

  if (isNonPageAsset(originalPathname)) {
    return NextResponse.next();
  }

  if (pathMatchesPrefix(originalPathname, '/admin/login')) {
    return NextResponse.next();
  }

  const isAppRootRequest = host === APP_SUBDOMAIN && originalPathname === '/';
  const isPublicRoute = isPublicPath(originalPathname) && !isAppRootRequest;
  const isAuthEntryRoute = isAuthEntryPath(originalPathname);

  const createRedirect = (destination: string | URL, reason: string, status = 302) => {
    const redirectUrl =
      destination instanceof URL
        ? destination
        : destination.startsWith('http')
          ? new URL(destination)
          : new URL(destination, req.url);
    console.info(`[middleware] redirect ${host}${requestPathWithQuery} -> ${redirectUrl.host}${redirectUrl.pathname}${redirectUrl.search} (${reason})`);
    return NextResponse.redirect(redirectUrl, status);
  };

  if (!localOrPreviewHost && !isPublicRoute) {
    if (shouldRedirectToLoginSubdomain(host, originalPathname)) {
      const targetPath = mapToLoginSubdomainPath(originalPathname);
      return createRedirect(buildHostRedirectUrl(req, LOGIN_SUBDOMAIN, targetPath), 'host:marketing-to-login');
    }

    if (shouldRedirectToAppSubdomain(host, originalPathname)) {
      const targetPath = mapToAppSubdomainPath(originalPathname);
      return createRedirect(buildHostRedirectUrl(req, APP_SUBDOMAIN, targetPath), 'host:to-app');
    }

    if (shouldRedirectToLoginFromApp()) {
      const targetPath = mapToLoginSubdomainPath(originalPathname);
      return createRedirect(buildHostRedirectUrl(req, LOGIN_SUBDOMAIN, targetPath), 'host:app-to-login');
    }

    if (host === LOGIN_SUBDOMAIN && isMarketingRoute(originalPathname)) {
      return createRedirect(buildHostRedirectUrl(req, ROOT_DOMAIN, originalPathname), 'host:login-to-marketing');
    }
  }

  const response = NextResponse.next();
  let routeForGuards = originalPathname;
  if (!localOrPreviewHost && host === APP_SUBDOMAIN && (originalPathname === '/' || originalPathname === '/schedule')) {
    routeForGuards = '/dashboard';
  }

  const protectedRoute = isProtectedAppRoute(routeForGuards);
  const authEntryForGuards = isAuthEntryPath(routeForGuards);
  const inviteRequired = req.cookies.get('cs_invite_required')?.value === '1';
  const inviteAllowedRoute = isInviteAllowedPath(routeForGuards);
  const recoveryRequired = req.cookies.get('cs_recovery_required')?.value === '1';
  const recoveryAllowedRoute = isRecoveryAllowedPath(routeForGuards);

  if (inviteRequired) {
    if (!inviteAllowedRoute) {
      return createRedirect('/set-password', 'invite:required');
    }

    return response;
  }

  if (recoveryRequired) {
    if (!recoveryAllowedRoute) {
      return createRedirect('/reset-password', 'recovery:required');
    }

    return response;
  }

  if (isPublicRoute && !isAuthEntryRoute) {
    return response;
  }

  if (!protectedRoute && !authEntryForGuards) {
    return response;
  }

  const { supabaseUrl, supabaseAnonKey, isValid } = getSupabaseEnvEdgeSafe();
  if (!isValid) {
    // Supabase is misconfigured — fail closed for protected routes rather than silently passing through.
    if (protectedRoute) {
      const host = normalizeHost(req.headers.get('host'));
      const localOrPreview = isLocalOrPreviewHost(host);
      return NextResponse.redirect(buildLoginRedirectUrl(req, localOrPreview, originalPathname));
    }
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookies) {
        cookies.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  let user: { id: string; user_metadata?: Record<string, unknown> } | null = null;

  try {
    const { data } = await supabase.auth.getUser();
    user = data.user ?? null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('Refresh Token Not Found')
      || message.includes('Invalid Refresh Token')
    ) {
      user = null;
    } else {
      throw error;
    }
  }

  const redirectTo = (destination: string | URL, reason: string, status = 302) => {
    const redirectUrl =
      destination instanceof URL
        ? destination
        : destination.startsWith('http')
          ? new URL(destination)
          : new URL(destination, req.url);
    console.info(`[middleware] redirect ${host}${requestPathWithQuery} -> ${redirectUrl.host}${redirectUrl.pathname}${redirectUrl.search} (${reason})`);
    const redirect = NextResponse.redirect(redirectUrl, status);
    cloneSupabaseCookies(response, redirect);
    return redirect;
  };

  if (!user) {
    if (!protectedRoute) {
      return response;
    }
    // Preserve the full original path + query so login can return users to deep admin URLs.
    const nextPath = `${originalPathname}${requestUrl.search}`;
    if (pathMatchesPrefix(routeForGuards, '/admin')) {
      return redirectTo(buildAdminLoginRedirectUrl(req, localOrPreviewHost, nextPath), 'auth:missing-session:admin');
    }
    return redirectTo(buildLoginRedirectUrl(req, localOrPreviewHost, nextPath), 'auth:missing-session');
  }

  if (authEntryForGuards) {
    // When on a non-app host (e.g. login.crewshyft.com), redirect directly to
    // app.crewshyft.com so users don't land on login.crewshyft.com/dashboard.
    if (!localOrPreviewHost && host !== APP_SUBDOMAIN) {
      return redirectTo(
        buildHostRedirectUrl(req, APP_SUBDOMAIN, APP_HOME_REDIRECT_PATH),
        'auth:already-signed-in:cross-origin',
      );
    }
    return redirectTo(APP_HOME_REDIRECT_PATH, 'auth:already-signed-in');
  }

  const onRestaurantsRoute = pathMatchesPrefix(routeForGuards, '/restaurants');
  const onSetupRoute = pathMatchesPrefix(routeForGuards, '/setup');
  const onAdminRoute = pathMatchesPrefix(routeForGuards, '/admin');
  if (!onRestaurantsRoute && !onSetupRoute && !onAdminRoute) {
    const { count, error: membershipCountError } = await supabase
      .from('organization_memberships')
      .select('organization_id', { count: 'exact', head: true })
      .eq('auth_user_id', user.id);

    if (!membershipCountError && (count ?? 0) === 0) {
      return redirectTo(NO_ORG_REDIRECT_PATH, 'org:no-memberships');
    }
  }

  if (pathMatchesPrefix(routeForGuards, '/admin')) {
    if (!isPlatformAdmin(user.id)) {
      return redirectTo('/dashboard?notice=forbidden', 'admin:not-platform-admin');
    }
  }

  if (pathMatchesPrefix(routeForGuards, '/manager')) {
    try {
      const { data: profile } = await supabase
        .from('users')
        .select('role')
        .eq('auth_user_id', user.id)
        .maybeSingle();

      const roleValue = profile?.role ?? user.user_metadata?.role ?? undefined;
      if (!isManagerRole(roleValue)) {
        return redirectTo('/dashboard?notice=forbidden', 'role:manager-required');
      }
    } catch {
      return redirectTo('/dashboard?notice=forbidden', 'role:manager-check-failed');
    }
  }

  const billingEnabled = process.env.NEXT_PUBLIC_BILLING_ENABLED === 'true';
  if (billingEnabled && !isBillingExempt(routeForGuards)) {
    const billingCookie = parseBillingCookie(req.cookies.get('sf_billing_ok')?.value);

    if (billingCookie.status === 'none' || billingCookie.stale) {
      const statusUrl = new URL('/api/billing/subscription-status', req.url);
      statusUrl.searchParams.set('next', `${originalPathname}${requestUrl.search}`);
      return redirectTo(statusUrl, 'billing:missing-cookie');
    }

    if (billingCookie.status === 'past_due') {
      // past_due: redirect to billing rather than only setting a header that the UI may ignore.
      // NOTE: as of now no server path writes 'past_due' to this cookie — subscription-status
      // only writes 'active' or clears it, and authStore.ts only writes 'active'.
      // This branch is reserved for future use (e.g. webhook-driven status propagation).
      return redirectTo('/billing?notice=past_due', 'billing:past_due');
    }
  }

  return response;
}

export async function middleware(req: NextRequest) {
  try {
    return await runMiddleware(req);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const stack = err.stack ? ` | ${err.stack}` : '';
    console.error(`[middleware] unhandled error: ${err.message}${stack}`);

    // Fail closed: redirect to login for protected routes rather than silently passing through.
    const pathname = req.nextUrl.pathname;
    if (!isNonPageAsset(pathname) && isProtectedAppRoute(pathname)) {
      const host = normalizeHost(req.headers.get('host'));
      const localOrPreview = isLocalOrPreviewHost(host);
      return NextResponse.redirect(buildLoginRedirectUrl(req, localOrPreview, pathname));
    }

    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|_next/data|favicon.ico|robots.txt|sitemap.xml|manifest|manifest.webmanifest|manifest.json|.*\\..*).*)',
  ],
};
