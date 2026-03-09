import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  CssBaseline,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ThemeProvider,
  Typography,
  createTheme,
  useMediaQuery,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type TouchEvent, type UIEvent } from 'react';
import {
  createExtension,
  deleteSubscription,
  fetchConfig,
  getSubscription,
  listExtensions,
  registerSubscription,
  removeExtension,
  updateSubscription,
} from './lib/api';
import {
  loadAuthState,
  loadLocalePacks,
  loadPreferences,
  loadScheduleConfig,
  loadTemplates,
  saveAuthState,
  saveLocalePacks,
  savePreferences,
  saveScheduleConfig,
  saveTemplates,
} from './lib/localState';
import type {
  CalendarDateFormat,
  CalendarWeekStart,
  DashboardView,
  ExtensionRecord,
  ExtensionScope,
  LocalLocalePack,
  LocalTemplate,
  ScheduleRule,
  ThemeMode,
} from './types';

const LOCALES = ['zh-CN', 'zh-HK', 'zh-TW'] as const;
const HOURS = Array.from({ length: 24 }, (_, idx) => pad2(idx));
const MINUTES = Array.from({ length: 60 }, (_, idx) => pad2(idx));

type TurnstileWidgetId = string | number;

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: string;
  action?: string;
  callback: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement | string, options: TurnstileRenderOptions) => TurnstileWidgetId;
  reset: (widgetId?: TurnstileWidgetId) => void;
  remove?: (widgetId: TurnstileWidgetId) => void;
}

interface TimeZoneGroup {
  region: string;
  label: string;
  zones: string[];
}

interface ToastMessage {
  id: number;
  text: string;
  type: 'success' | 'error';
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function App() {
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() || '';
  const isLocalDevHost = isLocalDevelopmentHost(window.location.hostname);
  const [initialSchedule] = useState(loadScheduleConfig);

  const [tab, setTab] = useState(0);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);

