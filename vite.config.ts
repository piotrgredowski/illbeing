import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

const explicitBase = process.env.VITE_BASE_PATH;
const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];

const base = explicitBase ?? (repoName ? `/${repoName}/` : "/");

export default defineConfig({
  base,
  plugins: [solidPlugin()],
});
