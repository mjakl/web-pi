import type { ToolView } from "@core/ports";

// What the session is actually running with: the tools it may call and the
// prompt it was given. Both come from the session itself, which pi-web resumes
// to answer — a command that starts no turn — and a session whose folder is
// gone simply says nothing has loaded. pi-web draws them as menu panels under
// the top bar (components/SystemPromptPanel.tsx,
// components/ToolDefinitionsPanel.tsx); the class names are its own.

export function SystemPromptPanel({ prompt }: { prompt?: string }) {
  return (
    <section
      class="system-prompt-panel menu-surface menu-panel"
      aria-label="System prompt"
    >
      <div class="system-prompt-scroll">
        {prompt === undefined ? (
          <div class="system-prompt-empty">
            System prompt has not loaded yet
          </div>
        ) : prompt === "" ? (
          <div class="system-prompt-empty">
            System prompt is empty (tools are disabled)
          </div>
        ) : (
          <div class="system-prompt-text">{prompt}</div>
        )}
      </div>
    </section>
  );
}

function ToolDetail({ tool }: { tool: ToolView }) {
  return (
    <div class="tool-definition-scroll">
      {tool.description === "" ? null : (
        <section class="tool-definition-section">
          <div class="tool-definition-section-label">Description</div>
          <div class="tool-definition-description">{tool.description}</div>
        </section>
      )}
      <section class="tool-definition-section">
        <div class="tool-definition-section-label">
          <span>Parameters</span>
          <span>{String(tool.parameters.length)} parameters</span>
        </div>
        {tool.parameters.length === 0 ? (
          <div class="tool-definition-no-parameters">No parameters</div>
        ) : (
          <div class="tool-definition-fields">
            {tool.parameters.map((parameter) => (
              <div class="tool-definition-field">
                <div class="tool-definition-field-name">
                  <code>{parameter.name}</code>
                  <span class={parameter.required ? "required" : undefined}>
                    {parameter.required ? "Required" : "Optional"}
                  </span>
                </div>
                <div class="tool-definition-field-value">
                  <code class="tool-definition-type">{parameter.type}</code>
                  {parameter.description === undefined ? null : (
                    <div>{parameter.description}</div>
                  )}
                  {parameter.enum === undefined ? null : (
                    <div class="tool-definition-meta">
                      Allowed: <code>{parameter.enum.join(", ")}</code>
                    </div>
                  )}
                  {parameter.default === undefined ? null : (
                    <div class="tool-definition-meta">
                      Default: <code>{parameter.default}</code>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      {tool.promptGuidelines === undefined ||
      tool.promptGuidelines.length === 0 ? null : (
        <section class="tool-definition-section">
          <div class="tool-definition-section-label">Prompt guidelines</div>
          <ul class="tool-definition-guidelines">
            {tool.promptGuidelines.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Only the tools this turn may call: an inactive one cannot be reached. */
export function ToolsPanel({
  sessionId,
  tools,
  selected,
}: {
  /** Absent before there is a session: the panel is then empty anyway. */
  sessionId?: string;
  tools?: ToolView[];
  selected?: string;
}) {
  const active = tools?.filter((tool) => tool.active);
  const shown =
    active === undefined
      ? undefined
      : (active.find((tool) => tool.name === selected) ?? active[0]);
  const empty =
    active === undefined
      ? "Tool definitions have not loaded yet"
      : "No active tools";
  return (
    <div class="tool-definitions-panel menu-surface menu-panel">
      <nav class="tool-definitions-sidebar" aria-label="Tool definitions">
        <div class="tool-definitions-list">
          {active === undefined || active.length === 0 ? (
            <div class="tool-definitions-empty">{empty}</div>
          ) : (
            active.map((tool) => (
              <button
                type="button"
                class="tool-definitions-item"
                aria-pressed={tool.name === shown?.name ? "true" : "false"}
                hx-get={`/sessions/${sessionId ?? ""}/tools?tool=${encodeURIComponent(tool.name)}`}
                hx-target="#tools-panel"
                hx-swap="innerHTML"
              >
                <code>{tool.name}</code>
              </button>
            ))
          )}
        </div>
      </nav>
      <section
        class="tool-definition-detail"
        aria-label="Tool definition details"
      >
        {shown ? (
          <ToolDetail tool={shown} />
        ) : (
          <div class="tool-definitions-empty">{empty}</div>
        )}
      </section>
    </div>
  );
}
