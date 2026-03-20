import { NextResponse } from 'next/server';
import { renderScheduleReadyEmail } from '@/lib/emails/scheduleReadyEmail';
import { isDebugAllowed } from '@/lib/debug/isDebugAllowed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  if (!isDebugAllowed()) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const rendered = renderScheduleReadyEmail({
    restaurantName: 'Northside Grill',
    weekLabel: 'Week of March 2-8, 2026',
    employeeName: 'Jordan Lee',
    shifts: [
      { dateISO: '2026-03-02', startTime: '10:00', endTime: '18:00', jobLabel: 'Server', hours: 8, note: 'Please check side station before opening.' },
      { dateISO: '2026-03-05', startTime: '09:30', endTime: '12:30', jobLabel: 'Host', hours: 3 },
      { dateISO: '2026-03-05', startTime: '13:30', endTime: '21:00', jobLabel: 'Server', hours: 7.5, comment: 'Dining room section B after 5pm.' },
      { dateISO: '2026-03-06', startTime: '11:00', endTime: '19:15', jobLabel: 'Server', hours: 8.25, note: 'Close' },
      { dateISO: '2026-03-08', startTime: '12:00', endTime: '18:30', jobLabel: 'Server', hours: 6.5 },
    ],
    totalHours: 25,
    viewScheduleUrl: 'https://login.crewshyft.com/login?redirect=https%3A%2F%2Fapp.crewshyft.com%2Fschedule%2Fbuilder',
    manageNotificationsUrl: 'https://app.crewshyft.com/profile',
  });

  return new NextResponse(rendered.html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  });
}
