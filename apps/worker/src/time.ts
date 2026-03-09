const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function pad(v: number): string {
  return v < 10 ? `0${v}` : `${v}`;
}

export function parseHHMM(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(':').map((p) => Number.parseInt(p, 10));
  return { hour: h, minute: m };
}

export function zonedNowParts(timeZone: string, now = new Date()): {
  localDate: string;
  hour: number;
  minute: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const year = Number.parseInt(get('year'), 10);
  const month = Number.parseInt(get('month'), 10);
  const day = Number.parseInt(get('day'), 10);
  const hour = Number.parseInt(get('hour'), 10);
  const minute = Number.parseInt(get('minute'), 10);
  const wk = get('weekday');

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    localDate: `${year}-${pad(month)}-${pad(day)}`,
    hour,
    minute,
    weekday: weekdayMap[wk] ?? 0,
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function addDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return toIsoDate(new Date(t + days * DAY));
}

export function toIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

export function weekStartMonday(isoDate: string): string {
  const w = weekdayOf(isoDate);
  const diff = w === 0 ? -6 : 1 - w;
  return addDays(isoDate, diff);
}

export function daysBetweenInclusive(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const delta = Math.floor((end - start) / DAY);
  return delta + 1;
}

export function isDateInRange(target: string, start: string, end: string): boolean {
  return target >= start && target <= end;
}
