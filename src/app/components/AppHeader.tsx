
import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import type { I18nKey, Locale } from "../../i18n";
import type { Theme } from "../../theme";

type Translator = (key: I18nKey, vars?: Record<string, string>) => string;

export function AppHeader(props: {
  locale: Locale;
  supportedLocales: Locale[];
  t: Translator;
  theme: Theme;
  pageLabel: string;
  isConnected: boolean;
  showSignIn: boolean;
  signInLabel: string;
  accountLabel: string;
  signInDisabled: boolean;
  activeTab: "entry" | "week" | "settings" | "hello";
  entryLabel: string;
  weekLabel: string;
  settingsLabel: string;
  entryDisabled: boolean;
  weekDisabled: boolean;
  installLabel: string;
  showInstall: boolean;
  installDisabled: boolean;
  onLocaleChange: JSX.EventHandler<HTMLSelectElement, Event>;
  onThemeChange: JSX.EventHandler<HTMLSelectElement, Event>;
  onSignIn: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onInstall: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onTitleClick: JSX.EventHandler<HTMLHeadingElement, MouseEvent>;
  onEntryClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onWeekClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onSettingsClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menuEl: HTMLDivElement | undefined;
  let menuButtonEl: HTMLButtonElement | undefined;

  createEffect(() => {
    if (!menuOpen()) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (menuEl?.contains(target) || menuButtonEl?.contains(target)) {
        return;
      }

      setMenuOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonEl?.focus();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  return (
    <header class="top">
      <div class="top-main">
        <div class="title-with-page">
          <h1 id="title" onClick={props.onTitleClick}>
            {props.t("app.title")}
          </h1>
          <span class="page-name">{props.pageLabel}</span>
        </div>
        <div class="top-actions-right">
          <Show when={props.showInstall}>
            <button
              id="install-app"
              class="btn"
              type="button"
              aria-label={props.installLabel}
              disabled={props.installDisabled}
              onClick={props.onInstall}
            >
              <span class="install-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 3v10" />
                  <path d="m8 9 4 4 4-4" />
                  <path d="M4 15v4h16v-4" />
                </svg>
              </span>
              <span class="install-label">{props.installLabel}</span>
            </button>
          </Show>
          <button
            id="menu-toggle"
            class="btn menu-toggle"
            type="button"
            aria-label={props.t("menu.toggle")}
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            aria-controls="top-menu"
            ref={menuButtonEl}
            onClick={() => {
              setMenuOpen((value) => !value);
            }}
          >
            <span class="menu-line" />
            <span class="menu-line" />
            <span class="menu-line" />
          </button>
        </div>
      </div>
      <Show when={menuOpen()}>
        <div
          id="top-menu"
          class="top-menu"
          role="menu"
          ref={menuEl}
        >
          <div class="menu-item">
            <span class="menu-label">{props.t("tabs.ariaLabel")}</span>
            <div class="menu-nav">
              <button
                id="menu-tab-entry"
                class={`btn${props.activeTab === "entry" ? " tab-active" : ""}`}
                type="button"
                disabled={props.entryDisabled}
                onClick={(event) => {
                  props.onEntryClick(event);
                  setMenuOpen(false);
                }}
              >
                {props.entryLabel}
              </button>
              <button
                id="menu-tab-week"
                class={`btn${props.activeTab === "week" ? " tab-active" : ""}`}
                type="button"
                disabled={props.weekDisabled}
                onClick={(event) => {
                  props.onWeekClick(event);
                  setMenuOpen(false);
                }}
              >
                {props.weekLabel}
              </button>
              <button
                id="menu-tab-settings"
                class={`btn${props.activeTab === "settings" ? " tab-active" : ""}`}
                type="button"
                onClick={(event) => {
                  props.onSettingsClick(event);
                  setMenuOpen(false);
                }}
              >
                {props.settingsLabel}
              </button>
            </div>
          </div>

          <div class="menu-item">
            <span class="menu-label">{props.t("locale.label")}</span>
            <select
              id="locale"
              class="locale-select menu-select"
              value={props.locale}
              onChange={(event) => {
                props.onLocaleChange(event);
                setMenuOpen(false);
              }}
            >
              {props.supportedLocales.map((item) => (
                <option value={item}>{item.toUpperCase()}</option>
              ))}
            </select>
          </div>

          <div class="menu-item">
            <span class="menu-label">{props.t("menu.theme")}</span>
            <select
              id="theme"
              class="locale-select menu-select"
              value={props.theme}
              onChange={(event) => {
                props.onThemeChange(event);
                setMenuOpen(false);
              }}
            >
              <option value="light">{props.t("theme.light")}</option>
              <option value="dark">{props.t("theme.dark")}</option>
            </select>
          </div>

          {props.isConnected && (
            <div class="menu-item menu-status" aria-label={props.accountLabel}>
              <span class="menu-label">{props.t("menu.account")}</span>
              <span class="status-dot" aria-hidden="true" />
              <span class="menu-value">{props.accountLabel}</span>
            </div>
          )}

          {props.showSignIn && (
            <button
              id="signin"
              class="btn btn-primary btn-signin menu-primary"
              type="button"
              disabled={props.signInDisabled}
              onClick={(event) => {
                props.onSignIn(event);
                setMenuOpen(false);
              }}
            >
              {props.signInLabel}
            </button>
          )}
        </div>
      </Show>
    </header>
  );
}
