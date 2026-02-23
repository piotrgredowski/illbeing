import { render } from "solid-js/web";
import { App } from "./app/App";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container");
}

render(() => <App />, app);
