import "./styles.css";

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  prompt: string;
  token_type: string;
  scope: string;
};

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

type RatingPoint = {
  dayKey: string;
  dayLabel: string;
  value: number | null;
};

type StoredAuthSession = {
  accessToken: string;
  expiresAtMs: number;
};

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
            create: (params: Record<string, unknown>) => Promise<{ result: { spreadsheetId?: string } }>;
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

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
const SHEET_TITLE = "illbeing";
const AUTH_COOKIE_NAME = "illbeing_auth";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ");

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container");
}

app.innerHTML = `
  <main class="shell">
    <header class="top">
      <h1>illbeing</h1>
      <button id="signin" class="btn btn-primary" disabled>Zaloguj przez Google</button>
    </header>

    <p id="status" class="status">Oczekiwanie na logowanie.</p>

    <nav class="tabs" aria-label="Widoki aplikacji">
      <button id="tab-entry" class="tab tab-active" disabled>Dodaj ocenę</button>
      <button id="tab-week" class="tab" disabled>Ostatni tydzień</button>
    </nav>

    <section id="entry-view" class="view">
      <form id="rating-form" class="card" autocomplete="off">
        <label for="rating" class="label">
          Jak oceniasz swój dzień? 1 - bardzo zły dzień, 10 - najlepszy dzień od dawna
        </label>
        <input id="rating" name="rating" type="number" min="1" max="10" step="1" required />
        <button class="btn btn-primary" type="submit">Zapisz ocenę</button>
      </form>
    </section>

    <section id="week-view" class="view hidden">
      <div class="card">
        <p class="label">Oceny z ostatnich 7 dni</p>
        <canvas id="chart" width="720" height="320" aria-label="Wykres ocen z ostatnich 7 dni"></canvas>
        <p id="chart-empty" class="status hidden">Brak danych z ostatniego tygodnia.</p>
      </div>
    </section>
  </main>
`;

const statusEl = must<HTMLParagraphElement>("#status");
const signInBtn = must<HTMLButtonElement>("#signin");
const entryTab = must<HTMLButtonElement>("#tab-entry");
const weekTab = must<HTMLButtonElement>("#tab-week");
const entryView = must<HTMLElement>("#entry-view");
const weekView = must<HTMLElement>("#week-view");
const ratingForm = must<HTMLFormElement>("#rating-form");
const ratingInput = must<HTMLInputElement>("#rating");
const chartCanvas = must<HTMLCanvasElement>("#chart");
const chartEmpty = must<HTMLParagraphElement>("#chart-empty");

let tokenClient: GoogleTokenClient | null = null;
let hasGrantedToken = false;
let currentSpreadsheetId: string | null = null;

signInBtn.addEventListener("click", onSignInClick);

void boot();

async function boot(): Promise<void> {
  if (!GOOGLE_CLIENT_ID) {
    setStatus("Ustaw VITE_GOOGLE_CLIENT_ID w środowisku (np. .env.local).", true);
    signInBtn.disabled = true;
    return;
  }

  try {
    await Promise.all([waitForGoogle(), waitForGapi()]);
    await loadGoogleApis();
    tokenClient = initTokenClient();
    await restoreSessionFromCookie();

    signInBtn.disabled = false;
    entryTab.addEventListener("click", () => showTab("entry"));
    weekTab.addEventListener("click", async () => {
      showTab("week");
      await refreshWeeklyChart();
    });
    ratingForm.addEventListener("submit", onSubmitRating);

    setStatus("Kliknij 'Zaloguj przez Google'.");
  } catch (error) {
    console.error(error);
    setStatus("Nie udało się uruchomić klienta Google API.", true);
  }
}

function initTokenClient(): GoogleTokenClient {
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new Error("Google Identity Services unavailable");
  }

  return oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: async (response) => {
      try {
        if (!response.access_token) {
          throw new Error("Missing access token");
        }

        const expiresAtMs = Date.now() + response.expires_in * 1000;
        persistAuthSession({
          accessToken: response.access_token,
          expiresAtMs,
        });
        window.gapi?.client.setToken({ access_token: response.access_token });
        hasGrantedToken = true;
        currentSpreadsheetId = await ensureSpreadsheet();

        setConnectedUiState();
        setStatus("Połączono z Google. Możesz zapisywać dane.");
      } catch (error) {
        console.error(error);
        clearAuthSession();
        setStatus("Logowanie powiodło się, ale inicjalizacja arkusza nie powiodła się.", true);
      }
    },
    error_callback: (error) => {
      console.error(error);
      setStatus("Autoryzacja Google została odrzucona lub przerwana.", true);
    },
  });
}

