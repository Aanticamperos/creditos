const BOGOTA_TZ = 'America/Bogota';

const isoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOGOTA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const shortDateFormatter = new Intl.DateTimeFormat('es-CO', {
  timeZone: BOGOTA_TZ,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('es-CO', {
  timeZone: BOGOTA_TZ,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Current YYYY-MM-DD date in Colombia (America/Bogota, UTC-5). */
export function todayBogota(): string {
  return isoDateFormatter.format(new Date());
}

/** Add signed days to an ISO YYYY-MM-DD date safely in UTC noon to avoid DST drift. */
export function addDaysISO(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Calendar day difference (end - start). */
export function diffDaysISO(startISO: string, endISO: string): number {
  const start = new Date(`${startISO}T12:00:00Z`).getTime();
  const end = new Date(`${endISO}T12:00:00Z`).getTime();
  return Math.round((end - start) / 86_400_000);
}

export function formatDateCO(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  const normalized = isoDate.length === 10 ? `${isoDate}T12:00:00Z` : isoDate;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return isoDate;
  return shortDateFormatter.format(date);
}

export function formatDateTimeCO(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return '—';
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp;
  return dateTimeFormatter.format(date);
}

/** Computes the next calendar-month date anchored to `billingDay` (1..31), clamping to month end. */
export function nextCalendarMonthDate(afterISO: string, billingDay: number): string {
  const [yStr, mStr] = afterISO.split('-');
  let year = Number(yStr);
  let month = Number(mStr) + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clampedDay = Math.min(Math.max(1, billingDay), daysInMonth);
  return `${year}-${String(month).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}
