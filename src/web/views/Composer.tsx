import type { SlashCommand, SlashSource } from "@core/composer";
import type {
  ImageAttachment,
  ModelOption,
  Notice,
  ThinkingChoice,
  ThinkingLevel,
} from "@core/ports";
import type { NewSessionView, SessionView } from "@core/workspace";
import {
  AttachImageIcon,
  ChevronDownIcon,
  ComposerActionIcon,
  DropZoneIcon,
  ModelCheckIcon,
  MoreDotsIcon,
  WarningTriangleIcon,
} from "./icons.tsx";

// pi-web's ChatInput (components/ChatInput.tsx): one 820px
// column holding the banners, the queue panel, the 24px-radius surface and its
// toolbar. The server renders the composer and every menu it opens; the client
// bundle owns only the keyboard, the local file index, and the image previews,
// which cannot come from a round trip.

const SOURCE_LABEL: Record<SlashSource, string> = {
  builtin: "Built-in",
  extension: "Extensions",
  prompt: "Prompts",
  skill: "Skills",
};

/** pi-web groups the list in this order, whatever order the commands arrive in. */
const SOURCE_ORDER: SlashSource[] = ["builtin", "extension", "prompt", "skill"];

/** "1 match" / "N matches", as pi-web labels the `@` file menu. */
export function matchLabel(count: number): string {
  return count === 1 ? "1 match" : `${String(count)} matches`;
}

/**
 * The slash menu counts commands until something is typed after the slash,
 * and only then counts matches (ChatInput.tsx L1116-L1121).
 */
export function commandLabel(count: number, query: string): string {
  if (query !== "") return matchLabel(count);
  return count === 1 ? "1 command" : `${String(count)} commands`;
}

/**
 * The slash menu: pi-web's header with the count and the Tab / Enter hint,
 * then one section per source. The flat `data-index` is what the arrow keys
 * walk; `data-active` is the highlight pi-web's `.menu-item` CSS keys on.
 */
