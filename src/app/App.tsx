import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { getEnvVar } from "../config/env";
import { createAdapter, resolveDataBackend, type DataBackend } from "../data/createAdapter";
import type { RatingsStoreAdapter } from "../data/types";
import { createI18n, detectInitialLocale, parseLocale, persistLocale, SUPPORTED_LOCALES, type I18nKey, type Locale } from "../i18n";
import { ensurePushSubscription, isPushSupported, syncPushReminderSettings } from "../push/client";
import { readCookie, setCookie } from "../session/cookies";
import { detectInitialReminderSettings, markReminderSent, parseReminderTime, persistReminderSettings, shouldSendDailyReminder } from "../settings";
import {
  applyTheme,
  detectInitialThemePreference,
  parseThemePreference,
  persistThemePreference,
  resolveThemeFromPreference,
  type Theme,
  type ThemePreference,
} from "../theme";
import {
  buildCheckInInsights,
  buildWordCloud,
  getWordCloudWindowRange,
  parseIntensityInput,
  PRESET_CONTEXT_TAGS,
  resolveInitFailureStatus,
  resolveSignInLabelKey,
  splitWords,
  SUGGESTED_WORDS,
  type CheckInInsights,
  type CloudWindow,
} from "./logic";
import { AppHeader } from "./components/AppHeader";
import { EntryForm } from "./components/EntryForm";
import { SettingsView } from "./components/SettingsView";
import { ToastViewport, type ToastItem } from "./components/ToastViewport";
import { WeekChartCard } from "./components/WeekChartCard";

