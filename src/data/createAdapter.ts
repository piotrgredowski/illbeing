import { GoogleDriveRatingsAdapter } from "./adapters/googleDrive";
import { LocalApiRatingsAdapter } from "./adapters/localApi";
import { getEnvVar } from "../config/env";
import type { RatingsStoreAdapter } from "./types";

export type DataBackend = "google" | "local_api";

export function resolveDataBackend(value: string | undefined): DataBackend {
  if (value === "local_api") {
    return "local_api";
  }
  return "google";
}

export function createAdapter(backend?: DataBackend): RatingsStoreAdapter {
  const selected = backend ?? resolveDataBackend(getEnvVar("VITE_DATA_BACKEND"));

  if (selected === "local_api") {
    const baseUrl = getEnvVar("VITE_LOCAL_API_BASE_URL") ?? "http://localhost:8787";
    return new LocalApiRatingsAdapter({ baseUrl });
  }

  return new GoogleDriveRatingsAdapter();
}
