import { describe, expect, it, vi } from "vitest";
import { byId, click, flush, htmxEvent, mount, query } from "./helpers.ts";

// Attachments: what the picker, the clipboard and a drop may add, the chips
// and their removal, and the downscale a phone photo goes through.

async function load() {
  mount(
    '<div id="toasts"></div><form id="composer">' +
      '<input id="image-input" type="file" multiple>' +
      '<div id="image-previews" hidden></div>' +
      '<button type="button" id="attach-image"></button>' +
      '<div id="recalled-images" hidden></div></form>',
  );
  const { setUpImages } = await import("@web/client/images");
  const changed = vi.fn();
  return { images: setUpImages(changed), changed };
}

function image(name: string, bytes = 16, type = "image/png"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function chips(): HTMLElement[] {
  return [...byId("image-previews").querySelectorAll<HTMLElement>("img")];
}

function input(): HTMLInputElement {
  const element = byId("image-input");
  if (!(element instanceof HTMLInputElement)) throw new Error("no input");
  return element;
}

/** A canvas whose JPEG comes out at the size the test wants. */
function fakeCanvas(jpegBase64Length: number): void {
  vi.stubGlobal("createImageBitmap", () =>
    Promise.resolve({ width: 4000, height: 2000, close: vi.fn() }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    `data:image/jpeg;base64,${"A".repeat(jpegBase64Length)}`,
  );
}

describe("accepted attachment drafts", () => {
  it("clears sent Files without removing additions made while the response was pending", async () => {
    const { images } = await load();
    images.add([image("sent.png")]);
    await flush();
    const accept = images.submitted();
    images.add([image("later.png")]);
    await flush();
    accept();
    accept();
    expect([...(input().files ?? [])].map((file) => file.name)).toEqual([
      "later.png",
    ]);
  });

  it("does not remove a File deliberately re-added after clearing the draft", async () => {
    const { images } = await load();
    const file = image("same.png");
    images.add([file]);
    await flush();
    const accept = images.submitted();
    images.clear();
    images.add([file]);
    await flush();
    accept();
    expect([...(input().files ?? [])]).toEqual([file]);
  });
});

describe("adding images", () => {
  it("keeps only images, paints a chip each, and fills the form's file input", async () => {
    const { images, changed } = await load();
    images.add([
      image("a.png"),
      new File(["x"], "notes.txt", { type: "text/plain" }),
    ]);
    await flush();
    expect(images.count()).toBe(1);
    expect(chips()).toHaveLength(1);
    expect(input().files?.length).toBe(1);
    expect(byId("image-previews").hidden).toBe(false);
    expect(byId("composer").hasAttribute("data-has-images")).toBe(true);
    expect(changed).toHaveBeenCalled();
  });

  it("refuses more than ten and says so", async () => {
    const { images } = await load();
    images.add(
      Array.from({ length: 11 }, (_, index) => image(`${String(index)}.png`)),
    );
    await flush();
    expect(images.count()).toBe(10);
    expect(byId("toasts").textContent).toContain(
      "At most 10 images per message.",
    );
    images.add([image("more.png")]);
    await flush();
    expect(images.count()).toBe(10);
  });

  it("refuses an image over ten megabytes", async () => {
    const { images } = await load();
    const huge = image("huge.gif", 1, "image/gif");
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
    images.add([huge]);
    await flush();
    expect(images.count()).toBe(0);
    expect(byId("toasts").textContent).toContain("10 MB or smaller");
  });

  it("removes a chip by identity even while a later add is still downscaling", async () => {
    let finish: (bitmap: {
      width: number;
      height: number;
      close(): void;
    }) => void = () => {};
    vi.stubGlobal(
      "createImageBitmap",
      () =>
        new Promise<{ width: number; height: number; close(): void }>(
          (resolve) => {
            finish = resolve;
          },
        ),
    );
    const { images } = await load();
    images.add([image("first.png")]);
    await flush();
    images.add([image("big.png", 1024 * 1024 + 1)]);
    await flush();
    click(query("#image-previews button"));
    expect(images.count()).toBe(0);
    finish({ width: 10, height: 10, close: vi.fn() });
    await flush();
    expect(images.count()).toBe(1);
    expect(input().files?.[0]?.name).toBe("big.png");
  });

  it("clears every attachment", async () => {
    const { images } = await load();
    images.add([image("a.png"), image("b.png")]);
    await flush();
    images.clear();
    expect(images.count()).toBe(0);
    expect(chips()).toHaveLength(0);
    expect(byId("image-previews").hidden).toBe(true);
    expect(byId("composer").hasAttribute("data-has-images")).toBe(false);
  });
});

describe("where images come from", () => {
  it("takes a pasted image and leaves other pastes alone", async () => {
    const { images } = await load();
    const paste = (items: { type: string; getAsFile(): File | null }[]) => {
      const event = Object.assign(
        new Event("paste", { bubbles: true, cancelable: true }),
        { clipboardData: { items } },
      );
      document.dispatchEvent(event);
      return event;
    };
    expect(
      paste([{ type: "text/plain", getAsFile: () => null }]).defaultPrevented,
    ).toBe(false);
    const file = image("shot.png");
    expect(
      paste([{ type: "image/png", getAsFile: () => file }]).defaultPrevented,
    ).toBe(true);
    await flush();
    expect(images.count()).toBe(1);
  });

  it("opens the picker from the attach button and takes its pick", async () => {
    const { images } = await load();
    const open = vi.spyOn(input(), "click").mockImplementation(() => {});
    click(byId("attach-image"));
    expect(open).toHaveBeenCalledOnce();
    const transfer = new DataTransfer();
    transfer.items.add(image("picked.png"));
    input().files = transfer.files;
    input().dispatchEvent(new Event("change"));
    await flush();
    expect(images.count()).toBe(1);
    expect(input().files?.[0]?.name).toBe("picked.png");
  });

  it("restores images a queue recall handed back as base64", async () => {
    const { images } = await load();
    byId("recalled-images").innerHTML =
      `<span data-image="${btoa("png bytes")}" data-mime="image/png"></span>` +
      '<span data-image="" data-mime="image/png"></span>' +
      '<span data-image="%%%" data-mime="image/png"></span>';
    htmxEvent(document.body, "htmx:after:settle");
    await flush();
    expect(images.count()).toBe(1);
    expect(input().files?.[0]?.name).toBe("recalled.png");
    expect(byId("recalled-images").childElementCount).toBe(0);
  });

  it("adds recalled images after the attached ones, up to ten, and says what was left", async () => {
    const { images } = await load();
    images.add(
      Array.from({ length: 8 }, (_, index) => image(`${String(index)}.png`)),
    );
    await flush();
    byId("recalled-images").innerHTML =
      `<span data-image="${btoa("a")}" data-mime="image/png"></span>`.repeat(3);
    htmxEvent(document.body, "htmx:after:settle");
    expect(images.count()).toBe(10);
    expect(input().files?.[0]?.name).toBe("0.png");
    expect(input().files?.[9]?.name).toBe("recalled.png");
    expect(byId("toasts").textContent).toBe(
      "At most 10 images per message: 1 recalled image was not attached.",
    );
  });
});

describe("image owner cleanup", () => {
  it("restores large historical images byte-for-byte without downscaling", async () => {
    await load();
    const bytes = "x".repeat(1024 * 1024 + 1);
    byId("recalled-images").innerHTML =
      `<span data-image="${btoa(bytes)}" data-mime="image/png"></span>`;
    const bitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmap);
    const { setUpImages } = await import("@web/client/images");
    const images = setUpImages(vi.fn(), byId("composer"));
    expect(images.count()).toBe(1);
    expect(await input().files?.[0]?.text()).toBe(bytes);
    expect(bitmap).not.toHaveBeenCalled();
  });

  it("revokes previews and ignores compression completing after disposal", async () => {
    await load();
    const { setUpImages } = await import("@web/client/images");
    const controller = new AbortController();
    const changed = vi.fn();
    const images = setUpImages(changed, byId("composer"), controller.signal);
    images.add([image("visible.png")]);
    await flush();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    let finish = () => {};
    vi.stubGlobal(
      "createImageBitmap",
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({ width: 1, height: 1, close: vi.fn() });
          };
        }),
    );
    images.add([image("pending.png", 1024 * 1024 + 1)]);
    controller.abort();
    expect(revoke).toHaveBeenCalledOnce();
    changed.mockClear();
    finish();
    await flush();
    expect(changed).not.toHaveBeenCalled();
    expect(input().files).toHaveLength(1);
  });
});

