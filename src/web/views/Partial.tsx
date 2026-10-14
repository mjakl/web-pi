import type { Child } from "hono/jsx";

/** SSE updates name their owner instead of relying on connection attributes. */
export function Partial({
  target,
  swap = "innerHTML",
  children,
}: {
  target: string;
  swap?: "innerHTML" | "outerHTML" | "beforeend" | "innerMorph" | "outerMorph";
  children?: Child;
}) {
  return (
    <hx-partial hx-target={target} hx-swap={swap}>
      {children}
    </hx-partial>
  );
}
