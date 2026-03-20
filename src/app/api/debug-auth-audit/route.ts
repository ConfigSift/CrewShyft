// DEV ONLY: audit for duplicate auth/email mappings. Do not enable in prod.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export { handleAuthAudit as GET } from '@/lib/debug/authAudit';
