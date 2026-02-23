import { createSignal, onCleanup, onMount } from "solid-js";
import { buildLastWeekSeries, type RatingPoint } from "../chart/weekly";
import { getEnvVar } from "../config/env";
import { createAdapter, resolveDataBackend, type DataBackend } from "../data/createAdapter";
import { createI18n, detectInitialLocale, parseLocale, persistLocale, SUPPORTED_LOCALES, toBcp47Locale, type I18nKey, type Locale } from "../i18n";
import { ensurePushSubscription, isPushSupported, syncPushReminderSettings } from "../push/client";
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
import { parseRatingInput, resolveInitFailureStatus, resolveSignInLabelKey, shouldRefreshWeekChart } from "./logic";
import { AppHeader } from "./components/AppHeader";
import { EntryForm } from "./components/EntryForm";
import { SettingsView } from "./components/SettingsView";
import { Tabs } from "./components/Tabs";
import { ToastViewport, type ToastItem } from "./components/ToastViewport";
import { WeekChartCard } from "./components/WeekChartCard";

type BeforeInstallPromptEvent = Event & {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

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

export function App() {
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
  const [activeTab, setActiveTab] = createSignal<"entry" | "week" | "settings">("entry");
  const [ratingValue, setRatingValue] = createSignal("5");
  const [chartPoints, setChartPoints] = createSignal<RatingPoint[]>([]);
  const [chartRefreshToken, setChartRefreshToken] = createSignal(0);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = createSignal<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = createSignal(false);
  const [reminderEnabled, setReminderEnabled] = createSignal(initialReminderSettings.enabled);
  const [reminderTime, setReminderTime] = createSignal(initialReminderSettings.time);
  const [notificationPermission, setNotificationPermission] = createSignal<NotificationPermission | "unsupported">(
    detectNotificationPermissionState(),
  );
  const [pushSubscription, setPushSubscription] = createSignal<PushSubscription | null>(null);
  const toastTimeouts = new Map<number, number>();
  let nextToastId = 1;

  const backend: DataBackend = resolveDataBackend(getEnvVar("VITE_DATA_BACKEND"));
  const pushApiBaseUrl = getEnvVar("VITE_PUSH_API_BASE_URL") ?? getEnvVar("VITE_LOCAL_API_BASE_URL") ?? "";
  const adapter = createAdapter(backend);
  const t = (key: I18nKey, vars?: Record<string, string>) => {
    locale();
    return i18n.t(key, vars);
  };

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

  const syncThemePreference = async (nextPreference: ThemePreference): Promise<void> => {
    const nextTheme = resolveThemeFromPreference(nextPreference);
    setThemePreference(nextPreference);
    persistThemePreference(nextPreference);
    applyTheme(nextTheme);
    setTheme(nextTheme);
    setChartRefreshToken((value) => value + 1);

    if (shouldRefreshWeekChart(activeTab())) {
      await refreshWeeklyChart();
    }
  };

  const syncLocale = async (nextLocale: Locale): Promise<void> => {
    if (nextLocale === locale()) {
      return;
    }

    i18n.setLocale(nextLocale);
    persistLocale(nextLocale);
    setLocale(nextLocale);

    if (activeTab() === "week") {
      await refreshWeeklyChart();
    }
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

  async function refreshWeeklyChart(): Promise<void> {
    if (!adapter.isReady()) {
      setStatus(t("status.signInFirst"), true);
      return;
    }

    try {
      const now = new Date();
      const toIso = now.toISOString();
      const from = new Date(now);
      from.setDate(from.getDate() - 6);
      from.setHours(0, 0, 0, 0);

      const rows = await adapter.listRatings({
        fromIso: from.toISOString(),
        toIso,
      });

      setChartPoints(buildLastWeekSeries(rows, toBcp47Locale(locale()), now));
      setChartRefreshToken((value) => value + 1);
    } catch (error) {
      console.error(error);
      setStatus(t("status.chartLoadFailed"), true);
    }
  }

  async function generateWeeklyChartOnDemand(): Promise<void> {
    if (!adapter.isReady()) {
      setStatus(t("status.signInFirst"), true);
      return;
    }

    setStatus(t("status.generatingChart"));
    await refreshWeeklyChart();
    setStatus(t("status.chartUpdated"));
  }

  async function boot(): Promise<void> {
    setStatus(t("status.waitingForLogin"), false, false);

    try {
      await adapter.init();

      if (adapter.getAuthState() === "connected") {
        setConnectedUiState();
        setStatus(backend === "google" ? t("status.sessionRestored") : t("status.connected"), false, false);
        return;
      }

      setSignInEnabled(true);
      setStatus(t("status.clickSignIn", { signIn: t("auth.signIn") }), false, false);
    } catch (error) {
      console.error(error);
      const failure = resolveInitFailureStatus(backend, error);
      setStatus(t(failure.key), failure.isError);
      setSignInEnabled(false);
    }
  }

  onMount(() => {
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
        setChartRefreshToken((value) => value + 1);
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

    void boot();

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

  const handleSignIn = async (): Promise<void> => {
    if (!adapter.requestSignIn) {
      return;
    }

    setStatus(t("status.openingGoogleLogin"));

    try {
      await adapter.requestSignIn();
      setConnectedUiState();
      setStatus(t("status.connected"));
    } catch (error) {
      console.error(error);
      setStatus(t("status.authRejected"), true);
    }
  };

  const handleEntryTab = (): void => {
    setActiveTab("entry");
  };

  const handleWeekTab = async (): Promise<void> => {
    setActiveTab("week");
    await generateWeeklyChartOnDemand();
  };

  const handleSettingsTab = (): void => {
    setActiveTab("settings");
  };

  const handleSubmitRating = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    if (!adapter.isReady()) {
      setStatus(t("status.signInFirst"), true);
      return;
    }

    const rating = parseRatingInput(ratingValue());
    if (rating === null) {
      setStatus(t("status.invalidRating"), true);
      return;
    }

    try {
      setStatus(t("status.savingRating"));
      await adapter.appendRating({
        timestamp: new Date().toISOString(),
        rating,
      });

      setRatingValue("");
      setStatus(t("status.ratingSaved"));

      if (shouldRefreshWeekChart(activeTab())) {
        await refreshWeeklyChart();
      }
    } catch (error) {
      console.error(error);
      setStatus(t("status.ratingSaveFailed"), true);
    }
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
    const input = event.currentTarget as HTMLInputElement;
    syncReminderSettings(input.checked, reminderTime());
  };

  const handleReminderTimeChange = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    syncReminderSettings(reminderEnabled(), input.value);
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
      <AppHeader
        locale={locale()}
        supportedLocales={SUPPORTED_LOCALES}
        t={t}
        theme={theme()}
        isConnected={isReady()}
        showSignIn={!isReady()}
        signInLabel={t(resolveSignInLabelKey(isReady()))}
        signInDisabled={isReady() || !signInEnabled()}
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
      />

      <Tabs
        activeTab={activeTab()}
        ariaLabel={t("tabs.ariaLabel")}
        entryLabel={t("tabs.entry")}
        weekLabel={t("tabs.week")}
        settingsLabel={t("tabs.settings")}
        entryDisabled={!isReady()}
        weekDisabled={!isReady()}
        onEntryClick={handleEntryTab}
        onWeekClick={() => {
          void handleWeekTab();
        }}
        onSettingsClick={handleSettingsTab}
      />

      <EntryForm
        stepLabel={t("form.step")}
        title={t("form.title")}
        subtitle={t("form.subtitle")}
        label={t("form.question")}
        saveLabel={t("form.save")}
        value={ratingValue()}
        onValueInput={(event) => {
          setRatingValue(event.currentTarget.value);
        }}
        onSubmit={(event) => {
          void handleSubmitRating(event);
        }}
      />

      <WeekChartCard
        visible={activeTab() === "week"}
        title={t("chart.title")}
        ariaLabel={t("chart.ariaLabel")}
        emptyLabel={t("chart.empty")}
        points={chartPoints()}
        refreshToken={chartRefreshToken()}
      />

      <SettingsView
        visible={activeTab() === "settings"}
        languageLabel={t("settings.language")}
        themeLabel={t("settings.theme")}
        reminderEnabledLabel={t("settings.reminderEnabled")}
        reminderTimeLabel={t("settings.reminderTime")}
        reminderPermissionLabel={t("settings.reminderPermission")}
        reminderPermissionActionLabel={t("settings.reminderPermissionAction")}
        reminderPermissionStateLabel={permissionStateLabel()}
        themeOptionLightLabel={t("theme.light")}
        themeOptionDarkLabel={t("theme.dark")}
        themeOptionSystemLabel={t("theme.system")}
        locale={locale()}
        supportedLocales={SUPPORTED_LOCALES}
        themePreference={themePreference()}
        reminderEnabled={reminderEnabled()}
        reminderTime={reminderTime()}
        showNotificationPermissionAction={notificationPermission() !== "unsupported" && notificationPermission() !== "granted"}
        onLocaleChange={(event) => {
          void handleLocaleChange(event);
        }}
        onThemePreferenceChange={(event) => {
          void handleThemePreferenceChange(event);
        }}
        onReminderEnabledChange={handleReminderEnabledChange}
        onReminderTimeChange={handleReminderTimeChange}
        onRequestReminderPermission={() => {
          void handleRequestReminderPermission();
        }}
      />

      <ToastViewport toasts={toasts()} />
    </main>
  );
}
