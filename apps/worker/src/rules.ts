import { addDays, weekStartMonday, weekdayOf } from './time';

export function scheduleRuleToInt(rule: 'big_small' | 'double_rest' | 'single_rest'): number {
  if (rule === 'big_small') return 1;
  if (rule === 'double_rest') return 2;
  return 3;
}

export function weekTypeToInt(week: 'big' | 'small'): number {
  return week === 'big' ? 1 : 2;
}

export function weekTypeForDate(anchorDate: string, anchorWeekType: number, targetDate: string): number {
  const anchorWeekStart = weekStartMonday(anchorDate);
  const targetWeekStart = weekStartMonday(targetDate);
  const anchorMs = Date.parse(`${anchorWeekStart}T00:00:00Z`);
  const targetMs = Date.parse(`${targetWeekStart}T00:00:00Z`);
  const weekOffset = Math.floor((targetMs - anchorMs) / (7 * 24 * 60 * 60 * 1000));
  if (Math.abs(weekOffset) % 2 === 0) return anchorWeekType;
  return anchorWeekType === 1 ? 2 : 1;
}

export function isRestDay(params: {
  scheduleRule: number;
  anchorDate: string | null;
  anchorWeekType: number | null;
  date: string;
}): boolean {
  const day = weekdayOf(params.date);

  if (params.scheduleRule === 2) {
    return day === 0 || day === 6;
  }

  if (params.scheduleRule === 3) {
    return day === 0;
  }

  if (!params.anchorDate || !params.anchorWeekType) {
    return day === 0;
  }

  const weekType = weekTypeForDate(params.anchorDate, params.anchorWeekType, params.date);
  if (weekType === 1) {
    return day === 0 || day === 6;
  }
  return day === 0;
}

export function nextDate(date: string): string {
  return addDays(date, 1);
}
