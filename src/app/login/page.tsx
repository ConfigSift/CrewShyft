import LoginClient from './LoginClient';

type LoginSearchParams = {
  notice?: string | string[];
  next?: string | string[];
};

type LoginPageProps = {
  searchParams?: Promise<LoginSearchParams> | LoginSearchParams;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedParams = await Promise.resolve(searchParams ?? {});
  const notice = Array.isArray(resolvedParams.notice) ? resolvedParams.notice[0] : resolvedParams.notice;
  const nextPath = Array.isArray(resolvedParams.next) ? resolvedParams.next[0] : resolvedParams.next;
  return <LoginClient notice={notice} nextPath={nextPath} />;
}