export function CommandMenu({
  commands,
  query = "",
}: {
  commands: SlashCommand[];
  /** What was typed after the slash: it picks the header's noun. */
  query?: string;
}) {
  const groups = SOURCE_ORDER.map((source) => ({
    source,
    items: commands.filter((command) => command.source === source),
  })).filter((group) => group.items.length > 0);
  let index = -1;
  return (
    <>
      <div class="composer-menu-header">
        <span>Slash commands · {commandLabel(commands.length, query)}</span>
        <span class="composer-menu-hint">Tab / Enter</span>
      </div>
      <div class="composer-command-list">
        {commands.length === 0 ? (
          <div class="composer-command-empty">
            No extension, prompt, or skill commands found
          </div>
        ) : (
          groups.map((group) => (
            <section class="composer-command-group">
              <div class="menu-section-label composer-command-heading">
                <span>{SOURCE_LABEL[group.source]}</span>
                <span class="composer-command-count">
                  {String(group.items.length)}
                </span>
              </div>
              <div>
                {group.items.map((command) => {
                  index += 1;
                  return (
                    <button
                      type="button"
                      class="menu-item composer-command"
                      data-command={command.name}
                      data-index={String(index)}
                    >
                      <span class="composer-command-name">
                        /{command.name}
                        {command.manual ? (
                          <span class="composer-command-manual">Manual</span>
                        ) : null}
                      </span>
                      {command.description ? (
                        <span class="composer-command-description">
                          {command.description}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </>
  );
}

/** One batch of notices, appended to the shelf by the session's SSE stream. */
export function Toasts({ notices }: { notices: Notice[] }) {
  return (
    <>
      {notices.map((notice) => (
        <div
          class={`notice-shelf-item is-${notice.level}`}
          role={notice.level === "error" ? "alert" : "status"}
        >
          <span class="notice-shelf-dot" />
          <span tabindex={0} class="notice-shelf-text">
            {notice.message}
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * Images a recall took back out of the queue. The client bundle turns each
 * one into a File and puts it back in the attachment strip; nothing renders.
 */
export function RecalledImages({
  images,
  oob,
}: {
  images: ImageAttachment[];
  oob?: boolean;
}) {
  return (
    <div
      id="recalled-images"
      hidden
      {...(oob === false ? {} : { "hx-swap-oob": "innerHTML" })}
    >
      {images.map((image) => (
        <span data-image={image.data} data-mime={image.mimeType} />
      ))}
    </div>
  );
}

export function ComposerText({ draft }: { draft?: string }) {
  return (
    <textarea
      id="composer-text"
      name="text"
      class="composer-textarea"
      data-restored-draft={draft !== undefined ? "" : undefined}
      rows={1}
      placeholder="Message…"
      // The browser keyboard must not steal Enter from a phone user.
      enterkeyhint="enter"
    >
      {draft ?? ""}
    </textarea>
  );
}

/** pi-web's ModelNoticeBanner (§6.2), for the one tone web-pi raises. */
export function ModelScopeWarning({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return <></>;
  return (
    <div role="alert" class="composer-model-warning">
      <span class="composer-model-warning-icon">
        <WarningTriangleIcon />
      </span>
      <div class="composer-model-warning-body">
        <div class="composer-model-warning-title">
          Model scope warning{warnings.length === 1 ? "" : "s"}
        </div>
        <div class="composer-model-warning-text">{warnings.join("\n")}</div>
      </div>
    </div>
  );
}

/** Everything the model selector renders from, wherever it is rendered. */
export type ModelPick = {
  models: ModelOption[];
  current: ModelOption | null;
  levels: ThinkingChoice[];
  level?: ThinkingLevel;
  /** A live session applies a pick at once; `/new` only records it. */
  sessionId?: string;
  cwd?: string;
  /** New-session defaults are display-only until deliberately chosen. */
  explicitModel?: boolean;
  thinkingOverride?: ThinkingLevel;
  /** A running turn locks the selector, as pi-web does. */
  disabled?: boolean;
};

/** How many models it takes before the menu needs a filter box (pi-web: >8). */
const FILTER_FROM = 8;

/**
 * What the selector shows for a session. `disabled` is also kept in step by
 * the client while a turn runs: the stream only re-sends this subtree when
 * the model or its levels change, not on every frame of a turn.
 */
export function modelPick(view: SessionView): ModelPick {
  const { status } = view;
  const current = status?.model ?? view.model ?? null;
  return {
    models: view.models,
    current,
    // A session nothing is running for still offers the levels its model
    // knows, as pi-web's picker does from the model list alone.
    levels: status?.thinkingLevels ?? current?.thinkingLevels ?? [],
    ...(status === null
      ? view.thinking === undefined
        ? {}
        : { level: view.thinking }
      : { level: status.thinkingLevel }),
    sessionId: view.summary.id,
    disabled: status?.running === true || status?.compacting === true,
  };
}

function modelValue(model: ModelOption): string {
  return `${model.provider}/${model.id}`;
}

/** The effective level, using the provider's label when it has one. */
function levelLabel(pick: ModelPick): string {
  if (!pick.current) return "Model unavailable";
  if (!pick.current.reasoning) return "off";
  const choice = pick.levels.find((entry) => entry.level === pick.level);
  return choice?.label ?? pick.level ?? "Model unavailable";
}

/** Where a pick goes, as htmx attributes: the same swap in both places. */
function pickAttributes(pick: ModelPick, value: string) {
  const target = {
    "hx-target": "closest .model-selector",
    "hx-swap": "outerHTML",
  };
  const model = encodeURIComponent(value);
  if (pick.sessionId !== undefined) {
    return {
      // The button sits inside the composer form: without this htmx would
      // post the draft and its attachments along with the pick.
      "data-request-fields": "none",
      "hx-post": `/sessions/${pick.sessionId}/model?model=${model}`,
      ...target,
    };
  }
  const cwd = encodeURIComponent(pick.cwd ?? "");
  return {
    "hx-get": `/workspaces/model-selector?cwd=${cwd}&model=${model}`,
    "hx-include": "[name='thinking']",
    ...target,
  };
}

/** pi-web's reasoning row: the label and the level select (§6.1). */
function ReasoningField({ pick }: { pick: ModelPick }) {
  const current = pick.current;
  const value =
    pick.sessionId === undefined || current === null
      ? {}
      : {
          "hx-post": `/sessions/${pick.sessionId}/model?model=${encodeURIComponent(modelValue(current))}`,
          "hx-trigger": "change",
          "data-request-fields": "thinking",
          "hx-target": "closest .model-selector",
          "hx-swap": "outerHTML",
        };
  return (
    <label class="composer-thinking-field">
      <span>Change reasoning level</span>
      {pick.sessionId === undefined ? (
        <input
          type="hidden"
          name="thinking"
          value={pick.thinkingOverride ?? ""}
        />
      ) : null}
      <select
        name={pick.sessionId === undefined ? "display-thinking" : "thinking"}
        disabled={pick.disabled === true || !current?.reasoning}
        data-unavailable={!current?.reasoning ? "" : undefined}
        {...value}
      >
        {current === null ? (
          <option value="" selected>
            Model unavailable
          </option>
        ) : null}
        {(current && !current.reasoning
          ? [{ level: "off", label: "off" }]
          : pick.levels
        ).map((choice) => (
          <option value={choice.level} selected={choice.level === pick.level}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** pi-web sorts the whole list by display name, never by which is current. */
const MODEL_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function compareModels(a: ModelOption, b: ModelOption): number {
  return (
    MODEL_COLLATOR.compare(a.name || a.id, b.name || b.id) ||
    MODEL_COLLATOR.compare(a.provider, b.provider) ||
    MODEL_COLLATOR.compare(a.id, b.id)
  );
}

/**
 * pi-web's ModelSelector (§6.5): the toolbar trigger and the listbox it
 * anchors. The popover is the browser's — `popovertarget` opens it, light
 * dismiss and Escape close it — and CSS anchor positioning pins it to the
 * trigger, so nothing here needs a script.
 */
export function ModelSelector({
  pick,
  oob,
}: {
  pick: ModelPick;
  /** The session stream re-renders the whole selector in place. */
  oob?: boolean;
}) {
  const { current, disabled } = pick;
  const models = [...pick.models].sort(compareModels);
  const name =
    current?.name ?? (models.length === 0 ? "No models" : "Select model");
  const detail = levelLabel(pick);
  const providers = [...new Set(models.map((model) => model.provider))];
  return (
    <div
      id="model-selector"
      hx-get={
        pick.sessionId
          ? `/sessions/${pick.sessionId}/model-selector`
          : `/workspaces/model-selector?${new URLSearchParams({ cwd: pick.cwd ?? "", ...(pick.explicitModel && current ? { model: modelValue(current) } : {}), ...(pick.thinkingOverride ? { thinking: pick.thinkingOverride } : {}) }).toString()}`
      }
      hx-trigger="models-changed from:body"
      hx-target="this"
      hx-swap="outerHTML"
      class={`model-selector is-composer${disabled === true ? " is-disabled" : ""}`}
      {...(oob === true ? { "hx-swap-oob": "outerHTML" } : {})}
    >
      {/* `/new` posts the pick with the first prompt instead of applying it. */}
      {pick.sessionId === undefined ? (
        <input
          type="hidden"
          name="model"
          value={pick.explicitModel && current ? modelValue(current) : ""}
        />
      ) : null}
      <button
        type="button"
        id="model-trigger"
        class="anchor-model-selector"
        popovertarget="model-menu"
        aria-haspopup="dialog"
        aria-expanded="false"
        aria-label="Model and reasoning"
        disabled={disabled === true}
        title={
          disabled === true
            ? name
            : models.length > 0
              ? "Change model"
              : "No available models"
        }
      >
        <span class="composer-model-name">{name}</span>
        <span class="composer-model-detail">{detail}</span>
        <ChevronDownIcon />
      </button>
      <div
        id="model-menu"
        popover="auto"
        class="anchored-menu menu-surface opens-up menu-model-selector"
        role="dialog"
        aria-label="Model and reasoning"
      >
        <ReasoningField pick={pick} />
        {models.length > FILTER_FROM ? (
          <div class="composer-model-filter">
            <input
              id="model-filter"
              class="menu-filter composer-model-filter-input"
              placeholder="Filter models…"
              aria-label="Filter models…"
              autocomplete="off"
              spellcheck={false}
              // Showing a popover focuses its first autofocus element, which
              // is where pi-web's ref.focus() put the caret.
              autofocus
            />
          </div>
        ) : null}
        <div
          role="listbox"
          aria-label="Select model"
          class="composer-model-list"
        >
          {models.length === 0 ? (
            <div class="composer-model-empty">
              No model choices.{" "}
              <a
                href={`/settings?section=models&cwd=${encodeURIComponent(pick.cwd ?? "")}`}
              >
                Choose models in Settings
              </a>
            </div>
          ) : (
            providers.map((provider) => (
              <div class="composer-model-provider" data-provider={provider}>
                {providers.length > 1 ? (
                  <div class="menu-section-label composer-model-provider-heading">
                    {provider}
                  </div>
                ) : null}
                {models
                  .filter((model) => model.provider === provider)
                  .map((model) => {
                    const active =
                      current?.provider === model.provider &&
                      current.id === model.id;
                    return (
                      <button
                        type="button"
                        role="option"
                        class="menu-item composer-model-option"
                        aria-selected={active ? "true" : "false"}
                        data-model-name={model.name}
                        {...pickAttributes(pick, modelValue(model))}
                      >
                        {active ? (
                          <ModelCheckIcon />
                        ) : (
                          <span class="composer-model-check-space" />
                        )}
                        <span
                          title={model.name}
                          class="composer-model-option-name"
                        >
                          {model.name}
                        </span>
                      </button>
                    );
                  })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * pi-web's mobile "more" menu (§6.1): a phone has no Alt key and no room for
 * the extension status line, so both live here. `.composer-more` is hidden
 * above 640px by areas/composer.css, which is where pi-web's `isMobile` was.
 */
function MoreControls({ sessionId }: { sessionId?: string }) {
  return (
    <>
      <button
        type="button"
        id="composer-controls-trigger"
        class="anchor-composer-controls composer-more"
        popovertarget="composer-controls"
        aria-expanded="false"
        title="Session controls"
        aria-label="Session controls"
      >
        <MoreDotsIcon size={18} />
      </button>
      <div
        id="composer-controls"
        popover="auto"
        class="anchored-menu menu-surface opens-up menu-composer-controls"
      >
        {sessionId === undefined ? null : (
          <button
            type="button"
            class="menu-item composer-stop"
            hx-post={`/sessions/${sessionId}/abort`}
            data-request-fields="none"
            hx-swap="none"
          >
            Stop agent
          </button>
        )}
        {/* The shelf's own status line is sr-only on a phone; this is the
            visible copy. The client keeps it
            in step with the shelf, and it stays out of the accessibility tree
            because the live region below already announces the same text. */}
        <section
          id="composer-status-section"
          aria-label="Extension status"
          hidden
        >
          <div class="menu-section-label">Extension status</div>
          <div class="extension-status-shelf has-status" aria-hidden="true">
            <div class="extension-status-line">
              <span id="shelf-mobile" class="extension-status-text" />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

/** pi-web's drag-and-drop overlay (§4.1); the client bundle unhides it. */
export function DropZone() {
  return (
    <div class="chat-drop-zone" hidden>
      <DropZoneIcon />
    </div>
  );
}

/**
 * `sessionId` posts into an existing session; `cwd` starts a new one. The two
 * differ only in where the form posts, whether the menus have a session to ask
 * for commands and files, and whether a model pick applies now or on send.
 */
export function Composer({
  sessionId,
  cwd,
  draft,
  images = [],
  view,
  start,
  status,
}: {
  sessionId?: string;
  cwd?: string;
  draft?: string;
  images?: ImageAttachment[];
  /** The session this composer belongs to: its models and running state. */
  view?: SessionView;
  /** Set on the new-session page: the model to start in this folder with. */
  start?: NewSessionView;
  /** The banners and queue panel, so the first render matches the stream's. */
  status?: unknown;
}) {
  const pick: ModelPick | undefined = view
    ? modelPick(view)
    : start
      ? {
          models: start.models,
          current: start.model ?? null,
          levels: start.model?.thinkingLevels ?? [],
          ...(start.thinkingLevel === undefined
            ? {}
            : { level: start.thinkingLevel }),
          cwd: start.cwd,
        }
      : undefined;
  return (
    <form
      id="composer"
      class="chat-input"
      hx-post={
        sessionId === undefined ? "/sessions" : `/sessions/${sessionId}/prompt`
      }
      hx-encoding="multipart/form-data"
      hx-sync="this:drop"
      hx-target="#toasts"
      hx-swap="beforeend"
      {...(sessionId === undefined ? {} : { "data-session-id": sessionId })}
      {...(cwd === undefined ? {} : { "data-cwd": cwd })}
      {...(start?.usable === true ? { "data-complete": "folder" } : {})}
    >
      <input
        id="image-input"
        type="file"
        name="images[]"
        accept="image/*"
        multiple
        hidden
      />
      <div class="composer-column">
        {sessionId === undefined && cwd !== undefined ? (
          <input type="hidden" name="cwd" value={cwd} />
        ) : null}
        {/* htmx reads the last clicked button, not requestSubmit's submitter,
            so the delivery mode travels in a field of its own. */}
        <input
          id="composer-behavior"
          type="hidden"
          name="behavior"
          value="steer"
        />
        {/* pi-web's banners and queue panel live here, above the surface and
            inside the 820px column; the session stream re-renders them. */}
        <div id="status">
          {status}
          {start ? <ModelScopeWarning warnings={start.modelWarnings} /> : null}
        </div>
        <div class="composer-input-host">
          <div
            id="slash-menu"
            class="menu-surface menu-panel composer-completion-panel"
            hidden
          />
          <div
            id="at-menu"
            class="menu-surface menu-panel composer-completion-panel"
            hidden
          />
          <div class="composer-surface">
            <div id="image-previews" class="composer-image-previews" hidden />
            <ComposerText draft={draft} />
            <div class="composer-toolbar">
              <button
                type="button"
                id="attach-image"
                class="composer-attach"
                title="Attach image"
                aria-label="Attach image"
              >
                <AttachImageIcon />
              </button>
              <MoreControls
                {...(sessionId === undefined ? {} : { sessionId })}
              />
              {pick === undefined ? null : <ModelSelector pick={pick} />}
              <button
                type="submit"
                class="composer-action-primary"
                data-action="send"
                data-behavior="steer"
                aria-label="Send"
                title="Send"
                disabled
              >
                <ComposerActionIcon action="send" />
              </button>
            </div>
          </div>
        </div>
        <div class="composer-shell-mode" id="shell-hint" hidden />
        <span class="sr-only" role="status" id="composer-running-note" />
        <RecalledImages images={images} oob={false} />
      </div>
    </form>
  );
}
