export type ThemeMode = 'light' | 'dark' | 'system';
export type DashboardView = 'ring' | 'calendar';
export type ScheduleRule = 'big_small' | 'double_rest' | 'single_rest';
export type ExtensionScope = 'holiday' | 'adjustment' | 'workday';
export type CalendarWeekStart = 'sunday' | 'monday';
export type CalendarDateFormat = 'yyyy_mm_dd' | 'mm_dd' | 'dd_mm';

export interface LocalPreferences {
  locale: 'zh-CN' | 'zh-HK' | 'zh-TW';
  themeMode: ThemeMode;
  dashboardView: DashboardView;
  calendarWeekStart: CalendarWeekStart;
  calendarDateFormat: CalendarDateFormat;
}

export interface LocalScheduleConfig {
  timezone: string;
  weekendRemindTime: string;
  workdayRemindTime: string;
  scheduleRule: ScheduleRule;
  anchorDate: string;
  anchorWeekType: 'big' | 'small';
  weekendEnabled: boolean;
  workdayEnabled: boolean;
}

export interface LocalTemplate {
  type: 1 | 2 | 3;
  titleTemplate: string;
  bodyTemplate: string;
}

export interface LocalLocalePack {
  id: string;
  pack_type: 'ui' | 'notification';
  locale: string;
  title: string;
  source: 'official' | 'file_import';
  enabled: boolean;
  payload: Record<string, unknown>;
  installed_at: string;
}

export interface AuthState {
  clientId: string;
  deviceToken: string;
}

export interface ExtensionRecord {
  id: string;
  scope: number;
  start_date: string;
  end_date: string;
  status: number;
  created_at: string;
}
