import type {
  SubagentCall,
  SubagentRun,
  SubagentView,
  ToolCallView,
} from "@core/transcript";
import { CardChevronIcon } from "@web/views/icons";
import { DeferredToolBody, toolResultUrl } from "./deferred-tool.tsx";
import { formatDuration, type ItemActions, Markdown } from "./shared.tsx";

// pi-web's SubagentToolCall: one card per `subagent` call, with the
// prompt, the run details, the result of every agent, and the raw payloads.

const STATUS_GLYPH = {
  completed: "✓",
  failed: "!",
  cancelled: "—",
  unknown: "—",
  running: "◌",
} as const;

const STATUS_LABEL = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "No result",
  running: "Running",
} as const;

function SubagentStatusView({ status }: { status: keyof typeof STATUS_GLYPH }) {
  return (
    <span class={`subagent-status subagent-status-${status}`}>
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      {STATUS_LABEL[status]}
    </span>
  );
}

function SubagentDisclosure({
  id,
  label,
  class: className,
  children,
}: {
  id?: string;
  label: unknown;
  class: string;
  children?: unknown;
}) {
  return (
    <details id={id} class={className}>
      <summary>
        <span class="subagent-summary-label">{label}</span>
        <span class="subagent-chevron">
          <CardChevronIcon colour="currentColor" />
        </span>
      </summary>
      {children}
    </details>
  );
}

function SubagentBody({
  call,
  run,
  actions,
  progress,
}: {
  call: SubagentCall;
  run?: SubagentRun;
  actions?: ItemActions;
  progress?: string;
}) {
  const model = run?.model ?? call.model;
  const cwd = run?.cwd ?? call.cwd ?? actions?.cwd;
  const folder =
    cwd === undefined
      ? undefined
      : (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd);
  return (
    <div class="subagent-body">
      <div class="subagent-meta">
        {model === undefined ? null : <span title={model}>{model}</span>}
        {folder === undefined || cwd === undefined ? null : (
          <span title={cwd}>{folder}</span>
        )}
      </div>
      {run === undefined ? (
        progress === undefined ? null : (
          <div class="subagent-result">
            <p>{progress}</p>
          </div>
        )
      ) : (
        <div class="subagent-result">
          <div class="subagent-section-label">Result</div>
          {run.output === "" ? null : (
            <Markdown source={run.output} actions={actions} />
          )}
          {run.error === undefined ? null : (
            <p class="subagent-error">{run.error}</p>
          )}
          {run.output === "" && run.error === undefined ? (
            <p>
              {run.handledWithoutAgent
                ? "Prompt handled without an agent response."
                : "No output."}
            </p>
          ) : null}
          {run.captureTruncated ? (
            <p class="subagent-notice">
              Only the end of the output was captured.
            </p>
          ) : null}
        </div>
      )}
      <SubagentDisclosure class="subagent-disclosure" label="Prompt">
        <pre class="subagent-plain">{call.prompt}</pre>
      </SubagentDisclosure>
      <SubagentDisclosure class="subagent-disclosure" label="Run details">
        <dl class="subagent-settings">
          <dt>Agent</dt>
          <dd>{call.agent}</dd>
          {model === undefined ? null : (
            <>
              <dt>Model</dt>
              <dd>{model}</dd>
            </>
          )}
          {cwd === undefined ? null : (
            <>
              <dt>Working directory</dt>
              <dd>{cwd}</dd>
            </>
          )}
          {call.initialContext === undefined ? null : (
            <>
              <dt>Requested initial context</dt>
              <dd>{call.initialContext}</dd>
            </>
          )}
          {call.session === undefined ? null : (
            <>
              <dt>Session</dt>
              <dd>{call.session}</dd>
            </>
          )}
        </dl>
      </SubagentDisclosure>
    </div>
  );
}

