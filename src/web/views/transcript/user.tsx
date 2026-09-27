import type { UserItem } from "@core/transcript";
import { ExpandChevronIcon, RewindIcon } from "@web/views/icons";
import {
  CopyButton,
  Images,
  type ItemActions,
  Markdown,
  Time,
} from "./shared.tsx";

// pi-web's user message band: the question, its attachments, and the
// copy and rewind actions under it. A skill expansion folds into a
// disclosure that shows the command.

export function UserMessage({
  item,
  actions,
}: {
  item: UserItem;
  actions?: ItemActions;
}) {
  const editable = actions && !actions.readOnly && !actions.live;
  const images = (
    <Images
      entryId={item.entryId}
      indices={item.images}
      actions={actions}
      variant="user"
      separated={item.text !== ""}
    />
  );
  const included = item.skills?.length
    ? `Skills included: ${item.skills.map((skill) => skill.name).join(", ")}`
    : "";
  const source = item.command ?? item.text;
  const copy = included ? `${source}\n\n${included}` : source;
  const command = item.command;
  const space = command === undefined ? -1 : command.search(/\s/);
  const name =
    command === undefined
      ? ""
      : space === -1
        ? command
        : command.slice(0, space);
  const args =
    command !== undefined && space !== -1 ? command.slice(space + 1) : "";
  return (
    <div
      class="message-row user-message"
      id={`entry-${item.entryId}`}
      data-role="user"
    >
      <div class="user-message-band">
        <div class="user-message-band-content">
          <div class="user-message-content">
            <div class="user-message-text">
              {command === undefined ? (
                <>
                  {images}
                  {/* `data-user-text` is what the composer's ArrowUp reads. */}
                  <div
                    data-user-text
                    data-user-skills={
                      item.skills ? JSON.stringify(item.skills) : undefined
                    }
                    hidden
                  >
                    {item.text}
                  </div>
                  <Markdown
                    source={item.text}
                    actions={actions}
                    variant="markdown-user-message"
                  />
                </>
              ) : (
                <details class="transcript-details user-command">
                  <summary class="user-command-summary">
                    <span hidden data-user-text>
                      {command}
                    </span>
                    <span class="user-command-label">
                      <span class="user-command-name">{name}</span>
                      <span class="card-chevron user-command-chevron">
                        <ExpandChevronIcon />
                      </span>
                    </span>
                    {args === "" ? null : (
                      <span class="user-command-arguments">{args}</span>
                    )}
                  </summary>
                  {images}
                  <Markdown
                    source={item.text}
                    actions={actions}
                    variant="markdown-user-message"
                  />
                </details>
              )}
              {included ? (
                <div
                  class="user-message-skills"
                  title="These skill instructions were included in this message; inclusion does not guarantee model compliance."
                >
                  {included}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div class="user-message-footer">
        <div class="message-actions user-message-copy">
          <CopyButton text={copy} />
        </div>
        {editable && actions ? (
          <div class="message-actions user-message-history">
            {actions.busy === true ? null : (
              <button
                type="button"
                class="message-rewind"
                title="Rewind — remove this message and later history, then edit it again"
                hx-post={`/sessions/${actions.sessionId}/rewind`}
                hx-vals={JSON.stringify({ entryId: item.entryId })}
                hx-confirm="Remove this message and all later history?"
                hx-target="body"
                hx-swap="innerHTML"
              >
                <RewindIcon />
                Rewind
              </button>
            )}
          </div>
        ) : null}
        <Time value={item.timestamp} />
      </div>
    </div>
  );
}