type BeforeInstallPromptEvent = Event & {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type AppRoute = "hello" | "log-today" | "past-data" | "settings";
type IntensityKey = "energy" | "stress" | "anxiety" | "joy";

const BACKEND_COOKIE_NAME = "being_better_data_backend";
const BASE_PATH = (() => {
  const baseUrl = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.BASE_URL?.trim();
  if (!baseUrl || baseUrl === "/") {
    return "";
  }

  const withLeadingSlash = baseUrl.startsWith("/") ? baseUrl : `/${baseUrl}`;
  const normalized = withLeadingSlash.replace(/\/+$/, "");
  return normalized === "" ? "" : normalized;
})();

function isStandaloneDisplay(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIosDevice(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

function isInstallSecureContext(): boolean {
  const { protocol, hostname } = window.location;
  return protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1";
}

function detectNotificationPermissionState(): NotificationPermission | "unsupported" {
  if (!("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

const SETTINGS_KEY_LOCALE = "locale";
const SETTINGS_KEY_THEME_PREFERENCE = "theme_preference";
const SETTINGS_KEY_REMINDER_ENABLED = "reminder_enabled";
const SETTINGS_KEY_REMINDER_TIME = "reminder_time";
const SETTINGS_KEY_STORAGE_BACKEND = "storage_backend";
function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function stripBasePath(pathname: string): string {
  const normalized = normalizePathname(pathname);
  if (!BASE_PATH) {
    return normalized;
  }

  if (normalized === BASE_PATH) {
    return "/";
  }
  if (normalized.startsWith(`${BASE_PATH}/`)) {
    return normalized.slice(BASE_PATH.length);
  }
  return normalized;
}

function appPath(pathname: string): string {
  if (!BASE_PATH) {
    return pathname;
  }
  return `${BASE_PATH}${pathname}`;
}

function routeFromPathname(pathname: string): AppRoute {
  const normalized = stripBasePath(pathname);
  if (normalized === "/hello") {
    return "hello";
  }
  if (normalized === "/log-today") {
    return "log-today";
  }
  if (normalized === "/past-data") {
    return "past-data";
  }
  if (normalized === "/settings") {
    return "settings";
  }
  return "hello";
}

function isKnownPathname(pathname: string): boolean {
  const normalized = stripBasePath(pathname);
  return normalized === "/hello" || normalized === "/log-today" || normalized === "/past-data" || normalized === "/settings";
}

function pathForRoute(route: AppRoute): string {
  if (route === "hello") {
    return "/hello";
  }
  if (route === "log-today") {
    return "/log-today";
  }
  if (route === "past-data") {
    return "/past-data";
  }
  return "/settings";
}

function routeToTab(route: AppRoute): "hello" | "entry" | "week" | "settings" {
  if (route === "log-today") {
    return "entry";
  }
  if (route === "past-data") {
    return "week";
  }
  return route;
}

function parseBooleanSetting(value: string | undefined): boolean | null {
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return null;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialLocale = detectInitialLocale();
  const i18n = createI18n(initialLocale);
  const initialThemePreference = detectInitialThemePreference();
  const initialReminderSettings = detectInitialReminderSettings();

  const [locale, setLocale] = createSignal(initialLocale);
  const [themePreference, setThemePreference] = createSignal<ThemePreference>(initialThemePreference);
  const [theme, setTheme] = createSignal<Theme>(resolveThemeFromPreference(initialThemePreference));
  const [toasts, setToasts] = createSignal<ToastItem[]>([]);
  const [isReady, setIsReady] = createSignal(false);
  const [signInEnabled, setSignInEnabled] = createSignal(false);
  const activeRoute = createMemo<AppRoute>(() => routeFromPathname(location.pathname));
  const [deferredInstallPrompt, setDeferredInstallPrompt] = createSignal<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = createSignal(false);
  const [reminderEnabled, setReminderEnabled] = createSignal(initialReminderSettings.enabled);
  const [reminderTime, setReminderTime] = createSignal(initialReminderSettings.time);
  const [notificationPermission, setNotificationPermission] = createSignal<NotificationPermission | "unsupported">(
    detectNotificationPermissionState(),
  );
  const [pushSubscription, setPushSubscription] = createSignal<PushSubscription | null>(null);
  const [selectedBackend, setSelectedBackend] = createSignal<DataBackend | null>(resolveDataBackend(getEnvVar("VITE_DATA_BACKEND")));
  const [settingsBackendDraft, setSettingsBackendDraft] = createSignal<DataBackend | null>(null);
  const [settingsGoogleSignInEnabled, setSettingsGoogleSignInEnabled] = createSignal(false);
  const [settingsGoogleAdapter, setSettingsGoogleAdapter] = createSignal<RatingsStoreAdapter | null>(null);
  const [backendDraft, setBackendDraft] = createSignal<DataBackend>("google");
  const [gateGoogleReady, setGateGoogleReady] = createSignal(false);
  const [gateGoogleSignInEnabled, setGateGoogleSignInEnabled] = createSignal(false);
  const [gateGoogleAdapter, setGateGoogleAdapter] = createSignal<RatingsStoreAdapter | null>(null);
  const [adapter, setAdapter] = createSignal<RatingsStoreAdapter | null>(null);

  const [wordsInput, setWordsInput] = createSignal("");
  const [suggestedWordsUsed, setSuggestedWordsUsed] = createSignal<string[]>([]);
  const [contextTags, setContextTags] = createSignal<string[]>([]);
  const [customTagValue, setCustomTagValue] = createSignal("");
  const [intensity, setIntensity] = createSignal<Record<IntensityKey, number | null>>({ energy: null, stress: null, anxiety: null, joy: null });
  const [cloudWindow, setCloudWindow] = createSignal<CloudWindow>("week");
  const [cloudWords, setCloudWords] = createSignal<Array<{ word: string; score: number }>>([]);
  const [checkInInsights, setCheckInInsights] = createSignal<CheckInInsights>({
    totalCheckIns: 0,
    activeDays: 0,
    currentStreak: 0,
    intensity: [
      { key: "energy", average: null, sampleCount: 0 },
      { key: "stress", average: null, sampleCount: 0 },
      { key: "anxiety", average: null, sampleCount: 0 },
      { key: "joy", average: null, sampleCount: 0 },
    ],
    dailyVolume: [],
    topContextTags: [],
    topSuggestedWords: [],
  });
  const [personalSuggestedWords, setPersonalSuggestedWords] = createSignal<string[]>([]);

  const toastTimeouts = new Map<number, number>();
  let nextToastId = 1;
  let bootSequence = 0;
  let gateBootSequence = 0;
  let settingsGoogleBootSequence = 0;
  let isApplyingRemoteSettings = false;

  const pushApiBaseUrl = getEnvVar("VITE_PUSH_API_BASE_URL") ?? getEnvVar("VITE_LOCAL_API_BASE_URL") ?? "";
  const t = (key: I18nKey, vars?: Record<string, string>) => {
    locale();
    return i18n.t(key, vars);
  };

  const wordCount = createMemo(() => splitWords(wordsInput()).length);
  const mergedSuggestedWords = createMemo(() => [...new Set([...SUGGESTED_WORDS, ...personalSuggestedWords()])]);
  const presetTagLabelMap = createMemo<Record<string, string>>(() => ({
    sleep: t("form.contextTag.sleep"),
    work: t("form.contextTag.work"),
    social: t("form.contextTag.social"),
    health: t("form.contextTag.health"),
    weather: t("form.contextTag.weather"),
    cycle: t("form.contextTag.cycle"),
  }));
  const suggestedWordLabelMap = createMemo<Record<string, string>>(() => ({
    calm: t("form.suggestedWord.calm"),
    hopeful: t("form.suggestedWord.hopeful"),
    tired: t("form.suggestedWord.tired"),
    drained: t("form.suggestedWord.drained"),
    focused: t("form.suggestedWord.focused"),
    grateful: t("form.suggestedWord.grateful"),
    overwhelmed: t("form.suggestedWord.overwhelmed"),
    steady: t("form.suggestedWord.steady"),
    joyful: t("form.suggestedWord.joyful"),
    restless: t("form.suggestedWord.restless"),
    clear: t("form.suggestedWord.clear"),
    anxious: t("form.suggestedWord.anxious"),
    excited: t("form.suggestedWord.excited"),
    happy: t("form.suggestedWord.happy"),
  }));

  applyTheme(theme());

  const setStatus = (text: string, isError = false, showToast = true): void => {
    if (!showToast) {
      return;
    }

    const id = nextToastId++;
    setToasts((current) => [...current, { id, text, isError }]);
    const timeoutId = window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
      toastTimeouts.delete(id);
    }, isError ? 4500 : 3200);
    toastTimeouts.set(id, timeoutId);
  };

  const setConnectedUiState = (): void => {
    setIsReady(true);
    setSignInEnabled(false);
  };

  const buildSettingsPayload = (storageBackendOverride?: DataBackend): Record<string, string> => ({
    [SETTINGS_KEY_LOCALE]: locale(),
    [SETTINGS_KEY_THEME_PREFERENCE]: themePreference(),
    [SETTINGS_KEY_REMINDER_ENABLED]: reminderEnabled() ? "1" : "0",
    [SETTINGS_KEY_REMINDER_TIME]: reminderTime(),
    [SETTINGS_KEY_STORAGE_BACKEND]: storageBackendOverride ?? selectedBackend() ?? "google",
  });

  const persistSettingsToAdapter = async (
    targetAdapter: RatingsStoreAdapter | null = adapter(),
    storageBackendOverride?: DataBackend,
  ): Promise<void> => {
    if (isApplyingRemoteSettings || !targetAdapter?.saveSettings || !targetAdapter.isReady()) {
      return;
    }

    try {
      await targetAdapter.saveSettings(buildSettingsPayload(storageBackendOverride));
    } catch (error) {
      console.error(error);
    }
  };

  const hydrateSettingsFromAdapter = async (targetAdapter: RatingsStoreAdapter, isStale: () => boolean): Promise<void> => {
    if (!targetAdapter.loadSettings) {
      return;
    }

    try {
      const settings = await targetAdapter.loadSettings();
      if (isStale()) {
        return;
      }

      isApplyingRemoteSettings = true;

      const nextLocale = parseLocale(settings[SETTINGS_KEY_LOCALE] ?? "");
      if (nextLocale && nextLocale !== locale()) {
        i18n.setLocale(nextLocale);
        persistLocale(nextLocale);
        setLocale(nextLocale);
      }

      const nextThemePreference = parseThemePreference(settings[SETTINGS_KEY_THEME_PREFERENCE] ?? "");
      if (nextThemePreference && nextThemePreference !== themePreference()) {
        persistThemePreference(nextThemePreference);
        setThemePreference(nextThemePreference);
        const nextTheme = resolveThemeFromPreference(nextThemePreference);
        applyTheme(nextTheme);
        setTheme(nextTheme);
      }

      const parsedReminderEnabled = parseBooleanSetting(settings[SETTINGS_KEY_REMINDER_ENABLED]);
      const parsedReminderTime = parseReminderTime(settings[SETTINGS_KEY_REMINDER_TIME] ?? "");
      const nextReminderEnabled = parsedReminderEnabled ?? reminderEnabled();
      const nextReminderTime = parsedReminderTime ?? reminderTime();
      if (nextReminderEnabled !== reminderEnabled() || nextReminderTime !== reminderTime()) {
        setReminderEnabled(nextReminderEnabled);
        setReminderTime(nextReminderTime);
        persistReminderSettings({ enabled: nextReminderEnabled, time: nextReminderTime });
        void syncPushSettingsIfPossible(nextReminderEnabled, nextReminderTime);
      }
    } catch (error) {
      console.error(error);
    } finally {
      isApplyingRemoteSettings = false;
    }
  };

  const refreshWordCloud = async (): Promise<void> => {
    const currentAdapter = adapter();
    if (!currentAdapter || !currentAdapter.isReady()) {
      return;
    }

    try {
      const range = getWordCloudWindowRange(cloudWindow(), new Date());
      const rows = await currentAdapter.listCheckIns(range);
      setCloudWords(buildWordCloud(rows, locale()));
      setCheckInInsights(buildCheckInInsights(rows, locale(), new Date()));
    } catch (error) {
      console.error(error);
      setStatus(t("status.cloudLoadFailed"), true);
    }
  };

  const refreshPersonalSuggestions = async (): Promise<void> => {
    const currentAdapter = adapter();
    if (!currentAdapter || !currentAdapter.isReady()) {
      return;
    }

    try {
      const range = getWordCloudWindowRange("all-time", new Date());
      const rows = await currentAdapter.listCheckIns(range);
      const topWords = buildWordCloud(rows, locale())
        .slice(0, 6)
        .map((entry) => entry.word);
      setPersonalSuggestedWords(topWords);
    } catch {
      setPersonalSuggestedWords([]);
    }
  };

  const syncThemePreference = async (nextPreference: ThemePreference): Promise<void> => {
    const nextTheme = resolveThemeFromPreference(nextPreference);
    setThemePreference(nextPreference);
    persistThemePreference(nextPreference);
    applyTheme(nextTheme);
    setTheme(nextTheme);
    await persistSettingsToAdapter();
  };

  const syncLocale = async (nextLocale: Locale): Promise<void> => {
    if (nextLocale === locale()) {
      return;
    }

    i18n.setLocale(nextLocale);
    persistLocale(nextLocale);
    setLocale(nextLocale);

    if (routeToTab(activeRoute()) === "week") {
      await refreshWordCloud();
    }

    await persistSettingsToAdapter();
  };

  const syncPushSettingsIfPossible = async (enabled: boolean, time: string): Promise<void> => {
    if (!pushApiBaseUrl || !isPushSupported()) {
      return;
    }

    const subscription = pushSubscription();
    if (!subscription) {
      return;
    }

    try {
      await syncPushReminderSettings(pushApiBaseUrl, subscription, {
        reminderEnabled: enabled,
        reminderTime: time,
        locale: locale(),
      });
    } catch (error) {
      console.error(error);
      setStatus(t("status.pushSyncFailed"), true);
    }
  };

  const syncReminderSettings = (nextEnabled: boolean, nextTime: string): void => {
    const validTime = parseReminderTime(nextTime) ?? "20:00";
    setReminderEnabled(nextEnabled);
    setReminderTime(validTime);
    persistReminderSettings({ enabled: nextEnabled, time: validTime });
    void syncPushSettingsIfPossible(nextEnabled, validTime);
    void persistSettingsToAdapter();
  };

  const maybeSendReminder = (): void => {
    const now = new Date();
    if (!shouldSendDailyReminder({ enabled: reminderEnabled(), time: reminderTime() }, now)) {
      return;
    }

    markReminderSent(now);

    const permission = detectNotificationPermissionState();
    setNotificationPermission(permission);

    if (permission === "granted") {
      new Notification(t("reminder.notificationTitle"), { body: t("reminder.notificationBody") });
      setStatus(t("status.reminderSent"));
      return;
    }

    if (permission === "unsupported") {
      setStatus(t("status.reminderDue"));
      return;
    }

    setStatus(t("status.reminderPermissionNeeded"), true);
  };

  async function boot(currentAdapter: RatingsStoreAdapter, backend: DataBackend, sequence: number): Promise<void> {
    const isStale = (): boolean => sequence !== bootSequence || selectedBackend() !== backend || adapter() !== currentAdapter;
    setStatus(t("status.waitingForLogin"), false, false);

    try {
      await currentAdapter.init();
      if (isStale()) {
        return;
      }

      if (currentAdapter.getAuthState() === "connected") {
        await hydrateSettingsFromAdapter(currentAdapter, isStale);
        if (isStale()) {
          return;
        }
        await persistSettingsToAdapter(currentAdapter);
        if (isStale()) {
          return;
        }
        setConnectedUiState();
        setStatus(backend === "google" ? t("status.sessionRestored") : t("status.connected"), false, false);
        return;
      }

      setSignInEnabled(true);
      setStatus(t("status.clickSignIn", { signIn: t("auth.signIn") }), false, false);
    } catch (error) {
      if (isStale()) {
        return;
      }
      console.error(error);
      const failure = resolveInitFailureStatus(backend, error);
      setStatus(t(failure.key), failure.isError);
      setSignInEnabled(false);
    }
  }

  async function initGateGoogleAuth(sequence: number): Promise<void> {
    const isStale = (): boolean => sequence !== gateBootSequence || selectedBackend() !== null || backendDraft() !== "google";
    const draftAdapter = createAdapter("google");
    setGateGoogleAdapter(draftAdapter);
    setGateGoogleReady(false);
    setGateGoogleSignInEnabled(false);

    try {
      await draftAdapter.init();
      if (isStale()) {
        return;
      }

      if (draftAdapter.getAuthState() === "connected") {
        setGateGoogleReady(true);
        setGateGoogleSignInEnabled(false);
        return;
      }

      setGateGoogleSignInEnabled(true);
    } catch (error) {
      if (isStale()) {
        return;
      }
      console.error(error);
      const failure = resolveInitFailureStatus("google", error);
      setStatus(t(failure.key), failure.isError);
      setGateGoogleSignInEnabled(false);
    }
  }

  async function initSettingsGoogleAuth(sequence: number): Promise<void> {
    const isStale = (): boolean => sequence !== settingsGoogleBootSequence || settingsBackendDraft() !== "google" || selectedBackend() !== "indexeddb";
    const draftAdapter = createAdapter("google");
    setSettingsGoogleAdapter(draftAdapter);
    setSettingsGoogleSignInEnabled(false);

    try {
      await draftAdapter.init();
      if (isStale()) {
        return;
      }

      if (draftAdapter.getAuthState() === "connected") {
        handleBackendSelection("google");
        setSettingsBackendDraft(null);
        setSettingsGoogleAdapter(null);
        setStatus(t("status.storageLocationUpdated"));
        return;
      }

      setSettingsGoogleSignInEnabled(true);
    } catch (error) {
      if (isStale()) {
        return;
      }
      console.error(error);
      const failure = resolveInitFailureStatus("google", error);
      setStatus(t(failure.key), failure.isError);
      setSettingsGoogleSignInEnabled(false);
    }
  }

  onMount(() => {
    if (!selectedBackend()) {
      const storedBackend = resolveDataBackend(readCookie(BACKEND_COOKIE_NAME) ?? undefined);
      if (storedBackend) {
        setSelectedBackend(storedBackend);
      } else {
        setBackendDraft("google");
      }
    }

    const standalone = isStandaloneDisplay();
    setIsInstalled(standalone);

    const beforeInstallPromptHandler = (event: Event): void => {
      event.preventDefault();
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent);
    };

    const appInstalledHandler = (): void => {
      setDeferredInstallPrompt(null);
      setIsInstalled(true);
      setStatus(t("status.appInstalled"), false, false);
    };

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const mediaQueryListener = (): void => {
      if (themePreference() === "system") {
        const nextTheme = resolveThemeFromPreference("system");
        applyTheme(nextTheme);
        setTheme(nextTheme);
      }
    };

    window.addEventListener("beforeinstallprompt", beforeInstallPromptHandler);
    window.addEventListener("appinstalled", appInstalledHandler);
    mediaQuery.addEventListener("change", mediaQueryListener);

    maybeSendReminder();
    if (pushApiBaseUrl && isPushSupported()) {
      void navigator.serviceWorker.ready.then(async (registration) => {
        let currentSubscription = await registration.pushManager.getSubscription();
        if (!currentSubscription && Notification.permission === "granted") {
          try {
            currentSubscription = await ensurePushSubscription(pushApiBaseUrl);
          } catch (error) {
            console.error(error);
          }
        }
        if (!currentSubscription) {
          return;
        }

        setPushSubscription(currentSubscription);
        try {
          await syncPushReminderSettings(pushApiBaseUrl, currentSubscription, {
            reminderEnabled: reminderEnabled(),
            reminderTime: reminderTime(),
            locale: locale(),
          });
        } catch (error) {
          console.error(error);
        }
      });
    }
    const reminderIntervalId = window.setInterval(maybeSendReminder, 30_000);

    onCleanup(() => {
      window.removeEventListener("beforeinstallprompt", beforeInstallPromptHandler);
      window.removeEventListener("appinstalled", appInstalledHandler);
      mediaQuery.removeEventListener("change", mediaQueryListener);
      window.clearInterval(reminderIntervalId);
      for (const timeoutId of toastTimeouts.values()) {
        window.clearTimeout(timeoutId);
      }
      toastTimeouts.clear();
    });
  });

  createEffect(() => {
    const backend = selectedBackend();
    bootSequence += 1;
    const sequence = bootSequence;

    if (!backend) {
      setAdapter(null);
      setIsReady(false);
      setSignInEnabled(false);
      return;
    }

    const nextAdapter = createAdapter(backend);
    setAdapter(nextAdapter);
    setIsReady(false);
    setSignInEnabled(false);
    void boot(nextAdapter, backend, sequence);
  });

  createEffect(() => {
    if (selectedBackend() !== null) {
      return;
    }

    if (backendDraft() !== "google") {
      setGateGoogleAdapter(null);
      setGateGoogleReady(false);
      setGateGoogleSignInEnabled(false);
      return;
    }

    gateBootSequence += 1;
    const sequence = gateBootSequence;
    void initGateGoogleAuth(sequence);
  });

  createEffect(() => {
    if (selectedBackend() !== "indexeddb" && settingsBackendDraft() !== null) {
      setSettingsBackendDraft(null);
      setSettingsGoogleAdapter(null);
      setSettingsGoogleSignInEnabled(false);
    }
  });

  createEffect(() => {
    if (!isInstalled() && reminderEnabled()) {
      syncReminderSettings(false, reminderTime());
    }
  });

  createEffect(() => {
    if (!isKnownPathname(location.pathname)) {
      navigate(appPath("/hello"), { replace: true });
    }
  });

  createEffect(() => {
    if (activeRoute() === "hello" && selectedBackend() !== null) {
      navigate(appPath("/log-today"), { replace: true });
    }
  });

  createEffect(() => {
    if (activeRoute() === "past-data") {
      void refreshWordCloud();
    }
  });

  createEffect(() => {
    if (activeRoute() === "log-today" && isReady()) {
      void refreshPersonalSuggestions();
    }
  });

  const handleSignIn = async (): Promise<void> => {
    const currentAdapter = adapter();
    if (!currentAdapter?.requestSignIn) {
      return;
    }

    setStatus(t("status.openingGoogleLogin"));

    try {
      await currentAdapter.requestSignIn();
      setConnectedUiState();
      setStatus(t("status.connected"));
    } catch (error) {
      console.error(error);
      setStatus(t("status.authRejected"), true);
    }
  };

  const navigateToRoute = (route: AppRoute): void => {
    navigate(appPath(pathForRoute(route)));
  };

  const handleEntryTab = (): void => {
    navigateToRoute("log-today");
  };

  const handleWeekTab = (): void => {
    navigateToRoute("past-data");
  };

  const handleSettingsTab = (): void => {
    navigateToRoute("settings");
  };

  const handleSubmitCheckIn = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    const currentAdapter = adapter();
    if (!currentAdapter || !currentAdapter.isReady()) {
      setStatus(t("status.signInFirst"), true);
      return;
    }

    const words = splitWords(wordsInput());
    if (words.length === 0) {
      setStatus(t("status.wordsRequired"), true);
      return;
    }

    try {
      setStatus(t("status.savingCheckIn"));
      await currentAdapter.appendCheckIn({
        timestamp: new Date().toISOString(),
        words,
        suggestedWordsUsed: suggestedWordsUsed(),
        intensity: intensity(),
        contextTags: contextTags(),
      });

      setWordsInput("");
      setSuggestedWordsUsed([]);
      setContextTags([]);
      setCustomTagValue("");
      setIntensity({ energy: null, stress: null, anxiety: null, joy: null });
      setStatus(t("status.checkInSaved"));

      if (routeToTab(activeRoute()) === "week") {
        await refreshWordCloud();
      }
    } catch (error) {
      console.error(error);
      setStatus(t("status.checkInSaveFailed"), true);
    }
  };

  const handleAddSuggestedWord = (word: string): void => {
    const currentWords = splitWords(wordsInput());
    if (currentWords.includes(word)) {
      return;
    }

    setWordsInput(currentWords.length === 0 ? word : `${wordsInput().trim()} ${word}`);
    setSuggestedWordsUsed((current) => (current.includes(word) ? current : [...current, word]));
  };

  const handleIntensityInput = (key: IntensityKey, value: string): void => {
    const parsed = parseIntensityInput(value);
    if (parsed === null) {
      return;
    }
    setIntensity((current) => ({ ...current, [key]: parsed }));
  };

  const addTag = (rawValue: string): void => {
    const nextTag = rawValue.trim().toLowerCase();
    if (!nextTag || contextTags().includes(nextTag)) {
      return;
    }
    setContextTags((current) => [...current, nextTag]);
  };

  const handleTogglePresetTag = (tag: string): void => {
    if (contextTags().includes(tag)) {
      setContextTags((current) => current.filter((item) => item !== tag));
      return;
    }
    setContextTags((current) => [...current, tag]);
  };

  const handleAddCustomTag = (): void => {
    addTag(customTagValue());
    setCustomTagValue("");
  };

  const handleTimeframeChange = async (event: Event): Promise<void> => {
    const select = event.currentTarget as HTMLSelectElement;
    const nextWindow = select.value as CloudWindow;
    setCloudWindow(nextWindow);
    await refreshWordCloud();
  };

  const handleLocaleChange = async (event: Event): Promise<void> => {
    const select = event.currentTarget as HTMLSelectElement;
    const nextLocale = parseLocale(select.value) ?? "en";
    await syncLocale(nextLocale);
    await syncPushSettingsIfPossible(reminderEnabled(), reminderTime());
  };

  const handleThemePreferenceChange = async (event: Event): Promise<void> => {
    const select = event.currentTarget as HTMLSelectElement;
    const nextPreference = parseThemePreference(select.value) ?? "system";
    await syncThemePreference(nextPreference);
  };

  const handleThemeChange = async (event: Event): Promise<void> => {
    const select = event.currentTarget as HTMLSelectElement;
    const nextPreference = select.value === "dark" ? "dark" : "light";
    await syncThemePreference(nextPreference);
  };

  const handleReminderEnabledChange = (event: Event): void => {
    if (!isInstalled()) {
      return;
    }
    const input = event.currentTarget as HTMLInputElement;
    syncReminderSettings(input.checked, reminderTime());
  };

  const handleReminderTimeChange = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    syncReminderSettings(reminderEnabled(), input.value);
  };

  const handleNotificationsEnabledChange = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.checked) {
      void handleRequestReminderPermission();
      return;
    }

    if (notificationPermission() === "granted") {
      setStatus(t("status.reminderPermissionManagedByBrowser"), true);
    }
  };

  const handleStorageBackendChange = (event: Event): void => {
    const select = event.currentTarget as HTMLSelectElement;
    const nextBackend = resolveDataBackend(select.value);
    if (!nextBackend) {
      return;
    }

    if (nextBackend === "indexeddb") {
      if (selectedBackend() === "google") {
        void persistSettingsToAdapter(adapter(), "indexeddb");
      }
      setSettingsBackendDraft(null);
      setSettingsGoogleAdapter(null);
      setSettingsGoogleSignInEnabled(false);
      if (selectedBackend() !== "indexeddb") {
        handleBackendSelection("indexeddb");
        setStatus(t("status.storageLocationUpdated"));
      }
      return;
    }

    if (selectedBackend() === "google") {
      setSettingsBackendDraft(null);
      return;
    }

    setSettingsBackendDraft("google");
    settingsGoogleBootSequence += 1;
    void initSettingsGoogleAuth(settingsGoogleBootSequence);
  };

  const handleStorageGoogleSignIn = async (): Promise<void> => {
    const draftAdapter = settingsGoogleAdapter();
    if (!draftAdapter?.requestSignIn || settingsBackendDraft() !== "google") {
      return;
    }

    setStatus(t("status.openingGoogleLogin"));
    try {
      await draftAdapter.requestSignIn();
      handleBackendSelection("google");
      setSettingsBackendDraft(null);
      setSettingsGoogleAdapter(null);
      setSettingsGoogleSignInEnabled(false);
      setStatus(t("status.storageLocationUpdated"));
    } catch (error) {
      console.error(error);
      setStatus(t("status.authRejected"), true);
    }
  };

  const handleRequestReminderPermission = async (): Promise<void> => {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      setStatus(t("status.reminderNotificationsUnsupported"), true);
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);

    if (permission === "granted") {
      if (pushApiBaseUrl && isPushSupported()) {
        try {
          const subscription = await ensurePushSubscription(pushApiBaseUrl);
          setPushSubscription(subscription);
          await syncPushReminderSettings(pushApiBaseUrl, subscription, {
            reminderEnabled: reminderEnabled(),
            reminderTime: reminderTime(),
            locale: locale(),
          });
        } catch (error) {
          console.error(error);
          setStatus(t("status.pushSetupFailed"), true);
          return;
        }
      }
      setStatus(t("status.reminderPermissionGranted"));
      maybeSendReminder();
      return;
    }

    setStatus(t("status.reminderPermissionDenied"), true);
  };

  const handleInstall = async (): Promise<void> => {
    if (isStandaloneDisplay()) {
      setIsInstalled(true);
      setStatus(t("status.appInstalled"));
      return;
    }

    const promptEvent = deferredInstallPrompt();
    if (promptEvent) {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === "accepted") {
        setStatus(t("status.installAccepted"));
      } else {
        setStatus(t("status.installDismissed"));
      }

      setDeferredInstallPrompt(null);
      return;
    }

    if (isIosDevice()) {
      setStatus(t("status.installIosHint"));
      return;
    }

    if (!isInstallSecureContext()) {
      setStatus(t("status.installNeedsHttps"), true);
      return;
    }

    setStatus(t("status.installUseBrowserMenu"));
  };

  const handleBackendSelection = (backend: DataBackend): void => {
    setSelectedBackend(backend);
    setCookie(BACKEND_COOKIE_NAME, backend, 31536000);
    if (backend === "google") {
      void persistSettingsToAdapter();
    }
  };

  const handleGateGoogleSignIn = async (): Promise<void> => {
    const draftAdapter = gateGoogleAdapter();
    if (!draftAdapter?.requestSignIn) {
      return;
    }

    setStatus(t("status.openingGoogleLogin"));
    try {
      await draftAdapter.requestSignIn();
      setGateGoogleReady(true);
      setGateGoogleSignInEnabled(false);
      setStatus(t("status.connected"), false, false);
    } catch (error) {
      console.error(error);
      setStatus(t("status.authRejected"), true);
    }
  };

  const isBackendConfirmEnabled = (): boolean => {
    if (backendDraft() === "indexeddb") {
      return true;
    }
    return gateGoogleReady();
  };

  const handleConfirmBackendSelection = (): void => {
    if (!isBackendConfirmEnabled()) {
      return;
    }
    handleBackendSelection(backendDraft());
  };

  const permissionStateLabel = (): string => {
    if (notificationPermission() === "unsupported") {
      return t("settings.notificationsUnsupported");
    }
    if (notificationPermission() === "granted") {
      return t("settings.notificationsGranted");
    }
    if (notificationPermission() === "denied") {
      return t("settings.notificationsDenied");
    }
    return t("settings.notificationsDefault");
  };

  return (
    <main class="shell">
      <Show
        when={selectedBackend() === null}
        fallback={
          <>
            <AppHeader
              locale={locale()}
              supportedLocales={SUPPORTED_LOCALES}
              t={t}
              theme={theme()}
              pageLabel={
                activeRoute() === "hello"
                  ? "Hello"
                  : activeRoute() === "log-today"
                    ? t("tabs.entry")
                    : activeRoute() === "past-data"
                      ? t("tabs.week")
                      : t("tabs.settings")
              }
              isConnected={isReady()}
              showSignIn={!isReady()}
              signInLabel={t(resolveSignInLabelKey(isReady()))}
              signInDisabled={isReady() || !signInEnabled()}
              activeTab={routeToTab(activeRoute())}
              entryLabel={t("tabs.entry")}
              weekLabel={t("tabs.week")}
              settingsLabel={t("tabs.settings")}
              entryDisabled={!isReady()}
              weekDisabled={!isReady()}
              installLabel={isInstalled() ? t("install.installed") : t("install.installApp")}
              installDisabled={isInstalled()}
              onLocaleChange={(event) => {
                void handleLocaleChange(event);
              }}
              onThemeChange={(event) => {
                void handleThemeChange(event);
              }}
              onSignIn={() => {
                void handleSignIn();
              }}
              onInstall={() => {
                void handleInstall();
              }}
              onEntryClick={handleEntryTab}
              onWeekClick={handleWeekTab}
              onSettingsClick={handleSettingsTab}
            />

            <section id="hello-view" class={`view${activeRoute() === "hello" ? "" : " hidden"}`}>
              <div class="card">
                <p class="label">Hello</p>
                <p class="status">{isReady() ? t("status.connected") : t("status.clickSignIn", { signIn: t("auth.signIn") })}</p>
              </div>
            </section>

            <EntryForm
              visible={activeRoute() === "log-today"}
              title={t("form.title")}
              wordsLabel={t("form.words")}
              wordsPlaceholder={t("form.wordsPlaceholder")}
              wordCountLabel={t("form.wordCount")}
              suggestedWordsLabel={t("form.suggestedWords")}
              intensityLabels={{
                energy: t("form.energy"),
                stress: t("form.stress"),
                anxiety: t("form.anxiety"),
                joy: t("form.joy"),
              }}
              contextTagsLabel={t("form.contextTags")}
              customTagPlaceholder={t("form.customTagPlaceholder")}
              addTagLabel={t("form.addTag")}
              saveLabel={t("form.save")}
              softLimitHint={t("form.wordLimitHint")}
              wordsInputValue={wordsInput()}
              wordCount={wordCount()}
              wordLimit={20}
              showWordLimitHint={wordCount() > 20}
              suggestedWords={mergedSuggestedWords().map((word) => ({
                value: word,
                label: suggestedWordLabelMap()[word] ?? word,
              }))}
              contextTags={contextTags()}
              presetContextTags={PRESET_CONTEXT_TAGS.map((tag) => ({
                value: tag,
                label: presetTagLabelMap()[tag],
              }))}
              selectedContextTags={contextTags().map((tag) => ({
                value: tag,
                label: presetTagLabelMap()[tag] ?? tag,
              }))}
              customTagValue={customTagValue()}
              intensity={intensity()}
              onWordsInput={(event) => {
                setWordsInput(event.currentTarget.value);
              }}
              onAddSuggestedWord={handleAddSuggestedWord}
              onIntensityInput={handleIntensityInput}
              onTogglePresetTag={handleTogglePresetTag}
              onCustomTagInput={(event) => {
                setCustomTagValue(event.currentTarget.value);
              }}
              onAddCustomTag={() => {
                handleAddCustomTag();
              }}
              onRemoveTag={(tag) => {
                setContextTags((current) => current.filter((item) => item !== tag));
              }}
              onSubmit={(event) => {
                void handleSubmitCheckIn(event);
              }}
            />

            <WeekChartCard
              visible={activeRoute() === "past-data"}
              title={t("cloud.title")}
              emptyLabel={t("cloud.empty")}
              summaryTitle={t("analytics.summaryTitle")}
              totalCheckInsLabel={t("analytics.totalCheckIns")}
              activeDaysLabel={t("analytics.activeDays")}
              streakLabel={t("analytics.currentStreak")}
              volumeTitle={t("analytics.volumeTitle")}
              noVolumeLabel={t("analytics.noVolume")}
              contextTagsTitle={t("analytics.contextTagsTitle")}
              suggestedWordsTitle={t("analytics.suggestedWordsTitle")}
              noTagsLabel={t("analytics.noTags")}
              noSuggestedWordsLabel={t("analytics.noSuggestedWords")}
              timeframeLabel={t("cloud.timeframe")}
              timeframe={cloudWindow()}
              words={cloudWords()}
              insights={checkInInsights()}
              intensityLabels={{
                energy: t("form.energy"),
                stress: t("form.stress"),
                anxiety: t("form.anxiety"),
                joy: t("form.joy"),
              }}
              timeframeOptions={[
                { value: "today", label: t("cloud.today") },
                { value: "week", label: t("cloud.week") },
                { value: "month", label: t("cloud.month") },
                { value: "all-time", label: t("cloud.allTime") },
              ]}
              onTimeframeChange={(event) => {
                void handleTimeframeChange(event);
              }}
            />

            <SettingsView
              visible={activeRoute() === "settings"}
              languageLabel={t("settings.language")}
              themeLabel={t("settings.theme")}
              storageLocationLabel={t("settings.storageLocation")}
              storageGoogleLabel={t("backend.google")}
              storageIndexedDbLabel={t("backend.indexedDb")}
              storageHelpText={(settingsBackendDraft() ?? selectedBackend()) === "google" ? t("backend.storageNoteGoogle") : t("backend.storageNoteIndexedDb")}
              storageGoogleSignInLabel={t("auth.signIn")}
              showStorageGoogleSignIn={settingsBackendDraft() === "google" && selectedBackend() !== "google"}
              storageGoogleSignInDisabled={!settingsGoogleSignInEnabled()}
              reminderEnabledLabel={t("settings.reminderEnabled")}
              reminderTimeLabel={t("settings.reminderTime")}
              reminderPermissionLabel={t("settings.reminderPermission")}
              reminderPermissionStateLabel={permissionStateLabel()}
              themeOptionLightLabel={t("theme.light")}
              themeOptionDarkLabel={t("theme.dark")}
              themeOptionSystemLabel={t("theme.system")}
              locale={locale()}
              supportedLocales={SUPPORTED_LOCALES}
              themePreference={themePreference()}
              storageBackend={selectedBackend() ?? "google"}
              storageBackendValue={settingsBackendDraft() ?? selectedBackend() ?? "google"}
              showReminderSettings={isInstalled()}
              reminderEnabled={reminderEnabled()}
              reminderTime={reminderTime()}
              notificationsEnabled={notificationPermission() === "granted"}
              notificationsUnsupported={notificationPermission() === "unsupported"}
              onLocaleChange={(event) => {
                void handleLocaleChange(event);
              }}
              onThemePreferenceChange={(event) => {
                void handleThemePreferenceChange(event);
              }}
              onStorageBackendChange={handleStorageBackendChange}
              onStorageGoogleSignIn={() => {
                void handleStorageGoogleSignIn();
              }}
              onReminderEnabledChange={handleReminderEnabledChange}
              onReminderTimeChange={handleReminderTimeChange}
              onNotificationsEnabledChange={handleNotificationsEnabledChange}
            />
          </>
        }
      >
        <section class="card backend-gate" aria-label={t("backend.ariaLabel")}>
          <h1 id="title" class="backend-gate-brand">{t("app.title")}</h1>
          <h2 class="backend-gate-title">{t("backend.title")}</h2>
          <p class="backend-gate-description">{t("backend.description")}</p>
          <fieldset class="backend-gate-radios">
            <legend class="backend-gate-legend">{t("backend.ariaLabel")}</legend>
            <label class="backend-radio">
              <input
                type="radio"
                name="backend"
                value="google"
                checked={backendDraft() === "google"}
                onChange={() => setBackendDraft("google")}
              />
              <span>{t("backend.google")}</span>
              <span class="backend-help" tabindex="0" aria-label={t("backend.googleHelpLabel")}>
                ?
                <span class="backend-help-tooltip" role="tooltip">
                  {t("backend.googleHelpText")}
                </span>
              </span>
            </label>
            <label class="backend-radio">
              <input
                type="radio"
                name="backend"
                value="indexeddb"
                checked={backendDraft() === "indexeddb"}
                onChange={() => setBackendDraft("indexeddb")}
              />
              <span>{t("backend.indexedDb")}</span>
              <span class="backend-help" tabindex="0" aria-label={t("backend.indexedDbHelpLabel")}>
                ?
                <span class="backend-help-tooltip" role="tooltip">
                  {t("backend.indexedDbHelpText")}
                </span>
              </span>
            </label>
          </fieldset>
          <Show when={backendDraft() === "google"}>
            <button
              class="btn backend-google-signin"
              type="button"
              disabled={!gateGoogleReady() && !gateGoogleSignInEnabled()}
              onClick={() => {
                void handleGateGoogleSignIn();
              }}
            >
              {t(resolveSignInLabelKey(gateGoogleReady()))}
            </button>
          </Show>
          <button
            class="btn btn-primary backend-confirm"
            type="button"
            disabled={!isBackendConfirmEnabled()}
            onClick={handleConfirmBackendSelection}
          >
            {t("backend.confirm")}
          </button>
          <p class="backend-privacy-note">
            {backendDraft() === "google" ? t("backend.storageNoteGoogle") : t("backend.storageNoteIndexedDb")}
          </p>
        </section>
      </Show>

      <ToastViewport toasts={toasts()} />
    </main>
  );
}