function onSignInClick(): void {
  if (!tokenClient) {
    setStatus("Klient OAuth nie jest gotowy.", true);
    return;
  }

  setStatus("Otwieranie logowania Google...");
  tokenClient.requestAccessToken({ prompt: hasGrantedToken ? "" : "consent" });
}

async function onSubmitRating(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  if (!currentSpreadsheetId) {
    setStatus("Najpierw zaloguj się przez Google.", true);
    return;
  }

  const rawValue = ratingInput.value.trim();
  const rating = Number(rawValue);

  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    setStatus("Podaj liczbę całkowitą od 1 do 10.", true);
    return;
  }

  try {
    setStatus("Zapisywanie oceny...");
    await window.gapi?.client.sheets.spreadsheets.values.append({
      spreadsheetId: currentSpreadsheetId,
      range: "A:B",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      resource: {
        values: [[new Date().toISOString(), String(rating)]],
      },
    });

    ratingForm.reset();
    setStatus("Ocena zapisana.");

    if (!weekView.classList.contains("hidden")) {
      await refreshWeeklyChart();
    }
  } catch (error) {
    console.error(error);
    setStatus("Nie udało się zapisać oceny do Google Sheets.", true);
  }
}

async function restoreSessionFromCookie(): Promise<void> {
  const session = readAuthSession();
  if (!session) {
    return;
  }

  if (Date.now() >= session.expiresAtMs) {
    clearAuthSession();
    return;
  }

  try {
    window.gapi?.client.setToken({ access_token: session.accessToken });
    hasGrantedToken = true;
    currentSpreadsheetId = await ensureSpreadsheet();
    setConnectedUiState();
    setStatus("Przywrócono sesję z poprzedniego logowania.");
  } catch (error) {
    console.error(error);
    clearAuthSession();
    window.gapi?.client.setToken(null);
  }
}

function setConnectedUiState(): void {
  entryTab.disabled = false;
  weekTab.disabled = false;
  signInBtn.textContent = "Połączono";
  signInBtn.disabled = true;
}

async function ensureSpreadsheet(): Promise<string> {
  const existingId = await findSpreadsheetIdByName(SHEET_TITLE);
  if (existingId) {
    await ensureHeaders(existingId);
    return existingId;
  }

  const createResponse = await window.gapi?.client.sheets.spreadsheets.create({
    properties: { title: SHEET_TITLE },
    sheets: [{ properties: { title: "Sheet1" } }],
  });

  const spreadsheetId = createResponse?.result.spreadsheetId;
  if (!spreadsheetId) {
    throw new Error("Sheets create returned no spreadsheetId");
  }

  await ensureHeaders(spreadsheetId);
  return spreadsheetId;
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

  const first = files[0];
  return first.id ?? null;
}

async function ensureHeaders(spreadsheetId: string): Promise<void> {
  const response = await window.gapi?.client.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "A1:B1",
  });

  const row = response?.result.values?.[0] ?? [];
  const hasHeaders = row[0] === "timestamp" && row[1] === "rating";
  if (hasHeaders) {
    return;
  }

  await window.gapi?.client.sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "A1:B1",
    valueInputOption: "RAW",
    resource: {
      values: [["timestamp", "rating"]],
    },
  });
}

async function refreshWeeklyChart(): Promise<void> {
  if (!currentSpreadsheetId) {
    return;
  }

  try {
    const response = await window.gapi?.client.sheets.spreadsheets.values.get({
      spreadsheetId: currentSpreadsheetId,
      range: "A2:B",
    });

    const rows = response?.result.values ?? [];
    const points = buildLastWeekSeries(rows);
    drawWeeklyChart(points);
  } catch (error) {
    console.error(error);
    setStatus("Nie udało się odczytać danych do wykresu.", true);
  }
}