  const [prefs, setPrefs] = useState(loadPreferences);
  const [auth, setAuth] = useState(loadAuthState);
  const [templates, setTemplates] = useState<LocalTemplate[]>(loadTemplates);
  const [packs, setPacks] = useState<LocalLocalePack[]>(loadLocalePacks);

  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileError, setTurnstileError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(initialSchedule.timezone || systemTimezone);
  const [weekendTime, setWeekendTime] = useState(initialSchedule.weekendRemindTime);
  const [workdayTime, setWorkdayTime] = useState(initialSchedule.workdayRemindTime);
  const [scheduleRule, setScheduleRule] = useState<ScheduleRule>(initialSchedule.scheduleRule);
  const [anchorDate, setAnchorDate] = useState(initialSchedule.anchorDate);
  const [anchorWeekType, setAnchorWeekType] = useState<'big' | 'small'>(initialSchedule.anchorWeekType);
  const [weekendEnabled, setWeekendEnabled] = useState(initialSchedule.weekendEnabled);
  const [workdayEnabled, setWorkdayEnabled] = useState(initialSchedule.workdayEnabled);
  const [timezoneMismatch, setTimezoneMismatch] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'default' : Notification.permission
  );

  const [extensionScope, setExtensionScope] = useState<ExtensionScope>('holiday');
  const [extensionStart, setExtensionStart] = useState(todayISO());
  const [extensionEnd, setExtensionEnd] = useState(addDaysISO(todayISO(), 3));
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([]);

  const [cloudDisabled, setCloudDisabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const COUNTDOWN_UNITS = ['days', 'hours', 'seconds'] as const;
  type CountdownUnit = (typeof COUNTDOWN_UNITS)[number];
  const [countdownUnit, setCountdownUnit] = useState<CountdownUnit>(() => {
    const saved = localStorage.getItem('gwa:countdownUnit');
    return (COUNTDOWN_UNITS as readonly string[]).includes(saved ?? '') ? (saved as CountdownUnit) : 'days';
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const ringCardRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<TurnstileWidgetId | null>(null);
  const toastSeqRef = useRef(0);
  const needsTurnstile = auth.deviceToken.length === 0;

  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const resolvedMode: 'light' | 'dark' =
    prefs.themeMode === 'system' ? (prefersDark ? 'dark' : 'light') : prefs.themeMode;

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: resolvedMode,
          primary: { main: '#ff7a18' },
          secondary: { main: '#15a7a1' },
          background:
            resolvedMode === 'dark'
              ? { default: '#11161c', paper: '#18212b' }
              : { default: '#fffaf3', paper: '#ffffff' },
        },
        shape: { borderRadius: 16 },
      }),
    [resolvedMode]
  );

  const timezoneGroups = useMemo(() => buildTimeZoneGroups([systemTimezone, timezone]), [systemTimezone, timezone]);
  const activeTimezoneRegion = useMemo(() => getTimeZoneRegion(timezone), [timezone]);
  const activeRegionTimezones = useMemo(
    () => timezoneGroups.find((group) => group.region === activeTimezoneRegion)?.zones ?? [timezone],
    [activeTimezoneRegion, timezone, timezoneGroups]
  );

  const zonedToday = useMemo(() => getZonedDateISO(timezone), [timezone]);
  const nextRestDate = useMemo(
    () =>
      findNextRestDate({
        startDate: zonedToday,
        scheduleRule,
        anchorDate,
        anchorWeekType,
      }),
    [anchorDate, anchorWeekType, scheduleRule, zonedToday]
  );
  const daysToNextRest = useMemo(() => dateDiffDays(zonedToday, nextRestDate), [nextRestDate, zonedToday]);
  const progressWindow = scheduleRule === 'big_small' ? 14 : 7;
  const restProgress = Math.max(0, Math.min(100, ((progressWindow - Math.min(daysToNextRest, progressWindow)) / progressWindow) * 100));
  const currentWeekType = useMemo(
    () => (scheduleRule === 'big_small' ? weekTypeForDate(anchorDate, anchorWeekType, zonedToday) : null),
    [anchorDate, anchorWeekType, scheduleRule, zonedToday]
  );

  useEffect(() => {
    if (countdownUnit === 'days') return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [countdownUnit]);

  const secsToNextRest = useMemo(() => {
    const now = new Date(nowMs);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const s = parseInt(parts.find((p) => p.type === 'second')?.value ?? '0');
    return Math.max(0, daysToNextRest * 86400 - (h * 3600 + m * 60 + s));
  }, [nowMs, timezone, daysToNextRest]);

  const { countdownDisplay, countdownLabel, countdownFontSize } = useMemo(() => {
    const h = Math.floor(secsToNextRest / 3600);
    const m = Math.floor((secsToNextRest % 3600) / 60);
    const s = secsToNextRest % 60;
    switch (countdownUnit) {
      case 'days':
        return { countdownDisplay: String(daysToNextRest), countdownLabel: '天', countdownFontSize: '3rem' };
      case 'hours':
        return { countdownDisplay: String(h), countdownLabel: '小时', countdownFontSize: '3rem' };
      case 'seconds':
        return { countdownDisplay: `${pad2(h)}:${pad2(m)}:${pad2(s)}`, countdownLabel: '', countdownFontSize: '1.75rem' };
    }
  }, [countdownUnit, daysToNextRest, secsToNextRest]);

  function handleRingMouseMove(e: MouseEvent<HTMLDivElement>) {
    const el = ringCardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const dy = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    setTilt({ x: dy * -10, y: dx * 10 });
  }

  function handleRingMouseLeave() {
    setTilt({ x: 0, y: 0 });
  }

  function cycleCountdownUnit() {
    setCountdownUnit((u) => {
      const idx = COUNTDOWN_UNITS.indexOf(u);
      const next = COUNTDOWN_UNITS[(idx + 1) % COUNTDOWN_UNITS.length];
      localStorage.setItem('gwa:countdownUnit', next);
      return next;
    });
  }

  const isWide = useMediaQuery('(min-width:768px)');
  const notificationOnline = Boolean(auth.deviceToken);
  const notificationEnabled =
    notificationOnline && notificationPermission === 'granted' && (weekendEnabled || workdayEnabled);

  const pushMessage = (text: string, type: 'success' | 'error') => {
    toastSeqRef.current += 1;
    setMessage({
      id: toastSeqRef.current,
      text,
      type,
    });
  };

  const onPrefChange = (next: Partial<typeof prefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    savePreferences(merged);
  };

  const onTemplateChange = (type: 1 | 2 | 3, field: 'titleTemplate' | 'bodyTemplate', value: string) => {
    const next = templates.map((tpl) => (tpl.type === type ? { ...tpl, [field]: value } : tpl));
    setTemplates(next);
    saveTemplates(next);
  };

  const onTogglePackEnabled = (id: string, enabled: boolean) => {
    const next = packs.map((pack) => (pack.id === id ? { ...pack, enabled } : pack));
    setPacks(next);
    saveLocalePacks(next);
  };

  const onChangeRegion = (region: string) => {
    const firstZone = timezoneGroups.find((group) => group.region === region)?.zones[0];
    if (firstZone) {
      setTimezone(firstZone);
    }
  };

  const onFlipBigSmallWeek = async () => {
    if (scheduleRule !== 'big_small' || !currentWeekType) return;

    const nextAnchorWeekType = anchorWeekType === 'big' ? 'small' : 'big';
    const nextCurrentWeekType = currentWeekType === 'big' ? 'small' : 'big';
    setAnchorWeekType(nextAnchorWeekType);

    if (!auth.deviceToken) {
      pushMessage(`已切换为本周${weekTypeName(nextCurrentWeekType)}（本地生效）`, 'success');
      return;
    }

    setBusy(true);
    try {
      await updateSubscription(auth.deviceToken, {
        timezone,
        weekendRemindTime: weekendTime,
        workdayRemindTime: workdayTime,
        scheduleRule,
        anchorDate,
        anchorWeekType: nextAnchorWeekType,
        weekendEnabled,
        workdayEnabled,
        enabledHolidaySources: [],
      });
      pushMessage(`已切换为本周${weekTypeName(nextCurrentWeekType)}，并同步通知配置`, 'success');
    } catch (err) {
      pushMessage(`已本地切换为本周${weekTypeName(nextCurrentWeekType)}，但同步失败: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    saveScheduleConfig({
      timezone,
      weekendRemindTime: weekendTime,
      workdayRemindTime: workdayTime,
      scheduleRule,
      anchorDate,
      anchorWeekType,
      weekendEnabled,
      workdayEnabled,
    });
  }, [anchorDate, anchorWeekType, scheduleRule, timezone, weekendEnabled, weekendTime, workdayEnabled, workdayTime]);

  useEffect(() => {
    if (typeof Notification === 'undefined') {
      return;
    }

    const refresh = () => {
      setNotificationPermission(Notification.permission);
    };

    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => {
    if (!auth.deviceToken || !navigator.onLine) return;

    let alive = true;
    void getSubscription(auth.deviceToken)
      .then((item) => {
        if (!alive) return;
        if (!item.active) {
          // Cloud has disabled this subscription (repeated push failures)
          setCloudDisabled(true);
          return;
        }
        setCloudDisabled(false);
        setTimezone(item.timezone);
        setWeekendTime(item.weekend_remind_time);
        setWorkdayTime(item.workday_remind_time);
        setScheduleRule(item.schedule_rule);
        setWeekendEnabled(item.weekend_enabled);
        setWorkdayEnabled(item.workday_enabled);
        if (item.week_pattern_anchor) {
          setAnchorDate(item.week_pattern_anchor.anchor_date);
          setAnchorWeekType(item.week_pattern_anchor.anchor_week_type);
        }
      })
      .catch((err: Error) => {
        if (!alive) return;
        if (err.message === 'subscription_not_found') {
          // 404: subscription no longer exists on the server, clear local token silently
          const nextAuth = { ...auth, deviceToken: '' };
          setAuth(nextAuth);
          saveAuthState(nextAuth);
        }
        // Other errors (network, server): ignore silently, keep local state as-is
      });

    return () => {
      alive = false;
    };
  }, [auth.deviceToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (timezone !== systemTimezone) {
      setTimezoneMismatch(systemTimezone);
      return;
    }
    setTimezoneMismatch(null);
  }, [timezone, systemTimezone]);

  useEffect(() => {
    void syncNotificationConfigToServiceWorker({
      locale: prefs.locale,
      templates,
      importedNotificationPacks: packs
        .filter((pack) => pack.enabled && pack.pack_type === 'notification')
        .map((pack) => ({
          id: pack.id,
          locale: pack.locale,
          title: pack.title,
          payload: pack.payload,
        })),
    });
  }, [packs, prefs.locale, templates]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => {
      setMessage((current) => (current?.id === message.id ? null : current));
    }, 3200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [message]);

  useEffect(() => {
    if (!needsTurnstile) {
      setTurnstileToken('');
      setTurnstileError(null);
      if (window.turnstile && turnstileWidgetIdRef.current !== null && typeof window.turnstile.remove === 'function') {
        window.turnstile.remove(turnstileWidgetIdRef.current);
      }
      turnstileWidgetIdRef.current = null;
      return;
    }

    if (!turnstileSiteKey) {
      if (isLocalDevHost) {
        setTurnstileToken('dev-bypass');
        setTurnstileError(null);
      } else {
        setTurnstileToken('');
        setTurnstileError('未配置 Turnstile Site Key，无法开启通知。');
      }
      return;
    }

    let active = true;
    setTurnstileToken('');
    setTurnstileError(null);

    void loadTurnstileScript()
      .then(() => {
        if (!active) return;
        if (!window.turnstile || !turnstileContainerRef.current) {
          throw new Error('turnstile_not_ready');
        }

        turnstileContainerRef.current.innerHTML = '';
        turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
          sitekey: turnstileSiteKey,
          theme: resolvedMode,
          language: prefs.locale,
          action: 'register_subscription',
          callback: (token) => {
            if (!active) return;
            setTurnstileToken(token);
            setTurnstileError(null);
          },
          'expired-callback': () => {
            if (!active) return;
            setTurnstileToken('');
          },
          'error-callback': () => {
            if (!active) return;
            setTurnstileToken('');
            setTurnstileError('Turnstile 验证失败，请刷新后重试。');
          },
        });
      })
      .catch(() => {
        if (!active) return;
        setTurnstileError('Turnstile 组件加载失败，请检查网络或站点配置。');
      });

    return () => {
      active = false;
      if (window.turnstile && turnstileWidgetIdRef.current !== null && typeof window.turnstile.remove === 'function') {
        window.turnstile.remove(turnstileWidgetIdRef.current);
      }
      turnstileWidgetIdRef.current = null;
    };
  }, [isLocalDevHost, needsTurnstile, prefs.locale, resolvedMode, turnstileSiteKey]);

  const onReEnable = () => {
    setCloudDisabled(false);
    const nextAuth = { ...auth, deviceToken: '' };
    setAuth(nextAuth);
    saveAuthState(nextAuth);
  };

  const onRegister = async () => {
    if (!turnstileToken) {
      pushMessage('请先完成人机验证', 'error');
      return;
    }

    setBusy(true);
    try {
      if (typeof Notification === 'undefined') {
        throw new Error('浏览器不支持通知');
      }

      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission !== 'granted') {
        throw new Error('notification_permission_denied');
      }

      const registration = await navigator.serviceWorker.ready;
      const { vapid_public_key } = await fetchConfig();
      if (!vapid_public_key) throw new Error('vapid_key_unavailable');
      const browserSub =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64ToArrayBuffer(vapid_public_key),
        }));
      const json = browserSub.toJSON();

      const newClientId = crypto.randomUUID();
      const response = await registerSubscription({
        clientId: newClientId,
        turnstileToken,
        endpoint: json.endpoint || '',
        p256dh: json.keys?.p256dh || '',
        auth: json.keys?.auth || '',
        timezone,
        weekendRemindTime: weekendTime,
        workdayRemindTime: workdayTime,
        scheduleRule,
        anchorDate,
        anchorWeekType,
        enabledHolidaySources: [],
      });

      const nextAuth = { clientId: newClientId, deviceToken: response.device_token };
      setAuth(nextAuth);
      saveAuthState(nextAuth);
      pushMessage('通知开启成功', 'success');
    } catch (err) {
      pushMessage(`开启失败: ${(err as Error).message}`, 'error');
    } finally {
      if (turnstileSiteKey && window.turnstile && turnstileWidgetIdRef.current !== null) {
        window.turnstile.reset(turnstileWidgetIdRef.current);
        setTurnstileToken('');
      }
      setBusy(false);
    }
  };

  const onUpdate = async () => {
    if (!auth.deviceToken) {
      pushMessage('请先开启通知', 'error');
      return;
    }
    setBusy(true);
    try {
      await updateSubscription(auth.deviceToken, {
        timezone,
        weekendRemindTime: weekendTime,
        workdayRemindTime: workdayTime,
        scheduleRule,
        anchorDate,
        anchorWeekType,
        weekendEnabled,
        workdayEnabled,
        enabledHolidaySources: [],
      });
      pushMessage('通知配置已同步', 'success');
    } catch (err) {
      pushMessage(`同步失败: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onUnregister = async () => {
    if (!auth.deviceToken) return;
    setBusy(true);
    try {
      await deleteSubscription(auth.deviceToken);
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
      }
      const nextAuth = { ...auth, deviceToken: '' };
      setAuth(nextAuth);
      saveAuthState(nextAuth);
      setExtensions([]);
      pushMessage('通知已关闭，已切回本地模式', 'success');
    } catch (err) {
      pushMessage(`关闭失败: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onLoadExtensions = async () => {
    if (!auth.deviceToken) {
      pushMessage('请先开启通知', 'error');
      return;
    }
    try {
      const rows = await listExtensions(auth.deviceToken);
      setExtensions(rows);
    } catch (err) {
      pushMessage(`获取延长区间失败: ${(err as Error).message}`, 'error');
    }
  };

  const onCreateExtension = async () => {
    if (!auth.deviceToken) {
      pushMessage('请先开启通知', 'error');
      return;
    }
    const days = dateDiffDays(extensionStart, extensionEnd) + 1;
    if (days < 1) {
      pushMessage('日期范围无效', 'error');
      return;
    }
    if (days > 90) {
      pushMessage('单次延长最多 90 天，建议改为停用提醒', 'error');
      return;
    }

    try {
      await createExtension(auth.deviceToken, {
        scope: extensionScope,
        startDate: extensionStart,
        endDate: extensionEnd,
      });
      await onLoadExtensions();
      pushMessage('延长区间创建成功', 'success');
    } catch (err) {
      pushMessage(`创建失败: ${(err as Error).message}`, 'error');
    }
  };

  const onDeleteExtension = async (id: string) => {
    if (!auth.deviceToken) return;
    try {
      await removeExtension(auth.deviceToken, id);
      await onLoadExtensions();
      pushMessage('延长区间已删除', 'success');
    } catch (err) {
      pushMessage(`删除失败: ${(err as Error).message}`, 'error');
    }
  };

  const onImportPack = async (file?: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        pack_type: 'ui' | 'notification';
        locale: string;
        title: string;
        payload: Record<string, unknown>;
      };

      if (!parsed.pack_type || !parsed.locale || !parsed.title || typeof parsed.payload !== 'object') {
        throw new Error('语言包格式不正确');
      }

      const next = [
        {
          id: crypto.randomUUID(),
          pack_type: parsed.pack_type,
          locale: parsed.locale,
          title: parsed.title,
          source: 'file_import' as const,
          enabled: true,
          payload: parsed.payload,
          installed_at: new Date().toISOString(),
        },
        ...packs,
      ];

      setPacks(next);
      saveLocalePacks(next);
      pushMessage('已导入语言包（第三方来源）', 'success');
    } catch (err) {
      pushMessage(`导入失败: ${(err as Error).message}`, 'error');
    }
  };

  const handleSwipeStart = (evt: TouchEvent<HTMLDivElement>) => {
    setTouchStartX(evt.changedTouches[0].screenX);
  };

  const handleSwipeEnd = (evt: TouchEvent<HTMLDivElement>) => {
    if (touchStartX === null) return;
    const delta = evt.changedTouches[0].screenX - touchStartX;
    if (delta > 50) onPrefChange({ dashboardView: 'ring' });
    if (delta < -50) onPrefChange({ dashboardView: 'calendar' });
    setTouchStartX(null);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="static" color="default" elevation={1}>
        <Container maxWidth="lg">
          <Box sx={{ py: 1.5 }}>
            <Typography variant="h6" fontWeight={700}>
              Weekend Alarm
            </Typography>
            <Typography variant="body2" color="text.secondary">
              简单设置，轻松提醒
            </Typography>
          </Box>
        </Container>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant={isWide ? 'standard' : 'fullWidth'}>
          <Tab label="首页" />
          <Tab label="设置" />
          <Tab label="延长" />
        </Tabs>

        {cloudDisabled && auth.deviceToken && (
          <Alert
            severity="warning"
            sx={{ mt: 2 }}
            action={
              <Button color="inherit" size="small" onClick={onReEnable}>
                重新开启
              </Button>
            }
          >
            推送已被停用（连续推送失败），请重新开启通知以恢复提醒。
          </Alert>
        )}

        <Box sx={{ mt: 2, display: tab === 0 ? 'block' : 'none' }} onTouchStart={handleSwipeStart} onTouchEnd={handleSwipeEnd}>
          <Card sx={{ mb: 2 }}>
            <CardContent>
              <Typography variant="h6">本周节奏</Typography>
              <Typography variant="body2" color="text.secondary">
                模式：{notificationOnline ? '通知已连接（本地也保留副本）' : '本地模式（未开启通知）'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                当前时区：{timezone} · 规则：{scheduleRuleName(scheduleRule)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                周末/调休提醒：{weekendTime} / 工作日提醒：{workdayTime}
              </Typography>
              {currentWeekType && (
                <Stack direction={isWide ? 'row' : 'column'} spacing={1} sx={{ mt: 0.5 }} alignItems={isWide ? 'center' : 'stretch'}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }} color="primary.main">
                    {bigSmallWeekTagline(currentWeekType)}
                  </Typography>
                  <Button size="small" variant="outlined" onClick={onFlipBigSmallWeek} disabled={busy}>
                    顺序不对？切到{weekTypeName(currentWeekType === 'big' ? 'small' : 'big')}
                  </Button>
                </Stack>
              )}
            </CardContent>
          </Card>

          <Tabs
            value={prefs.dashboardView}
            onChange={(_, v: DashboardView) => onPrefChange({ dashboardView: v })}
            variant="fullWidth"
          >
            <Tab value="ring" label="倒计时" />
            <Tab value="calendar" label="日历" />
          </Tabs>

          {prefs.dashboardView === 'ring' ? (
            <Card sx={{ mt: 2 }}>
              <CardContent sx={{ textAlign: 'center', p: { xs: 2.5, sm: 3 } }}>
                <Box
                  sx={{
                    borderRadius: 5,
                    p: { xs: 2, sm: 2.5 },
                    background:
                      resolvedMode === 'dark'
                        ? 'linear-gradient(160deg, rgba(255,122,24,0.22), rgba(21,167,161,0.2))'
                        : 'linear-gradient(160deg, rgba(255,122,24,0.14), rgba(21,167,161,0.12))',
                  }}
                >
                  <Typography variant="h6">距离下一休息日</Typography>
                  <Box sx={{ my: 2, display: 'flex', justifyContent: 'center' }}>
                    <Box
                      data-testid="countdown-ring"
                      ref={ringCardRef}
                      onMouseMove={handleRingMouseMove}
                      onMouseLeave={handleRingMouseLeave}
                      onClick={cycleCountdownUnit}
                      sx={{
                        position: 'relative',
                        display: 'inline-flex',
                        p: 1,
                        borderRadius: '50%',
                        bgcolor: 'background.paper',
                        cursor: 'pointer',
                        transformStyle: 'preserve-3d',
                        transform: `perspective(700px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
                        transition: tilt.x === 0 && tilt.y === 0
                          ? 'transform 0.45s cubic-bezier(0.22,1,0.36,1), box-shadow 0.45s ease'
                          : 'transform 0.08s linear, box-shadow 0.08s linear',
                        willChange: 'transform',
                        boxShadow: tilt.x === 0 && tilt.y === 0
                          ? '0 12px 24px rgba(0,0,0,0.12)'
                          : '0 20px 40px rgba(0,0,0,0.22)',
                      }}
                    >
                      <CircularProgress
                        size={180}
                        thickness={4}
                        variant="determinate"
                        value={100}
                        sx={{
                          color: resolvedMode === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)',
                          '& .MuiCircularProgress-circle': { strokeLinecap: 'round' },
                        }}
                      />
                      <CircularProgress
                        size={180}
                        thickness={4}
                        variant="determinate"
                        value={restProgress}
                        sx={{
                          top: 8,
                          left: 8,
                          position: 'absolute',
                          color: 'primary.main',
                          '& .MuiCircularProgress-circle': { strokeLinecap: 'round' },
                        }}
                      />
                      <Box
                        sx={{
                          top: 0,
                          left: 0,
                          bottom: 0,
                          right: 0,
                          position: 'absolute',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexDirection: 'column',
                        }}
                      >
                        <Typography
                          fontWeight={700}
                          sx={{ fontSize: countdownFontSize, transition: 'font-size 0.2s ease', lineHeight: 1.1, letterSpacing: countdownUnit === 'seconds' ? '-0.02em' : 'normal' }}
                        >
                          {countdownDisplay}
                        </Typography>
                        {countdownLabel && (
                          <Typography variant="body2" color="text.secondary">
                            {countdownLabel}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    下一个休息日：{formatDateLabel(nextRestDate, prefs.calendarDateFormat)}
                  </Typography>
                  <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
                    点击切换精度
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          ) : (
            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  本月日历
                </Typography>
                <CalendarView
                  monthDate={zonedToday}
                  todayDate={zonedToday}
                  nextRestDate={nextRestDate}
                  scheduleRule={scheduleRule}
                  anchorDate={anchorDate}
                  anchorWeekType={anchorWeekType}
                  weekStart={prefs.calendarWeekStart}
                  dateFormat={prefs.calendarDateFormat}
                />
              </CardContent>
            </Card>
          )}
        </Box>

        <Box sx={{ mt: 2, display: tab === 1 ? 'block' : 'none' }}>
          <Stack spacing={2}>
            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  通知
                </Typography>
                <Stack spacing={2}>
                  {!notificationOnline ? (
                    <Alert severity="info">
                      当前未开启通知。应用将仅使用本地配置运行（日历/倒计时可用），不会写入服务端。
                    </Alert>
                  ) : notificationEnabled ? (
                    <Alert severity="success">通知已开启，服务端将按当前配置推送；本地会同步保留一份配置。</Alert>
                  ) : (
                    <Alert severity="warning">
                      通知已注册，但当前未形成有效提醒（请检查浏览器权限或提醒开关）。
                    </Alert>
                  )}

                  <Typography variant="body2" color="text.secondary">
                    浏览器通知权限：{permissionName(notificationPermission)}
                  </Typography>

                  <Stack direction={isWide ? 'row' : 'column'} spacing={2}>
                    <FormControlLabel
                      control={<Switch checked={weekendEnabled} onChange={(e) => setWeekendEnabled(e.target.checked)} />}
                      label="启用周末/调休提醒"
                    />
                    <FormControlLabel
                      control={<Switch checked={workdayEnabled} onChange={(e) => setWorkdayEnabled(e.target.checked)} />}
                      label="启用工作日提醒"
                    />
                  </Stack>

                  <Stack direction={isWide ? 'row' : 'column'} spacing={2}>
                    <TimeSelectField label="周末/调休提醒时间" value={weekendTime} onChange={setWeekendTime} />
                    <TimeSelectField label="工作日提醒时间" value={workdayTime} onChange={setWorkdayTime} />
                  </Stack>

                  {needsTurnstile && (
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Turnstile 人机验证
                      </Typography>
                      {turnstileSiteKey ? (
                        <Box
                          ref={turnstileContainerRef}
                          sx={{
                            minHeight: 68,
                            display: 'flex',
                            alignItems: 'center',
                          }}
                        />
                      ) : (
                        <Alert severity={isLocalDevHost ? 'info' : 'error'}>
                          {isLocalDevHost
                            ? '本地开发模式：未配置 Turnstile Site Key，已启用开发 bypass。'
                            : '缺少 Turnstile Site Key，当前环境无法完成注册。'}
                        </Alert>
                      )}
                      {turnstileToken && (
                        <Typography variant="caption" color="success.main" sx={{ display: 'block', mt: 0.5 }}>
                          验证已通过
                        </Typography>
                      )}
                      {turnstileError && (
                        <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 0.5 }}>
                          {turnstileError}
                        </Typography>
                      )}
                    </Box>
                  )}

                  <Stack direction={isWide ? 'row' : 'column'} spacing={1}>
                    {needsTurnstile ? (
                      <Button disabled={busy || !turnstileToken} variant="contained" onClick={onRegister}>
                        开启通知
                      </Button>
                    ) : (
                      <>
                        <Button disabled={busy || !auth.deviceToken} variant="outlined" onClick={onUpdate}>
                          同步通知配置
                        </Button>
                        <Button disabled={busy || !auth.deviceToken} color="error" variant="text" onClick={onUnregister}>
                          关闭通知
                        </Button>
                      </>
                    )}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  排班规则与本地计算
                </Typography>
                <Stack spacing={2}>
                  {timezoneMismatch && (
                    <Alert
                      severity="warning"
                      action={
                        <Button color="inherit" size="small" onClick={() => setTimezone(systemTimezone)}>
                          使用系统时区
                        </Button>
                      }
                    >
                      检测到系统时区为 {systemTimezone}，当前配置为 {timezone}
                    </Alert>
                  )}

                  <Stack direction={isWide ? 'row' : 'column'} spacing={2}>
                    <FormControl fullWidth>
                      <InputLabel>时区区域</InputLabel>
                      <Select
                        value={activeTimezoneRegion}
                        label="时区区域"
                        onChange={(e) => onChangeRegion(e.target.value)}
                      >
                        {timezoneGroups.map((group) => (
                          <MenuItem key={group.region} value={group.region}>
                            {group.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl fullWidth>
                      <InputLabel>时区</InputLabel>
                      <Select value={timezone} label="时区" onChange={(e) => setTimezone(e.target.value)}>
                        {activeRegionTimezones.map((zone) => (
                          <MenuItem key={zone} value={zone}>
                            {formatTimeZoneLabel(zone)}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Stack>

                  <FormControl fullWidth>
                    <InputLabel>排班规则</InputLabel>
                    <Select
                      value={scheduleRule}
                      label="排班规则"
                      onChange={(e) => setScheduleRule(e.target.value as ScheduleRule)}
                    >
                      <MenuItem value="big_small">大小周</MenuItem>
                      <MenuItem value="double_rest">双休</MenuItem>
                      <MenuItem value="single_rest">单休</MenuItem>
                    </Select>
                  </FormControl>

                  {scheduleRule === 'big_small' && (
                    <Stack direction={isWide ? 'row' : 'column'} spacing={2}>
                      <TextField
                        label="锚点日期"
                        type="date"
                        value={anchorDate}
                        onChange={(e) => setAnchorDate(e.target.value)}
                        InputLabelProps={{ shrink: true }}
                        fullWidth
                      />

                      <FormControl fullWidth>
                        <InputLabel>锚点周类型</InputLabel>
                        <Select
                          value={anchorWeekType}
                          label="锚点周类型"
                          onChange={(e) => setAnchorWeekType(e.target.value as 'big' | 'small')}
                        >
                          <MenuItem value="big">大周</MenuItem>
                          <MenuItem value="small">小周</MenuItem>
                        </Select>
                      </FormControl>
                    </Stack>
                  )}

                  <Stack direction={isWide ? 'row' : 'column'} spacing={2}>
                    <FormControl fullWidth>
                      <InputLabel>周起始日</InputLabel>
                      <Select
                        value={prefs.calendarWeekStart}
                        label="周起始日"
                        onChange={(e) => onPrefChange({ calendarWeekStart: e.target.value as CalendarWeekStart })}
                      >
                        <MenuItem value="sunday">星期日</MenuItem>
                        <MenuItem value="monday">星期一</MenuItem>
                      </Select>
                    </FormControl>

                    <FormControl fullWidth>
                      <InputLabel>日期格式</InputLabel>
                      <Select
                        value={prefs.calendarDateFormat}
                        label="日期格式"
                        onChange={(e) => onPrefChange({ calendarDateFormat: e.target.value as CalendarDateFormat })}
                      >
                        <MenuItem value="yyyy_mm_dd">YYYY-MM-DD</MenuItem>
                        <MenuItem value="mm_dd">MM/DD</MenuItem>
                        <MenuItem value="dd_mm">DD/MM</MenuItem>
                      </Select>
                    </FormControl>
                  </Stack>

                  <Typography variant="caption" color="text.secondary">
                    当前配置始终保存在本地；开启通知后可手动同步到服务端。
                  </Typography>
                </Stack>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  语言与主题（本地）
                </Typography>
                <Stack spacing={2}>
                  <FormControl fullWidth>
                    <InputLabel>界面语言</InputLabel>
                    <Select
                      value={prefs.locale}
                      label="界面语言"
                      onChange={(e) => onPrefChange({ locale: e.target.value as (typeof LOCALES)[number] })}
                    >
                      {LOCALES.map((locale) => (
                        <MenuItem key={locale} value={locale}>
                          {locale}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>

                  <FormControl fullWidth>
                    <InputLabel>主题模式</InputLabel>
                    <Select
                      value={prefs.themeMode}
                      label="主题模式"
                      onChange={(e) => onPrefChange({ themeMode: e.target.value as ThemeMode })}
                    >
                      <MenuItem value="system">跟随系统</MenuItem>
                      <MenuItem value="light">浅色</MenuItem>
                      <MenuItem value="dark">深色</MenuItem>
                    </Select>
                  </FormControl>

                  <Box>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>
                      导入第三方语言包（JSON）
                    </Typography>
                    <Button component="label" variant="outlined">
                      选择文件并导入
                      <input
                        hidden
                        type="file"
                        accept="application/json"
                        onChange={(e) => onImportPack(e.target.files?.[0])}
                      />
                    </Button>
                    <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1 }}>
                      警告：第三方语言包未经官方验证，请自行判断风险。
                    </Typography>
                  </Box>

                  <Stack spacing={1}>
                    {packs.map((pack) => (
                      <Card key={pack.id} variant="outlined">
                        <CardContent
                          sx={{
                            py: 1.5,
                            '&:last-child': { pb: 1.5 },
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 1,
                          }}
                        >
                          <Box>
                            <Typography variant="body2" fontWeight={600}>
                              {pack.title}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {pack.pack_type.toUpperCase()} / {pack.locale} / {pack.source}
                            </Typography>
                          </Box>
                          <FormControlLabel
                            control={<Switch checked={pack.enabled} onChange={(e) => onTogglePackEnabled(pack.id, e.target.checked)} />}
                            label={pack.enabled ? '启用' : '停用'}
                            sx={{ mr: 0 }}
                          />
                        </CardContent>
                      </Card>
                    ))}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  通知模板 DIY（仅本地）
                </Typography>
                <Stack spacing={2}>
                  {templates.map((tpl) => (
                    <Card key={tpl.type} variant="outlined">
                      <CardContent>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>
                          {templateTypeName(tpl.type)}
                        </Typography>
                        <Stack spacing={1.5}>
                          <TextField
                            size="small"
                            label="标题模板"
                            value={tpl.titleTemplate}
                            onChange={(e) => onTemplateChange(tpl.type, 'titleTemplate', e.target.value)}
                          />
                          <TextField
                            size="small"
                            label="正文模板"
                            value={tpl.bodyTemplate}
                            onChange={(e) => onTemplateChange(tpl.type, 'bodyTemplate', e.target.value)}
                          />
                        </Stack>
                      </CardContent>
                    </Card>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Stack>
        </Box>

        <Box sx={{ mt: 2, display: tab === 2 ? 'block' : 'none' }}>
          {!auth.deviceToken ? (
            <Card>
              <CardContent>
                <Alert severity="info">当前处于本地模式。延长区间仅对服务端通知生效，请先在“通知”板块开启通知。</Alert>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  提醒延长（仅天粒度，最多 90 天）
                </Typography>
                <Stack spacing={2}>
                  <FormControl fullWidth>
                    <InputLabel>延长类型</InputLabel>
                    <Select
                      value={extensionScope}
                      label="延长类型"
                      onChange={(e) => setExtensionScope(e.target.value as ExtensionScope)}
                    >
                      <MenuItem value="holiday">假期延长</MenuItem>
                      <MenuItem value="adjustment">调休延长</MenuItem>
                      <MenuItem value="workday">工作日延长</MenuItem>
                    </Select>
                  </FormControl>

                  <Stack direction={isWide ? 'row' : 'column'} spacing={2}>
                    <TextField
                      type="date"
                      label="开始日期"
                      value={extensionStart}
                      onChange={(e) => setExtensionStart(e.target.value)}
                      InputLabelProps={{ shrink: true }}
                      fullWidth
                    />
                    <TextField
                      type="date"
                      label="结束日期"
                      value={extensionEnd}
                      onChange={(e) => setExtensionEnd(e.target.value)}
                      InputLabelProps={{ shrink: true }}
                      fullWidth
                    />
                  </Stack>

                  <Stack direction={isWide ? 'row' : 'column'} spacing={1}>
                    <Button variant="contained" onClick={onCreateExtension}>
                      新增延长区间
                    </Button>
                    <Button variant="outlined" onClick={onLoadExtensions}>
                      刷新列表
                    </Button>
                  </Stack>

                  <Stack spacing={1}>
                    {extensions.map((item) => (
                      <Card key={item.id} variant="outlined">
                        <CardContent sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                          <Box>
                            <Typography variant="body2" fontWeight={600}>
                              {scopeName(item.scope)}: {item.start_date} ~ {item.end_date}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              状态: {item.status === 1 ? '生效中' : '已停用'}
                            </Typography>
                          </Box>
                          <Button color="error" onClick={() => onDeleteExtension(item.id)}>
                            删除
                          </Button>
                        </CardContent>
                      </Card>
                    ))}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          )}
        </Box>
      </Container>

      <Snackbar
        key={message?.id ?? 'toast-empty'}
        open={Boolean(message)}
        autoHideDuration={3000}
        onClose={() => setMessage(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        {message ? <Alert severity={message.type} onClose={() => setMessage(null)}>{message.text}</Alert> : <span />}
      </Snackbar>
    </ThemeProvider>
  );
}

function TimeSelectField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const parsed = parseTimeValue(value);

  return (
    <Box
      sx={{
        flex: 1,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        p: 1.5,
        bgcolor: 'action.hover',
      }}
    >
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <FormControl size="small" sx={{ minWidth: 96 }}>
          <InputLabel>时</InputLabel>
          <Select
            label="时"
            value={parsed.hour}
            onChange={(e) => onChange(`${e.target.value}:${parsed.minute}`)}
          >
            {HOURS.map((hour) => (
              <MenuItem key={hour} value={hour}>
                {hour}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Typography variant="h6" color="text.secondary">
          :
        </Typography>
        <FormControl size="small" sx={{ minWidth: 96 }}>
          <InputLabel>分</InputLabel>
          <Select
            label="分"
            value={parsed.minute}
            onChange={(e) => onChange(`${parsed.hour}:${e.target.value}`)}
          >
            {MINUTES.map((minute) => (
              <MenuItem key={minute} value={minute}>
                {minute}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>
    </Box>
  );
}

function CalendarView({
  monthDate,
  todayDate,
  nextRestDate,
  scheduleRule,
  anchorDate,
  anchorWeekType,
  weekStart,
  dateFormat,
}: {
  monthDate: string;
  todayDate: string;
  nextRestDate: string;
  scheduleRule: ScheduleRule;
  anchorDate: string;
  anchorWeekType: 'big' | 'small';
  weekStart: CalendarWeekStart;
  dateFormat: CalendarDateFormat;
}) {
  const ITEM_HEIGHT = 52;
  const isCompact = useMediaQuery('(max-width:600px)');
  const VIEWPORT_HEIGHT = isCompact ? 336 : 388;
  const TOTAL_ROWS = 801;
  const MID_INDEX = Math.floor(TOTAL_ROWS / 2);
  const RECENTER_EDGE = 140;
  const baseWeekStart = useMemo(() => startOfWeekBySetting(monthDate, weekStart), [monthDate, weekStart]);
  const currentWeekStart = useMemo(() => startOfWeekBySetting(todayDate, weekStart), [todayDate, weekStart]);
  const weekLabels = weekStart === 'monday' ? ['一', '二', '三', '四', '五', '六', '日'] : ['日', '一', '二', '三', '四', '五', '六'];

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [windowStartOffset, setWindowStartOffset] = useState(-MID_INDEX);
  const [scrollTop, setScrollTop] = useState(MID_INDEX * ITEM_HEIGHT);
  const windowStartOffsetRef = useRef(-MID_INDEX);

  const handleScrollerRef = (node: HTMLDivElement | null) => {
    if (!node) return;
    scrollerRef.current = node;
    if (node.dataset.baseWeekStart !== baseWeekStart) {
      node.scrollTop = MID_INDEX * ITEM_HEIGHT;
      node.dataset.baseWeekStart = baseWeekStart;
      windowStartOffsetRef.current = -MID_INDEX;
      setWindowStartOffset(-MID_INDEX);
      setScrollTop(MID_INDEX * ITEM_HEIGHT);
    }
  };

  const onScrollCalendar = (evt: UIEvent<HTMLDivElement>) => {
    const node = evt.currentTarget;
    let nextTop = node.scrollTop;
    const topIndex = Math.floor(nextTop / ITEM_HEIGHT);
    let nextWindowStart = windowStartOffsetRef.current;

    if (topIndex < RECENTER_EDGE || topIndex > TOTAL_ROWS - RECENTER_EDGE) {
      const shiftRows = MID_INDEX - topIndex;
      nextWindowStart -= shiftRows;
      nextTop += shiftRows * ITEM_HEIGHT;
      node.scrollTop = nextTop;
      windowStartOffsetRef.current = nextWindowStart;
      setWindowStartOffset(nextWindowStart);
    }

    setScrollTop(nextTop);
  };

  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ITEM_HEIGHT) + 4;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 1);
  const endIndex = Math.min(TOTAL_ROWS, startIndex + visibleCount);
  const visibleIndices = Array.from({ length: endIndex - startIndex }, (_, idx) => startIndex + idx);
  const activeIndex = Math.max(
    0,
    Math.min(TOTAL_ROWS - 1, Math.floor((scrollTop + VIEWPORT_HEIGHT / 2) / ITEM_HEIGHT))
  );
  const activeWeekStart = addDaysISO(baseWeekStart, (windowStartOffset + activeIndex) * 7);
  const activeMonthKey = addDaysISO(activeWeekStart, 3).slice(0, 7);
  const currentWeekOffset = useMemo(() => weekDiffBetween(baseWeekStart, currentWeekStart), [baseWeekStart, currentWeekStart]);
  const isCurrentWeekCentered = activeWeekStart === currentWeekStart;

  const centerRowScrollTop = (rowIndex: number): number =>
    Math.max(0, rowIndex * ITEM_HEIGHT - (VIEWPORT_HEIGHT / 2 - ITEM_HEIGHT / 2));

  const onScrollToCurrentWeek = () => {
    const node = scrollerRef.current;
    if (!node) return;

    const currentOffset = windowStartOffsetRef.current;
    const currentWeekRowIndex = currentWeekOffset - currentOffset;

    if (currentWeekRowIndex < 0 || currentWeekRowIndex >= TOTAL_ROWS) {
      windowStartOffsetRef.current = -MID_INDEX;
      setWindowStartOffset(-MID_INDEX);
      setScrollTop(centerRowScrollTop(MID_INDEX));
      node.scrollTop = centerRowScrollTop(MID_INDEX);
      return;
    }

    node.scrollTo({
      top: centerRowScrollTop(currentWeekRowIndex),
      behavior: 'smooth',
    });
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1, px: 0.5, gap: 1 }}>
        <Typography variant="subtitle1" fontWeight={700}>
          {formatMonthTitle(activeMonthKey)}
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {!isCurrentWeekCentered && (
            <Button size="small" variant="text" onClick={onScrollToCurrentWeek}>
              回到本周
            </Button>
          )}
          <Typography variant="caption" color="text.secondary">
            {dateFormatLabel(dateFormat)}
          </Typography>
        </Stack>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 0.75,
          px: 1,
          pb: 0.75,
        }}
      >
        {weekLabels.map((w) => (
          <Typography key={`weekday-${w}`} align="center" variant="caption" color="text.secondary">
            {w}
          </Typography>
        ))}
      </Box>

      <Box
        ref={handleScrollerRef}
        onScroll={onScrollCalendar}
        sx={{
          height: VIEWPORT_HEIGHT,
          overflowY: 'auto',
          px: 0.75,
          py: 0.75,
          borderRadius: 2.5,
          border: '1px solid',
          borderColor: 'divider',
          overflowX: 'hidden',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
        <Box sx={{ position: 'relative', height: TOTAL_ROWS * ITEM_HEIGHT }}>
          {visibleIndices.map((rowIndex) => {
            const top = rowIndex * ITEM_HEIGHT;
            const weekStartDate = addDaysISO(baseWeekStart, (windowStartOffset + rowIndex) * 7);
            const weekDates = Array.from({ length: 7 }, (_, dayIndex) => addDaysISO(weekStartDate, dayIndex));
            return (
              <Box
                key={`${weekStartDate}-${rowIndex}`}
                sx={{
                  position: 'absolute',
                  top,
                  left: 0,
                  right: 0,
                  px: 0.25,
                  py: 0.5,
                }}
              >
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(7, 1fr)',
                    gap: 0.75,
                  }}
                >
                  {weekDates.map((date) => {
                    const isRest = isRestDayByRule({
                      scheduleRule,
                      anchorDate,
                      anchorWeekType,
                      date,
                    });
                    const isToday = date === todayDate;
                    const isNext = date === nextRestDate;
                    const isCurrentMonth = date.slice(0, 7) === activeMonthKey;

                    return (
                      <Box
                        key={date}
                        sx={{
                          height: 40,
                          borderRadius: 999,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          bgcolor: isNext ? 'primary.main' : isRest ? 'action.hover' : 'background.paper',
                          color: isNext ? 'primary.contrastText' : isCurrentMonth ? 'text.primary' : 'text.disabled',
                          border: '1px solid',
                          borderColor: isToday ? 'secondary.main' : 'divider',
                          opacity: isCurrentMonth ? 1 : 0.45,
                          transition:
                            'background-color 220ms ease, color 220ms ease, border-color 220ms ease, opacity 220ms ease',
                          willChange: 'background-color, color, opacity, border-color',
                        }}
                      >
                        <Typography variant="body2" fontWeight={isToday || isNext ? 700 : 500}>
                          {Number.parseInt(date.slice(8, 10), 10)}
                        </Typography>
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        日期格式：{dateFormatLabel(dateFormat)} · 下一休息日：{formatDateLabel(nextRestDate, dateFormat)}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        高亮说明：橙色=下一休息日，灰底=休息日，青色边框=今天，非本月日期已暗化
      </Typography>
    </Box>
  );
}

function scopeName(scope: number): string {
  if (scope === 1) return '假期延长';
  if (scope === 2) return '调休延长';
  return '工作日延长';
}

function templateTypeName(type: 1 | 2 | 3): string {
  if (type === 1) return '周末提醒模板';
  if (type === 2) return '调休提醒模板';
  return '工作日提醒模板';
}

function weekTypeName(weekType: 'big' | 'small'): string {
  return weekType === 'big' ? '大周' : '小周';
}

function bigSmallWeekTagline(weekType: 'big' | 'small'): string {
  if (weekType === 'big') {
    return '这周是大周，火力全开也记得准点收工。';
  }
  return '这周是小周，节奏放轻一点，把时间留给生活。';
}

function permissionName(value: NotificationPermission): string {
  if (value === 'granted') return '已允许';
  if (value === 'denied') return '已拒绝';
  return '未选择';
}

function scheduleRuleName(rule: ScheduleRule): string {
  if (rule === 'big_small') return '大小周';
  if (rule === 'double_rest') return '双休';
  return '单休';
}

function dateFormatLabel(format: CalendarDateFormat): string {
  if (format === 'yyyy_mm_dd') return 'YYYY-MM-DD';
  if (format === 'mm_dd') return 'MM/DD';
  return 'DD/MM';
}

function formatDateLabel(date: string, format: CalendarDateFormat): string {
  const [year, month, day] = date.split('-');
  if (!year || !month || !day) return date;
  if (format === 'yyyy_mm_dd') return `${year}-${month}-${day}`;
  if (format === 'mm_dd') return `${month}/${day}`;
  return `${day}/${month}`;
}

function formatMonthTitle(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  return `${year}年${month}月`;
}

function weekDiffBetween(startWeek: string, targetWeek: string): number {
  const start = Date.parse(`${startWeek}T00:00:00Z`);
  const target = Date.parse(`${targetWeek}T00:00:00Z`);
  return Math.round((target - start) / (7 * 24 * 60 * 60 * 1000));
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function dateDiffDays(a: string, b: string): number {
  const aa = new Date(`${a}T00:00:00Z`).getTime();
  const bb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((bb - aa) / (24 * 60 * 60 * 1000)));
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function parseTimeValue(value: string): { hour: string; minute: string } {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!matched) {
    return { hour: '17', minute: '00' };
  }
  return {
    hour: matched[1],
    minute: matched[2],
  };
}

function getZonedDateISO(timeZone: string, now = new Date()): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(now);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (!year || !month || !day) {
      return now.toISOString().slice(0, 10);
    }
    return `${year}-${month}-${day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function findNextRestDate(params: {
  startDate: string;
  scheduleRule: ScheduleRule;
  anchorDate: string;
  anchorWeekType: 'big' | 'small';
}): string {
  for (let i = 0; i <= 370; i += 1) {
    const date = addDaysISO(params.startDate, i);
    if (
      isRestDayByRule({
        scheduleRule: params.scheduleRule,
        anchorDate: params.anchorDate,
        anchorWeekType: params.anchorWeekType,
        date,
      })
    ) {
      return date;
    }
  }
  return params.startDate;
}

function isRestDayByRule(params: {
  scheduleRule: ScheduleRule;
  anchorDate: string;
  anchorWeekType: 'big' | 'small';
  date: string;
}): boolean {
  const day = weekdayOf(params.date);

  if (params.scheduleRule === 'double_rest') {
    return day === 0 || day === 6;
  }

  if (params.scheduleRule === 'single_rest') {
    return day === 0;
  }

  const weekType = weekTypeForDate(params.anchorDate, params.anchorWeekType, params.date);
  if (weekType === 'big') {
    return day === 0 || day === 6;
  }
  return day === 0;
}

function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function weekStartMonday(isoDate: string): string {
  const w = weekdayOf(isoDate);
  const diff = w === 0 ? -6 : 1 - w;
  return addDaysISO(isoDate, diff);
}

function startOfWeekBySetting(isoDate: string, weekStart: CalendarWeekStart): string {
  if (weekStart === 'monday') {
    return weekStartMonday(isoDate);
  }
  const w = weekdayOf(isoDate);
  return addDaysISO(isoDate, -w);
}

function weekTypeForDate(anchorDate: string, anchorWeekType: 'big' | 'small', targetDate: string): 'big' | 'small' {
  const anchorWeekStart = weekStartMonday(anchorDate);
  const targetWeekStart = weekStartMonday(targetDate);
  const anchorMs = Date.parse(`${anchorWeekStart}T00:00:00Z`);
  const targetMs = Date.parse(`${targetWeekStart}T00:00:00Z`);
  const weekOffset = Math.floor((targetMs - anchorMs) / (7 * 24 * 60 * 60 * 1000));
  if (Math.abs(weekOffset) % 2 === 0) return anchorWeekType;
  return anchorWeekType === 'big' ? 'small' : 'big';
}

function getTimeZoneRegion(timeZone: string): string {
  if (!timeZone) return 'Etc';
  if (timeZone.includes('/')) return timeZone.split('/')[0];
  if (timeZone === 'UTC') return 'Etc';
  return 'Custom';
}

function formatTimeZoneLabel(timeZone: string): string {
  if (!timeZone.includes('/')) {
    return timeZone;
  }

  const city = timeZone.split('/').slice(1).join('/').replace(/_/g, ' ');
  return `${timeZone} (${city})`;
}

function buildTimeZoneGroups(seedZones: string[]): TimeZoneGroup[] {
  const intlWithSupported = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  const supported = intlWithSupported.supportedValuesOf?.('timeZone') ?? [];

  const seeded = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Etc/UTC', ...seedZones];
  const uniqueZones = Array.from(new Set([...supported, ...seeded].filter(Boolean))).sort((a, b) => a.localeCompare(b));

  const regionMap = new Map<string, string[]>();
  for (const zone of uniqueZones) {
    const region = getTimeZoneRegion(zone);
    const list = regionMap.get(region) ?? [];
    list.push(zone);
    regionMap.set(region, list);
  }

  const regionOrder = ['Asia', 'America', 'Europe', 'Pacific', 'Australia', 'Africa', 'Indian', 'Etc', 'Custom'];
  const regionLabel: Record<string, string> = {
    Asia: '亚洲',
    America: '美洲',
    Europe: '欧洲',
    Pacific: '太平洋',
    Australia: '澳洲',
    Africa: '非洲',
    Indian: '印度洋',
    Etc: '其他/UTC',
    Custom: '自定义',
  };

  const groups = Array.from(regionMap.entries()).map(([region, zones]) => ({
    region,
    label: regionLabel[region] || region,
    zones,
  }));

  groups.sort((a, b) => {
    const aIdx = regionOrder.indexOf(a.region);
    const bIdx = regionOrder.indexOf(b.region);
    if (aIdx === -1 && bIdx === -1) return a.region.localeCompare(b.region);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  return groups;
}

interface SwNotificationConfig {
  locale: 'zh-CN' | 'zh-HK' | 'zh-TW';
  templates: LocalTemplate[];
  importedNotificationPacks: Array<{
    id: string;
    locale: string;
    title: string;
    payload: Record<string, unknown>;
  }>;
}

async function syncNotificationConfigToServiceWorker(config: SwNotificationConfig): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.ready;
  const target = registration.active ?? registration.waiting ?? registration.installing;
  if (!target) return;

  target.postMessage({
    type: 'SYNC_NOTIFICATION_CONFIG',
    payload: config,
  });
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

async function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return;

  const existing = document.querySelector<HTMLScriptElement>(
    'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]'
  );
  if (existing) {
    await waitScriptLoad(existing);
    return;
  }

  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
  await waitScriptLoad(script);
}

async function waitScriptLoad(script: HTMLScriptElement): Promise<void> {
  if (window.turnstile) return;
  if (script.dataset.loaded === 'true') return;

  await new Promise<void>((resolve, reject) => {
    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = 'true';
        resolve();
      },
      { once: true }
    );
    script.addEventListener(
      'error',
      () => {
        reject(new Error('turnstile_script_load_failed'));
      },
      { once: true }
    );
  });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

export default App;