export function Subagent({
  view,
  call,
  actions,
}: {
  view: SubagentView;
  call: ToolCallView;
  actions?: ItemActions;
}) {
  const { calls, runs } = view;
  const running = call.result === undefined && actions?.inspectionOnly !== true;
  // What the tool last reported, while it is still reporting.
  const progress = actions?.progress?.[call.id];
  const single = calls.length === 1 ? calls[0] : undefined;
  const status: keyof typeof STATUS_GLYPH = running
    ? "running"
    : view.failed
      ? "failed"
      : (runs ?? []).some((run) => run.status === "cancelled")
        ? "cancelled"
        : (runs ?? []).some((run) => run.status === "unknown")
          ? "unknown"
          : call.result
            ? "completed"
            : "unknown";
  const counts =
    runs && calls.length > 1
      ? (["completed", "failed", "cancelled", "unknown"] as const)
          .flatMap((state) => {
            const count = runs.filter((run) => run.status === state).length;
            if (count === 0) return [];
            const label = state === "unknown" ? "without result" : state;
            return [`${count.toLocaleString("en")} ${label}`];
          })
          .join(" · ")
      : "";
  const deferred = toolResultUrl(call, actions);
  return (
    <SubagentDisclosure
      id={`tool-${encodeURIComponent(call.id)}`}
      class="subagent-card"
      label={
        <span class="subagent-header">
          <span class="subagent-name">
            Subagent ·{" "}
            {single
              ? single.agent
              : `${calls.length.toLocaleString("en")} agents`}
          </span>
          {counts === "" ? (
            <SubagentStatusView status={status} />
          ) : (
            <span class="subagent-counts">{counts}</span>
          )}
          {call.result?.seconds === undefined ? null : (
            <span class="subagent-duration">
              {formatDuration(call.result.seconds)}
            </span>
          )}
          {running && progress !== undefined ? (
            <span class="subagent-progress">{progress}</span>
          ) : null}
        </span>
      }
    >
      {deferred ? (
        <DeferredToolBody url={deferred} />
      ) : (
        <SubagentContent view={view} call={call} actions={actions} />
      )}
    </SubagentDisclosure>
  );
}

export function SubagentContent({
  view,
  call,
  actions,
}: {
  view: SubagentView;
  call: ToolCallView;
  actions?: ItemActions;
}) {
  const { calls, runs } = view;
  const single = calls.length === 1 ? calls[0] : undefined;
  const progress = actions?.progress?.[call.id];
  const raw = call.result?.text ?? "";
  return (
    <div class="tool-result" hx-morph-skip={call.result ? true : undefined}>
      {runs === null && call.result ? (
        <div class="subagent-body subagent-result">
          <div class="subagent-section-label">Result</div>
          <Markdown
            source={raw === "" ? "No output." : raw}
            actions={actions}
          />
        </div>
      ) : null}
      {single ? (
        <SubagentBody
          call={single}
          {...(runs?.[0] ? { run: runs[0] } : {})}
          actions={actions}
          {...(progress === undefined ? {} : { progress })}
        />
      ) : (
        calls.map((item, index) => (
          <details class="subagent-agent">
            <summary>
              <span class="subagent-summary-label">
                <span class="subagent-header">
                  <span class="subagent-name">{item.agent}</span>
                  <SubagentStatusView
                    status={runs?.[index]?.status ?? "unknown"}
                  />
                </span>
              </span>
              <span class="subagent-chevron">
                <CardChevronIcon colour="currentColor" />
              </span>
            </summary>
            <SubagentBody
              call={item}
              {...(runs?.[index] ? { run: runs[index] } : {})}
              actions={actions}
            />
          </details>
        ))
      )}
      <div class="subagent-raw">
        <SubagentDisclosure class="subagent-disclosure" label="Raw input">
          <pre class="subagent-plain">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
        </SubagentDisclosure>
        {call.result ? (
          <SubagentDisclosure class="subagent-disclosure" label="Raw output">
            <pre class="subagent-plain">{raw}</pre>
          </SubagentDisclosure>
        ) : null}
      </div>
    </div>
  );
}
