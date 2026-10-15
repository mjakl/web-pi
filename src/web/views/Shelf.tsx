import { ansiToHtml, statusLine, stripAnsi } from "@core/ansi";
import type { ExtensionWidget, LiveStatus } from "@core/ports";
import { raw } from "hono/html";
import { WidgetPlacementIcon } from "./icons.tsx";

// pi-web's ExtensionStatusBar and ExtensionWidgets: the strip under the
// composer, with one status line and a 108px trigger per widget, at most one
// panel open. Extensions write for a terminal, so every string here goes
// through the ANSI converter, which escapes as it goes.

/** A widget with two or three lines is small enough to show unasked. */
const DEFAULT_EXPANDED_LINES = 3;

function placementLabel(widget: ExtensionWidget): string {
  return widget.placement === "belowEditor"
    ? "Below editor widget"
    : "Above editor widget";
}

function Trigger({
  widget,
  index,
  expanded,
  updated,
}: {
  widget: ExtensionWidget;
  index: number;
  expanded: boolean;
  updated: boolean;
}) {
  const lines = widget.lines.length;
  const label = `${placementLabel(widget)}: ${widget.key}, ${String(lines)} ${lines === 1 ? "line" : "lines"}`;
  const classes = `extension-widget-trigger${updated ? " is-updating" : ""}`;
  const body = (
    <>
      <span class="extension-widget-placement" aria-hidden="true">
        <WidgetPlacementIcon
          placement={widget.placement === "belowEditor" ? "below" : "above"}
        />
      </span>
      <span class="extension-widget-key">{widget.key}</span>
    </>
  );
  // A widget with no lines has nothing to open, so pi-web renders a plain div.
  return lines === 0 ? (
    <div
      class={classes}
      aria-label={label}
      title={`${widget.key} - ${placementLabel(widget)}`}
    >
      {body}
    </div>
  ) : (
    <button
      type="button"
      id={`widget-trigger-${String(index)}`}
      class={classes}
      aria-controls={`widget-panel-${String(index)}`}
      aria-expanded={expanded ? "true" : "false"}
      aria-label={label}
      title={`${widget.key} - ${placementLabel(widget)} - ${expanded ? "Collapse" : "Expand"}`}
      data-widget={widget.key}
    >
      {body}
    </button>
  );
}

/**
 * The strip itself, always rendered: it is the element the session stream
 * swaps, and pi-web's mobile rules key on it being a child of the composer.
 * Empty, it carries no class, so `[hidden]` alone keeps it out of the way.
 */
export function ShelfBody({
  status,
  updated,
}: {
  status: LiveStatus | null;
  updated?: readonly string[];
}) {
  const line = status ? statusLine(status.statuses) : "";
  const widgets = status?.widgets ?? [];
  if (line === "" && widgets.length === 0) {
    return <div id="shelf" hidden />;
  }
  const changed = new Set(updated ?? []);
  // pi-web keeps the open panel in React state. The server re-renders this
  // strip only when an extension changed something, so the choice is made
  // here and the client bundle carries it across those re-renders.
  const expanded = widgets.find(
    (widget) =>
      widget.lines.length >= 2 && widget.lines.length <= DEFAULT_EXPANDED_LINES,
  )?.key;
  return (
    <div
      id="shelf"
      class={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${line === "" ? "" : " has-status"}`}
    >
      {widgets.length === 0 ? null : (
        <>
          <div class="extension-widget-panels" hidden={expanded === undefined}>
            {widgets.map((widget, index) =>
              widget.lines.length === 0 ? null : (
                <section
                  id={`widget-panel-${String(index)}`}
                  class="extension-widget-panel"
                  aria-labelledby={`widget-trigger-${String(index)}`}
                  hidden={widget.key !== expanded}
                >
                  <div class="extension-widget-panel-heading">{widget.key}</div>
                  <pre class="extension-widget-content">
                    {raw(ansiToHtml(widget.lines.join("\n")))}
                  </pre>
                </section>
              ),
            )}
          </div>
          <div
            class="extension-widget-triggers"
            role="group"
            aria-label="Extension widgets"
          >
            {widgets.map((widget, index) => (
              <Trigger
                widget={widget}
                index={index}
                expanded={widget.key === expanded}
                updated={changed.has(widget.key)}
              />
            ))}
          </div>
        </>
      )}
      {line === "" ? null : (
        <div
          class="extension-status-line"
          role="status"
          title={stripAnsi(line)}
          aria-label={stripAnsi(line)}
        >
          <span class="extension-status-text">{raw(ansiToHtml(line))}</span>
        </div>
      )}
    </div>
  );
}

/** What the shelf currently shows, so the stream only re-sends real changes. */
export function shelfSignature(status: LiveStatus | null): string {
  if (!status) return "";
  return JSON.stringify([status.statuses, status.widgets]);
}

/** Widget keys whose lines differ from the previous render. */
export function changedWidgets(
  previous: Map<string, string>,
  status: LiveStatus | null,
): string[] {
  const changed: string[] = [];
  for (const widget of status?.widgets ?? []) {
    const lines = widget.lines.join("\n");
    if (previous.has(widget.key) && previous.get(widget.key) !== lines) {
      changed.push(widget.key);
    }
    previous.set(widget.key, lines);
  }
  const keys = new Set((status?.widgets ?? []).map((widget) => widget.key));
  for (const key of [...previous.keys()]) {
    if (!keys.has(key)) previous.delete(key);
  }
  return changed;
}

export function Shelf({ status }: { status: LiveStatus | null }) {
  return <ShelfBody status={status} />;
}
