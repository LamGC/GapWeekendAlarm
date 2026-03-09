import type {
  AuthState,
  LocalLocalePack,
  LocalPreferences,
  LocalScheduleConfig,
  LocalTemplate,
} from '../types';

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
  const raw = localStorage.getItem(PREFS_KEY);
  if (!raw) return defaultPrefs;
  try {
    return { ...defaultPrefs, ...(JSON.parse(raw) as Partial<LocalPreferences>) };
  } catch {
    return defaultPrefs;
  }
}

export function savePreferences(value: LocalPreferences): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(value));
}

export function loadAuthState(): AuthState {
  const raw = localStorage.getItem(AUTH_KEY);
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
  localStorage.setItem(AUTH_KEY, JSON.stringify(value));
}

export function loadScheduleConfig(): LocalScheduleConfig {
  const defaults = makeDefaultScheduleConfig();
  const raw = localStorage.getItem(SCHEDULE_KEY);
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw) as Partial<LocalScheduleConfig>;
    return {
      ...defaults,
      ...parsed,
      timezone: parsed.timezone || defaults.timezone,
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
  localStorage.setItem(SCHEDULE_KEY, JSON.stringify(value));
}

export function loadTemplates(): LocalTemplate[] {
  const raw = localStorage.getItem(TEMPLATES_KEY);
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
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(value));
}

export function loadLocalePacks(): LocalLocalePack[] {
  const raw = localStorage.getItem(PACKS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LocalLocalePack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLocalePacks(value: LocalLocalePack[]): void {
  localStorage.setItem(PACKS_KEY, JSON.stringify(value));
}
