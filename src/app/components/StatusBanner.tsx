
import type { JSX } from "solid-js";

export function StatusBanner(props: { text: string; isError: boolean }): JSX.Element {
  return <p id="status" class={`status${props.isError ? " status-error" : ""}`}>{props.text}</p>;
}
