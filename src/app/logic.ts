import type { DataBackend } from "../data/createAdapter";
import { MissingGoogleClientIdError } from "../data/adapters/googleDrive";
import type { I18nKey } from "../i18n";
import type { ThemePreference } from "../theme";

export function parseRatingInput(rawValue: string): number | null {
  const rating = Number(rawValue.trim());
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    return null;
  }
  return rating;
}

export function shouldRefreshWeekChart(activeTab: "entry" | "week" | "settings"): boolean {
  return activeTab === "week";
}

export function resolveSignInLabelKey(isReady: boolean): "auth.connected" | "auth.signIn" {
  return isReady ? "auth.connected" : "auth.signIn";
}

export function resolveInitFailureStatus(backend: DataBackend, error: unknown): { key: I18nKey; isError: boolean } {
  if (error instanceof MissingGoogleClientIdError) {
    return { key: "status.missingClientId", isError: true };
  }

  if (backend === "local_api") {
    return { key: "status.localApiUnavailable", isError: true };
  }

  return { key: "status.googleClientInitFailed", isError: true };
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === "light") {
    return "dark";
  }
  if (preference === "dark") {
    return "system";
  }
  return "light";
}
