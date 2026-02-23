
import type { JSX } from "solid-js";

export function Tabs(props: {
  entryDisabled: boolean;
  weekDisabled: boolean;
  activeTab: "entry" | "week";
  ariaLabel: string;
  entryLabel: string;
  weekLabel: string;
  onEntryClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onWeekClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
}): JSX.Element {
  return (
    <nav id="tabs" class="tabs" aria-label={props.ariaLabel}>
      <button
        id="tab-entry"
        class={`tab${props.activeTab === "entry" ? " tab-active" : ""}`}
        disabled={props.entryDisabled}
        type="button"
        onClick={props.onEntryClick}
      >
        {props.entryLabel}
      </button>
      <button
        id="tab-week"
        class={`tab${props.activeTab === "week" ? " tab-active" : ""}`}
        disabled={props.weekDisabled}
        type="button"
        onClick={props.onWeekClick}
      >
        {props.weekLabel}
      </button>
    </nav>
  );
}
