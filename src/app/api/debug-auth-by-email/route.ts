// DEV ONLY: alias for debug-auth-email — check auth user existence by email. Do not enable in prod.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export { handleAuthByEmail as GET } from '@/lib/debug/authByEmail';
