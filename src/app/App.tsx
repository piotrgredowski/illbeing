
import { createSignal, onMount } from "solid-js";
import { buildLastWeekSeries, type RatingPoint } from "../chart/weekly";
import { createAdapter, resolveDataBackend, type DataBackend } from "../data/createAdapter";
import { createI18n, detectInitialLocale, parseLocale, persistLocale, SUPPORTED_LOCALES, toBcp47Locale, type I18nKey } from "../i18n";
import { applyTheme, detectInitialTheme, persistTheme, themeLabelKey, type Theme } from "../theme";
import { getEnvVar } from "../config/env";
import { parseRatingInput, resolveInitFailureStatus, resolveSignInLabelKey, shouldRefreshWeekChart, toggleTheme } from "./logic";
import { AppHeader } from "./components/AppHeader";
import { EntryForm } from "./components/EntryForm";
import { StatusBanner } from "./components/StatusBanner";
import { Tabs } from "./components/Tabs";
import { WeekChartCard } from "./components/WeekChartCard";

export function App() {
  const initialLocale = detectInitialLocale();
  const i18n = createI18n(initialLocale);

  const [locale, setLocale] = createSignal(initialLocale);
  const [theme, setTheme] = createSignal<Theme>(detectInitialTheme());
  const [statusText, setStatusText] = createSignal(i18n.t("status.waitingForLogin"));
  const [statusIsError, setStatusIsError] = createSignal(false);
  const [isReady, setIsReady] = createSignal(false);
  const [signInEnabled, setSignInEnabled] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<"entry" | "week">("entry");
  const [ratingValue, setRatingValue] = createSignal("");
  const [chartPoints, setChartPoints] = createSignal<RatingPoint[]>([]);
  const [chartRefreshToken, setChartRefreshToken] = createSignal(0);

  const backend: DataBackend = resolveDataBackend(getEnvVar("VITE_DATA_BACKEND"));
  const adapter = createAdapter(backend);
  const t = (key: I18nKey, vars?: Record<string, string>) => i18n.t(key, vars);

  applyTheme(theme());

  const setStatus = (text: string, isError = false): void => {
    setStatusText(text);
    setStatusIsError(isError);
  };

  const setConnectedUiState = (): void => {
    setIsReady(true);
    setSignInEnabled(false);
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
    setStatus(t("status.waitingForLogin"));

    try {
      await adapter.init();

      if (adapter.getAuthState() === "connected") {
        setConnectedUiState();
        setStatus(backend === "google" ? t("status.sessionRestored") : t("status.connected"));
        return;
      }

      setSignInEnabled(true);
      setStatus(t("status.clickSignIn", { signIn: t("auth.signIn") }));
    } catch (error) {
      console.error(error);
      const failure = resolveInitFailureStatus(backend, error);
      setStatus(t(failure.key), failure.isError);
      setSignInEnabled(false);
    }
  }

  onMount(() => {
    void boot();
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

  const handleThemeToggle = async (): Promise<void> => {
    const nextTheme: Theme = toggleTheme(theme());
    applyTheme(nextTheme);
    persistTheme(nextTheme);
    setTheme(nextTheme);
    setChartRefreshToken((value) => value + 1);

    if (shouldRefreshWeekChart(activeTab())) {
      await refreshWeeklyChart();
    }
  };

  return (
    <main class="shell">
      <AppHeader
        locale={locale()}
        supportedLocales={SUPPORTED_LOCALES}
        t={t}
        themeToggleLabel={t("theme.toggle", { theme: t(themeLabelKey(theme())) })}
        signInLabel={t(resolveSignInLabelKey(isReady()))}
        signInDisabled={isReady() || !signInEnabled()}
        onLocaleChange={(event) => {
          void handleLocaleChange(event);
        }}
        onThemeToggle={() => {
          void handleThemeToggle();
        }}
        onSignIn={() => {
          void handleSignIn();
        }}
      />

      <StatusBanner text={statusText()} isError={statusIsError()} />

      <Tabs
        activeTab={activeTab()}
        ariaLabel={t("tabs.ariaLabel")}
        entryLabel={t("tabs.entry")}
        weekLabel={t("tabs.week")}
        entryDisabled={!isReady()}
        weekDisabled={!isReady()}
        onEntryClick={handleEntryTab}
        onWeekClick={() => {
          void handleWeekTab();
        }}
      />

      <EntryForm
        visible={activeTab() === "entry"}
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
    </main>
  );
}
