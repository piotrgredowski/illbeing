import { deleteCookie, readCookie, setCookie } from "../../session/cookies";
import { getEnvVar } from "../../config/env";
import type { AuthState, RatingEntry, RatingsRange, RatingsStoreAdapter } from "../types";

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
};

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

type StoredAuthSession = {
  accessToken: string;
  expiresAtMs: number;
};

const GOOGLE_CLIENT_ID = getEnvVar("VITE_GOOGLE_CLIENT_ID") ?? "";
const SHEET_TITLE = "being better";
const DATA_SHEET_TITLE = "data";
const CONFIG_SHEET_TITLE = "config";
const AUTH_COOKIE_NAME = "being_better_auth";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ");

export class MissingGoogleClientIdError extends Error {
  constructor() {
    super("Missing VITE_GOOGLE_CLIENT_ID");
  }
}

export class GoogleDriveRatingsAdapter implements RatingsStoreAdapter {
  private tokenClient: GoogleTokenClient | null = null;
  private hasGrantedToken = false;
  private currentSpreadsheetId: string | null = null;
  private authState: AuthState = "initializing";
  private pendingSignIn: {
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;

  async init(): Promise<void> {
    if (!GOOGLE_CLIENT_ID) {
      this.authState = "needs_login";
      throw new MissingGoogleClientIdError();
    }

    await Promise.all([waitForGoogle(), waitForGapi()]);
    await loadGoogleApis();

    this.tokenClient = this.initTokenClient();
    await this.restoreSessionFromCookie();

    if (!this.currentSpreadsheetId) {
      this.authState = "needs_login";
    }
  }

  async requestSignIn(): Promise<void> {
    if (!this.tokenClient) {
      throw new Error("OAuth client is not ready");
    }

    if (this.pendingSignIn) {
      throw new Error("Sign in already in progress");
    }

    this.authState = "initializing";

    await new Promise<void>((resolve, reject) => {
      this.pendingSignIn = { resolve, reject };
      this.tokenClient?.requestAccessToken({ prompt: this.hasGrantedToken ? "" : "consent" });
    });
  }

  async appendRating(entry: RatingEntry): Promise<void> {
    if (!this.currentSpreadsheetId) {
      throw new Error("Sign in required");
    }

    await window.gapi?.client.sheets.spreadsheets.values.append({
      spreadsheetId: this.currentSpreadsheetId,
      range: `${DATA_SHEET_TITLE}!A:B`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      resource: {
        values: [[entry.timestamp, String(entry.rating)]],
      },
    });
  }

  async listRatings(range: RatingsRange): Promise<RatingEntry[]> {
    if (!this.currentSpreadsheetId) {
      throw new Error("Sign in required");
    }

    const response = await window.gapi?.client.sheets.spreadsheets.values.get({
      spreadsheetId: this.currentSpreadsheetId,
      range: `${DATA_SHEET_TITLE}!A2:B`,
    });

    const fromTime = new Date(range.fromIso).getTime();
    const toTime = new Date(range.toIso).getTime();
    const rows = response?.result.values ?? [];

    return rows
      .map((row) => ({ timestamp: row[0], rating: Number(row[1]) }))
      .filter((row) => Boolean(row.timestamp) && Number.isFinite(row.rating))
      .filter((row) => {
        const rowTime = new Date(row.timestamp).getTime();
        return Number.isFinite(rowTime) && rowTime >= fromTime && rowTime <= toTime;
      });
  }

  isReady(): boolean {
    return this.currentSpreadsheetId !== null;
  }

  getAuthState(): AuthState {
    return this.authState;
  }

  private initTokenClient(): GoogleTokenClient {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      throw new Error("Google Identity Services unavailable");
    }

    return oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (response) => {
        void this.handleTokenResponse(response);
      },
      error_callback: (error) => {
        this.authState = "needs_login";
        const pending = this.pendingSignIn;
        this.pendingSignIn = null;
        pending?.reject(error);
      },
    });
  }

  private async handleTokenResponse(response: GoogleTokenResponse): Promise<void> {
    const pending = this.pendingSignIn;

    try {
      if (!response.access_token) {
        throw new Error("Missing access token");
      }

      const expiresAtMs = Date.now() + response.expires_in * 1000;
      this.persistAuthSession({
        accessToken: response.access_token,
        expiresAtMs,
      });

      window.gapi?.client.setToken({ access_token: response.access_token });
      this.hasGrantedToken = true;
      this.currentSpreadsheetId = await this.ensureSpreadsheet();
      this.authState = "connected";
      pending?.resolve();
    } catch (error) {
      this.clearAuthSession();
      this.authState = "needs_login";
      pending?.reject(error);
    } finally {
      this.pendingSignIn = null;
    }
  }

  private async restoreSessionFromCookie(): Promise<void> {
    const session = this.readAuthSession();
    if (!session) {
      return;
    }

    if (Date.now() >= session.expiresAtMs) {
      this.clearAuthSession();
      return;
    }

    try {
      window.gapi?.client.setToken({ access_token: session.accessToken });
      this.hasGrantedToken = true;
      this.currentSpreadsheetId = await this.ensureSpreadsheet();
      this.authState = "connected";
    } catch {
      this.clearAuthSession();
      window.gapi?.client.setToken(null);
      this.authState = "needs_login";
    }
  }

  private async ensureSpreadsheet(): Promise<string> {
    const existingId = await findSpreadsheetIdByName(SHEET_TITLE);
    if (existingId) {
      await ensureRequiredSheets(existingId);
      await ensureHeaders(existingId);
      return existingId;
    }

    const createResponse = await window.gapi?.client.sheets.spreadsheets.create({
      properties: { title: SHEET_TITLE },
      sheets: [{ properties: { title: DATA_SHEET_TITLE } }, { properties: { title: CONFIG_SHEET_TITLE } }],
    });

    const spreadsheetId = createResponse?.result.spreadsheetId;
    if (!spreadsheetId) {
      throw new Error("Sheets create returned no spreadsheetId");
    }

    await ensureHeaders(spreadsheetId);
    return spreadsheetId;
  }

  private persistAuthSession(session: StoredAuthSession): void {
    const payload = encodeURIComponent(JSON.stringify(session));
    const maxAgeSeconds = (session.expiresAtMs - Date.now()) / 1000;
    setCookie(AUTH_COOKIE_NAME, payload, maxAgeSeconds);
  }

  private readAuthSession(): StoredAuthSession | null {
    const raw = readCookie(AUTH_COOKIE_NAME);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<StoredAuthSession>;
      if (!parsed.accessToken || typeof parsed.expiresAtMs !== "number") {
        return null;
      }
      return {
        accessToken: parsed.accessToken,
        expiresAtMs: parsed.expiresAtMs,
      };
    } catch {
      return null;
    }
  }

  private clearAuthSession(): void {
    deleteCookie(AUTH_COOKIE_NAME);
  }
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
            error_callback?: (error: unknown) => void;
          }) => GoogleTokenClient;
        };
      };
    };
    gapi?: {
      load: (name: string, callback: () => void) => void;
      client: {
        setToken: (token: { access_token: string } | null) => void;
        load: (apiName: string, version: string) => Promise<void>;
        drive: {
          files: {
            list: (params: Record<string, unknown>) => Promise<{ result: { files?: Array<{ id?: string; createdTime?: string }> } }>;
          };
        };
        sheets: {
          spreadsheets: {
            get: (params: Record<string, unknown>) => Promise<{ result: { sheets?: Array<{ properties?: { title?: string } }> } }>;
            create: (params: Record<string, unknown>) => Promise<{ result: { spreadsheetId?: string } }>;
            batchUpdate: (params: Record<string, unknown>) => Promise<unknown>;
            values: {
              get: (params: Record<string, unknown>) => Promise<{ result: { values?: string[][] } }>;
              update: (params: Record<string, unknown>) => Promise<unknown>;
              append: (params: Record<string, unknown>) => Promise<unknown>;
            };
          };
        };
      };
    };
  }
}

