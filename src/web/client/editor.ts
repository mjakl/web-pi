// The composer textarea is replaced whole whenever the server hands back a
// new one (queue recall, a rewind); nothing may hold on to the element.

export function textarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>("#composer-text");
}

/**
 * Where the two composer menus fetch from. A session answers about itself; a
 * validated folder answers the same questions before any session exists, so
 * the new-session composer is not a lesser one.
 */
export type MenuEndpoints = {
  commands(query: string): string;
  index(query: string): string;
  completion(query: string): string;
};

export function menuEndpoints(form: HTMLFormElement): MenuEndpoints | null {
  const sessionId = form.dataset["sessionId"];
  const encode = (query: string) => encodeURIComponent(query);
  if (sessionId !== undefined && sessionId !== "") {
    const base = `/sessions/${sessionId}`;
    return {
      commands: (query) => `${base}/commands?q=${encode(query)}`,
      index: (query) => `${base}/file-index?q=${encode(query)}`,
      completion: (query) => `${base}/file-completion?q=${encode(query)}`,
    };
  }
  const cwd = form.dataset["cwd"];
  // Only a folder the server validated: an unchecked path lists nothing.
  if (form.dataset["complete"] !== "folder" || cwd === undefined) return null;
  const folder = `cwd=${encodeURIComponent(cwd)}`;
  return {
    commands: (query) => `/workspaces/commands?${folder}&q=${encode(query)}`,
    index: (query) => `/workspaces/file-index?${folder}&q=${encode(query)}`,
    completion: (query) =>
      `/workspaces/file-completion?${folder}&q=${encode(query)}`,
  };
}

/** Replaces `[start, end)` and puts the caret at `start + caret`. */
export function replaceRange(
  area: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  caret: number,
): void {
  area.value = area.value.slice(0, start) + text + area.value.slice(end);
  const position = start + caret;
  area.setSelectionRange(position, position);
  area.focus();
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

export function setComposerValue(
  area: HTMLTextAreaElement,
  value: string,
): void {
  area.value = value;
  area.setSelectionRange(value.length, value.length);
  area.dispatchEvent(new Event("input", { bubbles: true }));
}
