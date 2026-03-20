// DEV ONLY: check auth user existence by email. Do not enable in prod.
// Note: /api/debug-auth-by-email is an alias for this route and is the path
// referenced in docs/STAFF-AUTH-VERIFY.md developer scripts.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export { handleAuthByEmail as GET } from '@/lib/debug/authByEmail';
