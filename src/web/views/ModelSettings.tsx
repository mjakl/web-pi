import type { ModelOption } from "@core/ports";
import { ConfigButton } from "./ConfigControls.tsx";

export type ModelsView = {
  available: ModelOption[];
  selected: ModelOption[];
  unavailableCount: number;
};

export function ModelSettings({
  cwd,
  view,
  message,
  failed = false,
}: {
  cwd: string;
  view: ModelsView;
  message?: string;
  failed?: boolean;
}) {
  return (
    <form
      class="settings-general settings-models"
      hx-post="/settings/models"
      hx-target="#settings-body"
      hx-swap="innerHTML"
      hx-disabled-elt="find button"
    >
      <input type="hidden" name="cwd" value={cwd} />
      <h2 class="settings-general-title">Models</h2>
      <p class="settings-general-description">
        Choose which models appear in the web model chooser. This is shared
        across browsers and projects. It does not change Pi’s startup defaults,
        terminal settings or existing sessions.
      </p>
      <p class="settings-general-description">
        Available models have configured credentials. New models stay hidden
        after you save a selection. Saving none leaves the chooser empty; return
        here to include models or use Pi defaults.
      </p>
      {view.unavailableCount > 0 ? (
        <p class="settings-general-description">
          {String(view.unavailableCount)} saved choices are currently
          unavailable. They will return if available again; Use Pi defaults
          clears the saved selection.
        </p>
      ) : null}
      <label class="settings-general-heading" for="settings-model-filter">
        Find models
      </label>
      <input
        id="settings-model-filter"
        class="config-input"
        type="search"
        placeholder="Filter by name, provider or model ID…"
        aria-controls="settings-model-list"
      />
      <div id="settings-model-list" class="settings-model-list">
        {view.available.map((model) => (
          <label
            class="settings-model-row"
            data-model-search={`${model.name} ${model.provider} ${model.id}`}
          >
            <input
              type="checkbox"
              name="model"
              value={JSON.stringify({ provider: model.provider, id: model.id })}
              checked={view.selected.some(
                (selected) =>
                  selected.provider === model.provider &&
                  selected.id === model.id,
              )}
            />
            <span class="settings-model-info">
              <strong>{model.name}</strong>
              <span>
                {model.provider} / {model.id}
              </span>
            </span>
            <span class="settings-model-include">Include</span>
          </label>
        ))}
      </div>
      <p
        class="settings-general-description"
        data-model-empty
        hidden={view.available.length > 0}
      >
        No matching available models.
      </p>
      <div class="settings-prompt-actions">
        <ConfigButton type="submit" variant="primary">
          Save selection
        </ConfigButton>
        <ConfigButton type="submit" name="defaults" value="1">
          Use Pi defaults
        </ConfigButton>
        <span
          class="settings-general-description"
          role={failed ? "alert" : "status"}
          aria-live="polite"
        >
          {message}
        </span>
      </div>
    </form>
  );
}
