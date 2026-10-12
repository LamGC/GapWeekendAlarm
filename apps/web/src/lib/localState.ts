import type {
  AuthState,
  LocalLocalePack,
  LocalPreferences,
  LocalScheduleConfig,
  LocalTemplate,
} from '../types';

export function readLocalValue(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeLocalValue(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; }
  catch {
    window.dispatchEvent(new Event('gwa:local-storage-error'));
    return false;
  }
}

const PREFS_KEY = 'gwa:prefs';
const AUTH_KEY = 'gwa:auth';
const TEMPLATES_KEY = 'gwa:templates';
const PACKS_KEY = 'gwa:locale_packs';
const SCHEDULE_KEY = 'gwa:schedule';

const defaultPrefs: LocalPreferences = {
  locale: 'zh-CN',
  themeMode: 'system',
  dashboardView: 'ring',
  calendarWeekStart: 'sunday',
  calendarDateFormat: 'yyyy_mm_dd',
};

const defaultTemplates: LocalTemplate[] = [
  { type: 1, titleTemplate: '周末将至', bodyTemplate: '明天节奏可以慢一点。' },
  { type: 2, titleTemplate: '调休提醒', bodyTemplate: '请留意明天调休安排。' },
  { type: 3, titleTemplate: '工作日提醒', bodyTemplate: '明天是工作日，早点休息。' },
];

function getDefaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
}

function makeDefaultScheduleConfig(): LocalScheduleConfig {
  return {
    timezone: getDefaultTimezone(),
    enabledHolidaySources: [],
    weekendRemindTime: '17:00',
    workdayRemindTime: '20:00',
    scheduleRule: 'big_small',
    anchorDate: new Date().toISOString().slice(0, 10),
    anchorWeekType: 'big',
    weekendEnabled: true,
    workdayEnabled: true,
  };
}

export function loadPreferences(): LocalPreferences {
  const raw = readLocalValue(PREFS_KEY);
  if (!raw) return defaultPrefs;
  try {
    return { ...defaultPrefs, ...(JSON.parse(raw) as Partial<LocalPreferences>) };
  } catch {
    return defaultPrefs;
  }
}

export function savePreferences(value: LocalPreferences): void {
  writeLocalValue(PREFS_KEY, JSON.stringify(value));
}

export function loadAuthState(): AuthState {
  const raw = readLocalValue(AUTH_KEY);
  if (!raw) {
    return { clientId: crypto.randomUUID(), deviceToken: '' };
  }
  try {
    const parsed = JSON.parse(raw) as AuthState;
    return {
      clientId: parsed.clientId || crypto.randomUUID(),
      deviceToken: parsed.deviceToken || '',
    };
  } catch {
    return { clientId: crypto.randomUUID(), deviceToken: '' };
  }
}

export function saveAuthState(value: AuthState): void {
  writeLocalValue(AUTH_KEY, JSON.stringify(value));
}

export function loadScheduleConfig(): LocalScheduleConfig {
  const defaults = makeDefaultScheduleConfig();
  const raw = readLocalValue(SCHEDULE_KEY);
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw) as Partial<LocalScheduleConfig>;
    return {
      ...defaults,
      ...parsed,
      timezone: parsed.timezone || defaults.timezone,
      enabledHolidaySources: Array.isArray(parsed.enabledHolidaySources) ? parsed.enabledHolidaySources.filter((source): source is string => typeof source === 'string') : [],
      scheduleRule: parsed.scheduleRule || defaults.scheduleRule,
      anchorWeekType: parsed.anchorWeekType || defaults.anchorWeekType,
      weekendEnabled: parsed.weekendEnabled ?? defaults.weekendEnabled,
      workdayEnabled: parsed.workdayEnabled ?? defaults.workdayEnabled,
    };
  } catch {
    return defaults;
  }
}

export function saveScheduleConfig(value: LocalScheduleConfig): void {
  if (!writeLocalValue(SCHEDULE_KEY, JSON.stringify(value))) throw new Error('local_storage_unavailable');
}

export function loadTemplates(): LocalTemplate[] {
  const raw = readLocalValue(TEMPLATES_KEY);
  if (!raw) return defaultTemplates;
  try {
    const parsed = JSON.parse(raw) as LocalTemplate[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultTemplates;
    return parsed;
  } catch {
    return defaultTemplates;
  }
}

export function saveTemplates(value: LocalTemplate[]): void {
  writeLocalValue(TEMPLATES_KEY, JSON.stringify(value));
}

export function loadLocalePacks(): LocalLocalePack[] {
  const raw = readLocalValue(PACKS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LocalLocalePack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLocalePacks(value: LocalLocalePack[]): void {
  writeLocalValue(PACKS_KEY, JSON.stringify(value));
}
