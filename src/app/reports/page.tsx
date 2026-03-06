import { ReportsPageContent } from '../../components/reports/ReportsPageContent';

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value?: string | string[]): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function isReportView(value?: string): value is 'roster' | 'timeline' | 'weekly' {
  return value === 'roster' || value === 'timeline' || value === 'weekly';
}

export default function ReportsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const viewParam = firstParam(searchParams?.view);
  const dateParam = firstParam(searchParams?.date);
  const startParam = firstParam(searchParams?.start);
  const initialView = isReportView(viewParam) ? viewParam : undefined;
  const initialDate = startParam ?? dateParam;

  return (
    <div className="w-full bg-theme-primary text-theme-primary print:bg-white print:text-black">
      <div className="mx-auto w-full max-w-[1100px] p-6">
        <ReportsPageContent initialView={initialView} initialDate={initialDate} />
      </div>
    </div>
  );
}
