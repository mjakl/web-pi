import { sameModel, type ModelSettingsView } from "@core/model-settings";
import { ConfigButton } from "./ConfigControls.tsx";

export function ModelSettings({
  cwd,
  view,
  message,
  failed = false,
}: {
  cwd: string;
  view: ModelSettingsView;
  message?: string;
  failed?: boolean;
}) {
  const all = !view.patterns?.length;
  const hasModels = view.available.length > 0;
  return (
    <form
      class="settings-general settings-models"
      hx-post="/settings/models"
      hx-target="#settings-body"
      hx-swap="innerHTML"
      hx-disabled-elt="find button"
    >
      <input type="hidden" name="cwd" value={cwd} />
      <input
        type="hidden"
        name="patterns"
        value={JSON.stringify(view.patterns)}
      />
      <div class="settings-model-heading">
        <h2 class="settings-general-title">Models</h2>
        <span class="config-scope-tag">global</span>
      </div>
      <p class="settings-general-description">
        Choose models for the chooser and Pi’s terminal cycling list. Saved in
        Pi’s global settings; running conversations keep their current model.
      </p>
      {view.projectPatterns !== null ? (
        <div class="config-trust-notice" role="status">
          This project overrides the model list in{" "}
          <code>.pi/settings.json</code>. Its chooser uses that override; edits
          here change global settings only.
        </div>
      ) : null}
      <p class="settings-general-description">
        {all
          ? "Using all available models, including future additions."
          : "Using a custom model list."}
      </p>
      {view.patterns?.some((pattern) => /[*?[]/.test(pattern)) ? (
        <p class="settings-general-description">
          Excluding a wildcard match keeps its other current matches and
          reasoning levels. That wildcard will no longer include future models
          automatically.
        </p>
      ) : null}
      {view.unavailable.length ? (
        <details class="settings-model-patterns" open>
          <summary>
            {String(view.unavailable.length)} unavailable saved{" "}
            {view.unavailable.length === 1 ? "entry" : "entries"}
          </summary>
          <ul>
            {view.unavailable.map((pattern) => (
              <li>
                <code>{pattern}</code>
              </li>
            ))}
          </ul>
          <p class="settings-general-description">
            Kept when you save. Configure the provider or select replacements.
            Use all models clears the custom list.
          </p>
        </details>
      ) : null}
      {view.warnings.map((warning) => (
        <p class="settings-general-description" role="status">
          {warning}
        </p>
      ))}
      {hasModels ? (
        <>
          <label class="settings-general-heading" for="settings-model-filter">
            Find models
          </label>
          <input
            id="settings-model-filter"
            class="config-input"
            type="search"
            placeholder="Name, provider or model ID…"
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
                  value={JSON.stringify({
                    provider: model.provider,
                    id: model.id,
                  })}
                  checked={view.selected.some((selected) =>
                    sameModel(selected, model),
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
          <p class="settings-general-description" data-model-empty hidden>
            No matching models.
          </p>
        </>
      ) : (
        <div class="config-empty-state">
          <div>
            <strong>No models available</strong>
            <p>
              Configure a provider in Pi’s terminal or models.json, then reload
              Settings. Your saved model configuration is unchanged.
            </p>
          </div>
        </div>
      )}
      <div class="settings-prompt-actions">
        <ConfigButton
          type="submit"
          variant="primary"
          data-model-save
          disabled={!hasModels || view.selected.length === 0}
        >
          Save selection
        </ConfigButton>
        <ConfigButton
          type="submit"
          name="defaults"
          value="1"
          disabled={!hasModels}
        >
          Use all models
        </ConfigButton>
      </div>
      <p
        class="settings-general-description"
        data-model-status
        role={failed ? "alert" : "status"}
        aria-live="polite"
      >
        {message}
      </p>
    </form>
  );
}
