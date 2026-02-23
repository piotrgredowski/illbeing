# illbeing

A static web app (TypeScript -> JavaScript) for GitHub Pages.

## What it does

- Login with Google account.
- Finds Google Sheet named `illbeing` in user's Drive root (or creates it if missing).
- Saves form result with timestamp:
  - `Jak oceniasz swój dzień? 1 - bardzo zły dzień, 10 - najlepszy dzień od dawna`
- Shows second view with chart for last 7 days (daily average, scale 1-10).

## 1. Google Cloud setup

1. Create a Google Cloud project.
2. Enable APIs:
   - Google Drive API
   - Google Sheets API
3. Create OAuth client: `Web application`.
4. Add Authorized JavaScript origins:
   - `http://localhost:5173`
   - `https://<your-user>.github.io`
   - and/or `https://<your-user>.github.io/<repo>`
5. Copy your OAuth Client ID.

## 2. Local setup (Bun)

```bash
bun install
cp .env.example .env.local
# Edit .env.local and set VITE_GOOGLE_CLIENT_ID
bun run dev
```

## 3. Build (Bun)

```bash
bun run build
```

## 4. Deploy to GitHub Pages

- Deploy `dist/` to `gh-pages` branch, or use a GitHub Action.
- For project pages, set base path:
  - build with `VITE_BASE_PATH=/illbeing/ bun run build`
  - or rely on `GITHUB_REPOSITORY` in GitHub Actions.

## Sheet format

The app enforces headers in row 1:

- `timestamp`
- `rating`

Each submission appends one row with ISO timestamp and user rating (1-10).
