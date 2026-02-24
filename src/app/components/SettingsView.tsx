import type { JSX } from "solid-js";
import type { Locale } from "../../i18n";
import type { DataBackend } from "../../data/createAdapter";
import type { ThemePreference } from "../../theme";

export function SettingsView(props: {
  visible: boolean;
  languageLabel: string;
  themeLabel: string;
  storageLocationLabel: string;
  storageGoogleLabel: string;
  storageIndexedDbLabel: string;
  storageHelpText: string;
  storageGoogleSignInLabel: string;
  showStorageGoogleSignIn: boolean;
  storageGoogleSignInDisabled: boolean;
  reminderEnabledLabel: string;
  reminderTimeLabel: string;
  reminderPermissionLabel: string;
  reminderPermissionStateLabel: string;
  themeOptionLightLabel: string;
  themeOptionDarkLabel: string;
  themeOptionSystemLabel: string;
  locale: Locale;
  supportedLocales: Locale[];
  themePreference: ThemePreference;
  storageBackend: DataBackend;
  storageBackendValue: DataBackend;
  showReminderSettings: boolean;
  reminderEnabled: boolean;
  reminderTime: string;
  notificationsEnabled: boolean;
  notificationsUnsupported: boolean;
  onLocaleChange: JSX.EventHandler<HTMLSelectElement, Event>;
  onThemePreferenceChange: JSX.EventHandler<HTMLSelectElement, Event>;
  onStorageBackendChange: JSX.EventHandler<HTMLSelectElement, Event>;
  onStorageGoogleSignIn: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onReminderEnabledChange: JSX.EventHandler<HTMLInputElement, Event>;
  onReminderTimeChange: JSX.EventHandler<HTMLInputElement, Event>;
  onNotificationsEnabledChange: JSX.EventHandler<HTMLInputElement, Event>;
}): JSX.Element {
  return (
    <section id="settings-view" class={`view${props.visible ? "" : " hidden"}`}>
      <div class="card settings-card">
        {props.storageBackend === "google" ? (
          <>
            <div class="setting-block">
              <div class="setting-row">
                <label for="settings-language" class="label">
                  {props.languageLabel}
                </label>
                <select id="settings-language" class="locale-select setting-control" value={props.locale} onChange={props.onLocaleChange}>
                  {props.supportedLocales.map((item) => (
                    <option value={item}>{item.toUpperCase()}</option>
                  ))}
                </select>
              </div>
            </div>

            <div class="setting-block">
              <div class="setting-row">
                <label for="settings-theme" class="label">
                  {props.themeLabel}
                </label>
                <select id="settings-theme" class="locale-select setting-control" value={props.themePreference} onChange={props.onThemePreferenceChange}>
                  <option value="light">{props.themeOptionLightLabel}</option>
                  <option value="dark">{props.themeOptionDarkLabel}</option>
                  <option value="system">{props.themeOptionSystemLabel}</option>
                </select>
              </div>
            </div>
          </>
        ) : null}

        <div class="setting-block">
          <div class="setting-row">
            <label for="settings-storage-backend" class="label">
              {props.storageLocationLabel}
            </label>
            <select
              id="settings-storage-backend"
              class="locale-select setting-control"
              value={props.storageBackendValue}
              onChange={props.onStorageBackendChange}
            >
              <option value="google">{props.storageGoogleLabel}</option>
              <option value="indexeddb">{props.storageIndexedDbLabel}</option>
            </select>
          </div>
          {props.showStorageGoogleSignIn ? (
            <button type="button" class="btn setting-action" disabled={props.storageGoogleSignInDisabled} onClick={props.onStorageGoogleSignIn}>
              {props.storageGoogleSignInLabel}
            </button>
          ) : null}
          <p class="status setting-status">{props.storageHelpText}</p>
        </div>

        {props.showReminderSettings ? (
          <div class="setting-block">
            <div class="setting-row">
              <label for="settings-reminder-enabled" class="label">
                {props.reminderEnabledLabel}
              </label>
              <input
                id="settings-reminder-enabled"
                class="setting-toggle"
                type="checkbox"
                checked={props.reminderEnabled}
                onChange={props.onReminderEnabledChange}
              />
            </div>
            <div class={`setting-row setting-row-divider${props.reminderEnabled ? "" : " setting-row-disabled"}`}>
              <label for="settings-reminder-time" class="label">
                {props.reminderTimeLabel}
              </label>
              <input
                id="settings-reminder-time"
                class="setting-control"
                type="time"
                value={props.reminderTime}
                disabled={!props.reminderEnabled}
                onInput={props.onReminderTimeChange}
              />
            </div>
          </div>
        ) : null}

        <div class="setting-block">
          <div class="setting-row">
            <label for="settings-notifications-enabled" class="label">{props.reminderPermissionLabel}</label>
            <input
              id="settings-notifications-enabled"
              class="setting-toggle"
              type="checkbox"
              checked={props.notificationsEnabled}
              disabled={props.notificationsUnsupported}
              onChange={props.onNotificationsEnabledChange}
            />
          </div>
          <div class={`setting-row setting-row-divider${props.notificationsUnsupported ? " setting-row-disabled" : ""}`}>
            <p class="setting-note">{props.reminderPermissionStateLabel}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