describe("downscaling", () => {
  it("leaves small files and GIFs alone", async () => {
    const bitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmap);
    const { images } = await load();
    images.add([
      image("small.png", 100),
      image("anim.gif", 2 * 1024 * 1024, "image/gif"),
    ]);
    await flush();
    expect(bitmap).not.toHaveBeenCalled();
    expect(images.count()).toBe(2);
  });

  it("re-encodes a large photo as a smaller JPEG", async () => {
    fakeCanvas(400);
    const { images } = await load();
    images.add([image("photo.png", 1024 * 1024 + 1)]);
    await flush();
    const file = input().files?.[0];
    expect(file?.name).toBe("photo.png.jpg");
    expect(file?.type).toBe("image/jpeg");
    expect(file?.size).toBe(300);
  });

  it("keeps the original when the JPEG would not be smaller", async () => {
    fakeCanvas(2 * 1024 * 1024);
    const { images } = await load();
    images.add([image("photo.png", 1024 * 1024 + 1)]);
    await flush();
    expect(input().files?.[0]?.name).toBe("photo.png");
  });

  it("keeps the original when the browser cannot decode it", async () => {
    vi.stubGlobal("createImageBitmap", () => Promise.reject(new Error("bad")));
    const { images } = await load();
    images.add([image("odd.png", 1024 * 1024 + 1)]);
    await flush();
    expect(input().files?.[0]?.name).toBe("odd.png");
  });
});

describe("the preview dialog", () => {
  it("opens a transcript image in a modal and hands focus back", async () => {
    mount(
      '<button type="button" data-image-preview="/static/x.png"><img src="/static/x.png" alt="a chart"></button>',
    );
    const { setUpImagePreview } = await import("@web/client/images");
    setUpImagePreview();
    const trigger = query("[data-image-preview]");
    trigger.focus();
    expect(click(query("[data-image-preview] img")).defaultPrevented).toBe(
      true,
    );
    const dialog = document.querySelector("dialog.image-preview-dialog");
    if (!(dialog instanceof HTMLDialogElement)) throw new Error("no dialog");
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("img")?.alt).toBe("a chart");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    await flush();
    expect(document.querySelector("dialog.image-preview-dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from the button and from a click on the backdrop", async () => {
    mount('<a href="#" data-image-preview="/static/x.png">open</a>');
    const { setUpImagePreview } = await import("@web/client/images");
    setUpImagePreview();
    click(query("[data-image-preview]"));
    click(query(".image-preview-close"));
    await flush();
    expect(document.querySelector("dialog")).toBeNull();
    click(query("[data-image-preview]"));
    click(query(".image-preview-image"));
    expect(document.querySelector("dialog")).not.toBeNull();
    click(query("dialog"));
    await flush();
    expect(document.querySelector("dialog")).toBeNull();
  });
});