async function loadGoogleApis(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const gapi = window.gapi;
    if (!gapi) {
      reject(new Error("gapi unavailable"));
      return;
    }

    gapi.load("client", () => {
      void Promise.all([gapi.client.load("drive", "v3"), gapi.client.load("sheets", "v4")])
        .then(() => resolve())
        .catch((error) => reject(error));
    });
  });
}

function waitForGoogle(): Promise<void> {
  return waitFor(() => Boolean(window.google?.accounts?.oauth2));
}

function waitForGapi(): Promise<void> {
  return waitFor(() => Boolean(window.gapi?.load));
}

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutMs = 15000;
    const started = Date.now();

    const tick = (): void => {
      if (check()) {
        resolve();
        return;
      }

      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timeout while loading external Google scripts"));
        return;
      }

      window.setTimeout(tick, 50);
    };

    tick();
  });
}

async function findSpreadsheetIdByName(name: string): Promise<string | null> {
  const response = await window.gapi?.client.drive.files.list({
    q: `name = '${escapeDriveString(name)}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and 'root' in parents`,
    spaces: "drive",
    fields: "files(id, createdTime)",
    orderBy: "createdTime asc",
    pageSize: 10,
  });

  const files = response?.result.files;
  if (!files?.length) {
    return null;
  }

  return files[0]?.id ?? null;
}

async function ensureHeaders(spreadsheetId: string): Promise<void> {
  const response = await window.gapi?.client.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${DATA_SHEET_TITLE}!A1:B1`,
  });

  const row = response?.result.values?.[0] ?? [];
  const hasHeaders = row[0] === "timestamp" && row[1] === "rating";
  if (hasHeaders) {
    return;
  }

  await window.gapi?.client.sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${DATA_SHEET_TITLE}!A1:B1`,
    valueInputOption: "RAW",
    resource: {
      values: [["timestamp", "rating"]],
    },
  });
}

async function ensureRequiredSheets(spreadsheetId: string): Promise<void> {
  const response = await window.gapi?.client.sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });

  const existingTitles = new Set(
    (response?.result.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => typeof title === "string"),
  );

  const requests: Array<{ addSheet: { properties: { title: string } } }> = [];
  if (!existingTitles.has(DATA_SHEET_TITLE)) {
    requests.push({ addSheet: { properties: { title: DATA_SHEET_TITLE } } });
  }
  if (!existingTitles.has(CONFIG_SHEET_TITLE)) {
    requests.push({ addSheet: { properties: { title: CONFIG_SHEET_TITLE } } });
  }

  if (requests.length === 0) {
    return;
  }

  await window.gapi?.client.sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests },
  });
}

function escapeDriveString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
