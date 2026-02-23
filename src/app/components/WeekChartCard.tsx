
import { createEffect, on } from "solid-js";
import type { JSX } from "solid-js";
import { drawWeeklyChart, type RatingPoint } from "../../chart/weekly";

export function WeekChartCard(props: {
  visible: boolean;
  title: string;
  ariaLabel: string;
  emptyLabel: string;
  points: RatingPoint[];
  refreshToken: number;
}): JSX.Element {
  let chartCanvas: HTMLCanvasElement | undefined;
  let chartEmpty: HTMLParagraphElement | undefined;

  createEffect(
    on(
      () => [props.points, props.refreshToken],
      () => {
        if (!chartCanvas || !chartEmpty) {
          return;
        }
        drawWeeklyChart(chartCanvas, chartEmpty, props.points);
      },
      { defer: true },
    ),
  );

  return (
    <section id="week-view" class={`view${props.visible ? "" : " hidden"}`}>
      <div class="card">
        <p id="chart-title" class="label">
          {props.title}
        </p>
        <canvas
          id="chart"
          width="720"
          height="320"
          aria-label={props.ariaLabel}
          ref={(el: HTMLCanvasElement) => {
            chartCanvas = el;
          }}
        />
        <p
          id="chart-empty"
          class="status hidden"
          ref={(el: HTMLParagraphElement) => {
            chartEmpty = el;
          }}
        >
          {props.emptyLabel}
        </p>
      </div>
    </section>
  );
}
