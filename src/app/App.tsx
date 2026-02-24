import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { buildLastWeekSeries, type RatingPoint } from "../chart/weekly";
import { getEnvVar } from "../config/env";
import { createAdapter, resolveDataBackend, type DataBackend } from "../data/createAdapter";
import type { RatingsStoreAdapter } from "../data/types";
import { createI18n, detectInitialLocale, parseLocale, persistLocale, SUPPORTED_LOCALES, toBcp47Locale, type I18nKey, type Locale } from "../i18n";
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
import { parseRatingInput, resolveInitFailureStatus, resolveSignInLabelKey, shouldRefreshWeekChart } from "./logic";
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

const BACKEND_COOKIE_NAME = "being_better_data_backend";
type AppRoute = "hello" | "log-today" | "past-data" | "settings";

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function routeFromPathname(pathname: string): AppRoute {
  const normalized = normalizePathname(pathname);
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
  const normalized = normalizePathname(pathname);
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
  const [selectedBackend, setSelectedBackend] = createSignal<DataBackend | null>(resolveDataBackend(getEnvVar("VITE_DATA_BACKEND")));
  const [backendDraft, setBackendDraft] = createSignal<DataBackend>("google");
  const [gateGoogleReady, setGateGoogleReady] = createSignal(false);
  const [gateGoogleSignInEnabled, setGateGoogleSignInEnabled] = createSignal(false);
  const [gateGoogleAdapter, setGateGoogleAdapter] = createSignal<RatingsStoreAdapter | null>(null);
  const [adapter, setAdapter] = createSignal<RatingsStoreAdapter | null>(null);
  const toastTimeouts = new Map<number, number>();
  let nextToastId = 1;
  let bootSequence = 0;
  let gateBootSequence = 0;

  const pushApiBaseUrl = getEnvVar("VITE_PUSH_API_BASE_URL") ?? getEnvVar("VITE_LOCAL_API_BASE_URL") ?? "";
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

    if (shouldRefreshWeekChart(routeToTab(activeRoute()))) {
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

    if (routeToTab(activeRoute()) === "week") {
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
    const currentAdapter = adapter();
    if (!currentAdapter || !currentAdapter.isReady()) {
      setStatus(t("status.signInFirst"), true);
      return;
    }

    try {
      const now = new Date();
      const toIso = now.toISOString();
      const from = new Date(now);
      from.setDate(from.getDate() - 6);
      from.setHours(0, 0, 0, 0);

      const rows = await currentAdapter.listRatings({
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
    const currentAdapter = adapter();
    if (!currentAdapter || !currentAdapter.isReady()) {
      setStatus(t("status.signInFirst"), true);
      return;
    }

    setStatus(t("status.generatingChart"));
    await refreshWeeklyChart();
    setStatus(t("status.chartUpdated"));
  }

  async function boot(currentAdapter: RatingsStoreAdapter, backend: DataBackend, sequence: number): Promise<void> {
    const isStale = (): boolean => sequence !== bootSequence || selectedBackend() !== backend || adapter() !== currentAdapter;
    setStatus(t("status.waitingForLogin"), false, false);

    try {
      await currentAdapter.init();
      if (isStale()) {
        return;
      }

      if (currentAdapter.getAuthState() === "connected") {
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
    if (!isKnownPathname(location.pathname)) {
      navigate("/hello", { replace: true });
    }
  });

  createEffect(() => {
    if (activeRoute() === "hello" && selectedBackend() !== null) {
      navigate("/log-today", { replace: true });
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
    navigate(pathForRoute(route));
  };

  createEffect(() => {
    if (activeRoute() === "past-data") {
      void generateWeeklyChartOnDemand();
    }
  });

  const handleHelloTab = (): void => {
    navigateToRoute("hello");
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

  const handleSubmitRating = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    const currentAdapter = adapter();
    if (!currentAdapter || !currentAdapter.isReady()) {
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
      await currentAdapter.appendRating({
        timestamp: new Date().toISOString(),
        rating,
      });

      setRatingValue("");
      setStatus(t("status.ratingSaved"));

      if (shouldRefreshWeekChart(routeToTab(activeRoute()))) {
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

  const handleBackendSelection = (backend: DataBackend): void => {
    setSelectedBackend(backend);
    setCookie(BACKEND_COOKIE_NAME, backend, 31536000);
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
              helloLabel="Hello"
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
              onHelloClick={handleHelloTab}
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
              visible={activeRoute() === "past-data"}
              title={t("chart.title")}
              ariaLabel={t("chart.ariaLabel")}
              emptyLabel={t("chart.empty")}
              points={chartPoints()}
              refreshToken={chartRefreshToken()}
            />

            <SettingsView
              visible={activeRoute() === "settings"}
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