function buildLastWeekSeries(rows: string[][]): RatingPoint[] {
  const end = startOfDay(new Date());
  const start = new Date(end);
  start.setDate(start.getDate() - 6);

  const buckets = new Map<string, number[]>();

  for (const row of rows) {
    const timestamp = row[0];
    const rawRating = row[1];
    if (!timestamp || !rawRating) {
      continue;
    }

    const date = new Date(timestamp);
    const rating = Number(rawRating);
    if (Number.isNaN(date.getTime()) || !Number.isFinite(rating)) {
      continue;
    }

    const day = startOfDay(date);
    if (day < start || day > end) {
      continue;
    }

    const key = toDayKey(day);
    const values = buckets.get(key) ?? [];
    values.push(rating);
    buckets.set(key, values);
  }

  const points: RatingPoint[] = [];
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = toDayKey(day);
    const values = buckets.get(key);

    points.push({
      dayKey: key,
      dayLabel: day.toLocaleDateString("pl-PL", { weekday: "short", day: "2-digit", month: "2-digit" }),
      value: values && values.length > 0 ? average(values) : null,
    });
  }

  return points;
}

function drawWeeklyChart(points: RatingPoint[]): void {
  const ctx = chartCanvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const hasData = points.some((point) => point.value !== null);
  chartEmpty.classList.toggle("hidden", hasData);

  const width = chartCanvas.width;
  const height = chartCanvas.height;
  const left = 52;
  const right = 24;
  const top = 20;
  const bottom = 52;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#d8d8d8";
  ctx.lineWidth = 1;

  for (let yTick = 1; yTick <= 10; yTick += 1) {
    const y = top + plotHeight - ((yTick - 1) / 9) * plotHeight;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();

    if (yTick % 3 === 1 || yTick === 10) {
      ctx.fillStyle = "#666";
      ctx.font = "12px system-ui";
      ctx.textAlign = "right";
      ctx.fillText(String(yTick), left - 8, y + 4);
    }
  }

  const xForIndex = (index: number): number => left + (index / 6) * plotWidth;
  const yForValue = (value: number): number => top + plotHeight - ((value - 1) / 9) * plotHeight;

  ctx.strokeStyle = "#1f6d8a";
  ctx.lineWidth = 2;
  ctx.beginPath();

  let started = false;
  points.forEach((point, index) => {
    if (point.value === null) {
      started = false;
      return;
    }

    const x = xForIndex(index);
    const y = yForValue(point.value);

    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  points.forEach((point, index) => {
    const x = xForIndex(index);

    if (point.value !== null) {
      const y = yForValue(point.value);
      ctx.fillStyle = "#1f6d8a";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#123b4c";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(point.value.toFixed(1), x, y - 8);
    }

    ctx.fillStyle = "#444";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(point.dayLabel, x, height - 20);
  });
}

function showTab(tab: "entry" | "week"): void {
  const isEntry = tab === "entry";
  entryView.classList.toggle("hidden", !isEntry);
  weekView.classList.toggle("hidden", isEntry);
  entryTab.classList.toggle("tab-active", isEntry);
  weekTab.classList.toggle("tab-active", !isEntry);
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("status-error", isError);
}

async function loadGoogleApis(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const gapi = window.gapi;
    if (!gapi) {
      reject(new Error("gapi unavailable"));
      return;
    }

    gapi.load("client", () => {
      void Promise.all([
        gapi.client.load("drive", "v3"),
        gapi.client.load("sheets", "v4"),
      ])
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

function escapeDriveString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function persistAuthSession(session: StoredAuthSession): void {
  const payload = encodeURIComponent(JSON.stringify(session));
  const maxAgeSeconds = Math.max(0, Math.floor((session.expiresAtMs - Date.now()) / 1000));
  document.cookie = `${AUTH_COOKIE_NAME}=${payload}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`;
}

function readAuthSession(): StoredAuthSession | null {
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

function clearAuthSession(): void {
  document.cookie = `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
}

function readCookie(name: string): string | null {
  const parts = document.cookie.split("; ");
  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    if (eqIndex < 0) {
      continue;
    }

    const key = part.slice(0, eqIndex);
    if (key === name) {
      return part.slice(eqIndex + 1);
    }
  }
  return null;
}

function average(values: number[]): number {
  const sum = values.reduce((acc, value) => acc + value, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function toDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}
