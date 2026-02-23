# being better

A static web app (TypeScript -> JavaScript) deployed to GitHub Pages.

## What the app does

- Logs user in with Google OAuth.
- Searches Google Drive root for spreadsheet named `being better`.
- Creates the spreadsheet if missing.
- Saves one record per submission:
  - `timestamp` (ISO datetime)
  - `rating` (1-10)
- Shows chart for last 7 days (daily average).
- Restores session from cookie after page refresh (until token expires).

## Prerequisites

- Bun (recommended runtime/package manager)
- GitHub repository
- Google Cloud project

## 1. Google setup (required for new deployments)

### 1.1 Create project and enable APIs

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create/select project for `being better`.
3. Enable APIs in this exact project:
   - [Google Drive API](https://console.developers.google.com/apis/api/drive.googleapis.com/overview)
   - [Google Sheets API](https://console.developers.google.com/apis/api/sheets.googleapis.com/overview)

### 1.2 Configure OAuth consent screen

1. Go to `APIs & Services` -> `OAuth consent screen`.
2. Choose user type (`External` for public users, `Internal` for Google Workspace-only).
3. Fill required fields:
   - App name
   - User support email
   - Developer contact email
4. Add scopes used by this app:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/spreadsheets`
5. Add your domain info/links (required for production publishing):
   - Homepage URL (GitHub Pages URL)
   - Privacy Policy URL
   - Terms of Service URL (recommended)

### 1.3 Create OAuth client ID

1. Go to `APIs & Services` -> `Credentials` -> `Create credentials` -> `OAuth client ID`.
2. Type: `Web application`.
3. Add **Authorized JavaScript origins**:
   - `http://localhost:5173`
   - `http://127.0.0.1:5173` (optional but recommended)
   - `https://<your-user>.github.io`
4. Save and copy the client ID (`...apps.googleusercontent.com`).

Note: this app uses GIS token popup flow. You do not manually configure `storagerelay://...` redirect.

### 1.4 Testing vs production

- For private/self use: keep app in `Testing` and add your account under `Test users`.
- For public use: switch to `In production` on OAuth consent screen.
- Google may require verification for sensitive scopes before full public availability.

## 2. GitHub setup (required)

### 2.1 Add repository variable

This repo's deploy workflow expects a GitHub **variable** (not secret):

1. Repo -> `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`.
2. Create variable:
   - Name: `VITE_GOOGLE_CLIENT_ID`
   - Value: your Google OAuth client ID

### 2.2 Ensure workflow exists

Workflow file:

- `.github/workflows/deploy-gh-pages.yml`

It does:

- install deps with Bun
- build with:
  - `VITE_GOOGLE_CLIENT_ID` from `${{ vars.VITE_GOOGLE_CLIENT_ID }}`
  - `VITE_BASE_PATH=/<repo-name>/`
- deploy `dist/` to `gh-pages` branch

### 2.3 Enable Pages

1. Repo -> `Settings` -> `Pages`.
2. Source: `Deploy from a branch`.
3. Branch: `gh-pages` and folder `/ (root)`.
4. Save.

After next push to `main`, GitHub Action should publish and Pages URL will be available.

## 3. Local development

1. Create local env file:

```bash
cp .env.example .env.local
```

2. Set value in `.env.local`:

```bash
VITE_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
```

3. Install and run:

```bash
bun install
bun run dev
```

## 4. Build locally

```bash
bun run build
```

## 5. Data format in Google Sheet

Row 1 headers are enforced:

- `timestamp`
- `rating`

Each form submit appends one row to columns `A:B`.

## 6. Troubleshooting

### 403 `accessNotConfigured` / `SERVICE_DISABLED`

Cause: Drive or Sheets API is disabled in selected project.

Fix: enable API in the same project used by OAuth client, then wait a few minutes.

### `origin_mismatch`

Cause: current app origin is not listed in OAuth client authorized JS origins.

Fix: add exact origin (`http://localhost:5173` or your Pages origin).

### Popup closes / `popup_closed`

Cause: user closed auth popup, popup blocked, or browser privacy extension interfered.

Fix: allow popups for site and retry.

### Cookie session not restored

Cause: access token expired.

Fix: click `Zaloguj przez Google` again.

## 7. Data adapters

Frontend now supports pluggable adapters selected by `VITE_DATA_BACKEND`:

- `google` (default): browser-only Google OAuth + Drive/Sheets.
- `local_api`: frontend calls local Bun backend REST API.

### 7.1 Production (GitHub Pages)

Use default `google` mode (or set `VITE_DATA_BACKEND=google`).

### 7.2 Local SQLite mode

1. Set in `.env.local`:

```bash
VITE_DATA_BACKEND=local_api
VITE_LOCAL_API_BASE_URL=http://localhost:8787
PORT=8787
SQLITE_PATH=./data/being-better.sqlite
```

2. Start backend:

```bash
bun run dev:backend
```

3. Start frontend:

```bash
bun run dev
```

## 8. Local backend API

- `GET /api/health` -> `{ ok: true }`
- `POST /api/ratings` body `{ timestamp, rating }` -> `201` or `400`
- `GET /api/ratings?from=<iso>&to=<iso>` -> `{ items: RatingEntry[] }`
- `GET /api/push/public-key` -> `{ publicKey }` (if VAPID configured)
- `POST /api/push/subscriptions` body `{ subscription, locale, timezoneOffsetMinutes, reminderEnabled, reminderTime }` -> `204`

## 9. Background reminder notifications (installed app)

To fire reminder notifications at configured time when app is closed, use Web Push:

1. Generate VAPID keys:

```bash
bun x web-push generate-vapid-keys
```

2. Set backend env vars (`.env.local` for local dev):

```bash
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

3. Set frontend push API base URL:

```bash
VITE_PUSH_API_BASE_URL=http://localhost:8787
```

4. Start backend and frontend:

```bash
bun run dev:backend
bun run dev
```

5. In app `Settings` tab:
   - enable reminder
   - pick reminder time
   - click `Enable notifications`

Reminder delivery notes:
- Works when backend is running and reachable from the installed app.
- Requires HTTPS in production (or localhost for development).
- Without push backend, reminders only appear while app is open.

## 10. Tests

Run all tests:

```bash
bun test
```

## 11. Install app on desktop/mobile (PWA)

- Desktop Chromium/Android: use `Install app` button in the app header (or browser install menu).
- iOS Safari: use Share -> `Add to Home Screen`.
- App is installable from production build (`bun run build`) with web app manifest + service worker enabled.
