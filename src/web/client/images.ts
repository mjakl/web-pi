import { imageLimitError, MAX_IMAGES } from "@core/composer";
import { showToast } from "./toasts.ts";
import {
  ATTACHMENT_REMOVE_ICON,
  IMAGE_PREVIEW_CLOSE_ICON,
} from "@web/views/icons";

// Attachments live in one hidden file input, so the form posts them without
// any help from htmx. Anything over a megabyte is downscaled first: a phone
// photo is 4 MB of pixels the model cannot use.

const COMPRESS_ABOVE_BYTES = 1024 * 1024;
const MAX_SIDE = 1024;
const JPEG_QUALITY = 0.85;

async function downscale(file: File): Promise<File> {
  if (file.size <= COMPRESS_ABOVE_BYTES || file.type === "image/gif") {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(
        1,
        MAX_SIDE / Math.max(bitmap.width, bitmap.height),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext("2d");
      if (!context) return file;
      // JPEG has no alpha; flatten onto white so transparency is not black.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
      });
      // Only worth it when the result really is smaller than the original.
      if (!jpeg || jpeg.size >= file.size) return file;
      return new File([jpeg], `${file.name}.jpg`, { type: "image/jpeg" });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

export type Attachments = {
  add(files: readonly File[]): void;
  clear(): void;
  count(): number;
  /** Removes only the Files present in this submission, not later additions. */
  submitted(): () => void;
};

type ImageDraft = {
  files: File[];
  pending: number;
  generation: number;
  changed: Set<() => void>;
};
const imageDrafts = new Map<string, ImageDraft>();

export function setUpImages(
  changed: () => void,
  owner: ParentNode = document,
  signal?: AbortSignal,
  storageKey?: string,
  restored = false,
): Attachments {
  let key = storageKey;
  const input = owner.querySelector<HTMLInputElement>("#image-input");
  const previews = owner.querySelector<HTMLElement>("#image-previews");
  const draft = (key === undefined ? undefined : imageDrafts.get(key)) ?? {
    files: [],
    pending: 0,
    generation: 0,
    changed: new Set<() => void>(),
  };
  if (key !== undefined) imageDrafts.set(key, draft);
  if (restored) {
    draft.files.length = 0;
    draft.pending = 0;
    draft.generation += 1;
  }
  document.body.addEventListener(
    "web-pi:session-created",
    (event) => {
      const detail = (event as CustomEvent<{ cwd?: string; id?: string }>)
        .detail;
      if (!detail?.id || key !== `new:${detail.cwd ?? ""}`) return;
      imageDrafts.delete(key);
      key = detail.id;
      imageDrafts.set(key, draft);
    },
    { signal },
  );
  const attached = draft.files;
  let initializing = true;
  draft.changed.add(paint);
  const notify = () => {
    for (const paint of draft.changed) paint();
  };
  signal?.addEventListener(
    "abort",
    () => {
      draft.changed.delete(paint);
      for (const image of previews?.querySelectorAll("img") ?? [])
        URL.revokeObjectURL(image.src);
    },
    { once: true },
  );

  function paint(): void {
    if (signal?.aborted || !input || !previews) return;
    const transfer = new DataTransfer();
    for (const file of attached) transfer.items.add(file);
    input.files = transfer.files;
    for (const url of previews.querySelectorAll("img")) {
      URL.revokeObjectURL(url.src);
    }
    previews.replaceChildren();
    previews.hidden = attached.length === 0;
    for (const file of attached) {
      const wrapper = document.createElement("div");
      wrapper.className = "composer-image-preview";
      const image = document.createElement("img");
      image.src = URL.createObjectURL(file);
      image.alt = "";
      image.className = "composer-image-thumbnail";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-image-remove";
      // views/icons.tsx #49, drawn here because the strip is built in the
      // browser: the files never reach the server before they are sent.
      remove.innerHTML = ATTACHMENT_REMOVE_ICON;
      remove.setAttribute("aria-label", "Remove image");
      // By identity, never by the index this closure was built with: a
      // downscale finishing in the meantime renumbers the list.
      remove.addEventListener(
        "click",
        () => {
          const at = attached.indexOf(file);
          if (at === -1) return;
          attached.splice(at, 1);
          notify();
        },
        { signal },
      );
      wrapper.append(image, remove);
      previews.append(wrapper);
    }
    input
      .closest("#composer")
      ?.toggleAttribute("data-has-images", attached.length > 0);
    // An attachment turns the send button on, and turns `!` shell mode off.
    if (!initializing) changed();
  }

  function add(files: readonly File[]): void {
    if (signal?.aborted) return;
    const generation = draft.generation;
    const room = MAX_IMAGES - attached.length - draft.pending;
    const images = files.filter((file) => file.type.startsWith("image/"));
    const accepted = images.slice(0, Math.max(room, 0));
    if (images.length < files.length) {
      showToast("Only images can be attached.", "warning");
    }
    if (accepted.length < images.length) {
      showToast(`At most ${String(MAX_IMAGES)} images per message.`, "warning");
    }
    if (accepted.length === 0) return;
    draft.pending += accepted.length;
    // Compression belongs to the draft, not to whichever form is mounted.
    void Promise.all(accepted.map(downscale)).then((processed) => {
      if (generation !== draft.generation) return;
      draft.pending -= accepted.length;
      const problem = imageLimitError(
        [...attached, ...processed].map((file) => ({
          mimeType: file.type,
          bytes: file.size,
        })),
      );
      if (problem) {
        showToast(problem, "warning");
        return;
      }
      attached.push(...processed);
      notify();
    });
  }

  input?.addEventListener(
    "change",
    () => {
      const picked = [...(input.files ?? [])];
      // The input is also where the form reads from; take the pick and rebuild.
      input.value = "";
      add(picked);
    },
    { signal },
  );
  owner.querySelector("#attach-image")?.addEventListener(
    "click",
    () => {
      input?.click();
    },
    { signal },
  );
  document.addEventListener(
    "paste",
    (event) => {
      const items = [...(event.clipboardData?.items ?? [])].filter((item) =>
        item.type.startsWith("image/"),
      );
      if (items.length === 0) return;
      event.preventDefault();
      add(
        items.map((item) => item.getAsFile()).filter((file) => file !== null),
      );
    },
    { signal },
  );
  // Images a recall took back out of the queue arrive as base64 in a hidden
  // element; they become Files again so the next send carries them. The
  // fragment rides out of band. Every swap task emits a settle event;
  // draining the holder makes repeated events harmless.
  const drainRecalled = (): void => {
    if (signal?.aborted) return;
    const target =
      owner.querySelector("#recalled-images") ??
      document.getElementById("recalled-images");
    if (!target?.firstElementChild) return;
    const recalled: File[] = [];
    for (const item of target.querySelectorAll<HTMLElement>("[data-image]")) {
      const data = item.dataset["image"] ?? "";
      const mime = item.dataset["mime"] ?? "image/png";
      if (data === "") continue;
      try {
        const bytes = Uint8Array.from(atob(data), (c) => c.codePointAt(0) ?? 0);
        recalled.push(
          new File([bytes], `recalled.${mime.split("/")[1] ?? "png"}`, {
            type: mime,
          }),
        );
      } catch {
        // A payload the browser cannot decode is simply not restored.
      }
    }
    target.replaceChildren();
    // They join what is attached already, up to the same limit.
    const room = Math.max(MAX_IMAGES - attached.length - draft.pending, 0);
    const left = recalled.length - room;
    if (left > 0) {
      showToast(
        `At most ${String(MAX_IMAGES)} images per message: ${String(left)} recalled image${left === 1 ? " was" : "s were"} not attached.`,
        "warning",
      );
    }
    if (room > 0 && recalled.length > 0) {
      attached.push(...recalled.slice(0, room));
      notify();
    }
  };
  document.body.addEventListener("htmx:after:settle", drainRecalled, {
    signal,
  });
  drainRecalled();
  paint();
  initializing = false;

  return {
    add,
    clear() {
      draft.generation += 1;
      draft.pending = 0;
      attached.length = 0;
      notify();
    },
    count: () => attached.length,
    submitted() {
      const generation = draft.generation;
      const sent = new Set(attached);
      return () => {
        if (draft.generation !== generation) return;
        for (let index = attached.length - 1; index >= 0; index -= 1) {
          const file = attached[index];
          if (file && sent.has(file)) attached.splice(index, 1);
        }
        notify();
      };
    },
  };
}

/**
 * pi-web's ImagePreview: a click on a transcript image opens it in a modal
 * over the dimmed app, with Escape, a backdrop click and the close button all
 * closing it and handing focus back to the thumbnail.
 */
export function setUpImagePreview(): void {
  document.body.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest<HTMLElement>("[data-image-preview]");
    if (!trigger) return;
    const source = trigger.dataset["imagePreview"] ?? "";
    if (source === "") return;
    event.preventDefault();
    openPreview(trigger, source);
  });
}

function openPreview(trigger: HTMLElement, source: string): void {
  const dialog = document.createElement("dialog");
  dialog.className = "image-preview-dialog";
  dialog.setAttribute("aria-label", "Preview image");
  const image = document.createElement("img");
  image.className = "image-preview-image";
  image.src = source;
  // pi-web hands the modal the thumbnail's own alt (ImagePreview.tsx).
  image.alt = trigger.querySelector("img")?.alt ?? "";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "image-preview-close";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  // views/icons.tsx #49 at 16px, drawn here because the dialog is built in
  // the browser.
  close.innerHTML = IMAGE_PREVIEW_CLOSE_ICON;
  dialog.append(image, close);
  document.body.append(dialog);
  trigger.setAttribute("aria-expanded", "true");
  const dismiss = () => {
    if (dialog.open) dialog.close();
  };
  close.addEventListener("click", dismiss);
  // Only the dialog box itself: a click on the image inside it bubbles here
  // with the image as its target.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dismiss();
  });
  // Escape must not also reach the shell, which would close something else.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    trigger.setAttribute("aria-expanded", "false");
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  });
  dialog.showModal();
  close.focus({ preventScroll: true });
}
