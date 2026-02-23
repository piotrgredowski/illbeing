
import type { JSX } from "solid-js";
import type { I18nKey, Locale } from "../../i18n";

type Translator = (key: I18nKey, vars?: Record<string, string>) => string;

export function AppHeader(props: {
  locale: Locale;
  supportedLocales: Locale[];
  t: Translator;
  themeToggleLabel: string;
  signInLabel: string;
  signInDisabled: boolean;
  onLocaleChange: JSX.EventHandler<HTMLSelectElement, Event>;
  onThemeToggle: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onSignIn: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
}): JSX.Element {
  return (
    <header class="top">
      <h1 id="title">{props.t("app.title")}</h1>
      <div class="top-actions">
        <label for="locale" id="locale-label" class="locale-label">
          {props.t("locale.label")}
        </label>
        <select id="locale" class="locale-select" aria-labelledby="locale-label" value={props.locale} onChange={props.onLocaleChange}>
          {props.supportedLocales.map((item) => (
            <option value={item}>{item.toUpperCase()}</option>
          ))}
        </select>
        <button id="theme-toggle" class="btn" type="button" onClick={props.onThemeToggle}>
          {props.themeToggleLabel}
        </button>
        <button id="signin" class="btn btn-primary" type="button" disabled={props.signInDisabled} onClick={props.onSignIn}>
          {props.signInLabel}
        </button>
      </div>
    </header>
  );
}
