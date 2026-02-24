import { render } from "solid-js/web";
import { Router } from "@solidjs/router";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app/App";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container");
}

render(
  () => (
    <Router>
      <App />
    </Router>
  ),
  app,
);

registerSW({ immediate: true });
