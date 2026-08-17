// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { createNativeImageSink } from "../src/client/native-images.js";

function image(): File {
  return new File(["pixels"], "photo.png", { type: "image/png" });
}

describe("rc.6 native image draft adapter", () => {
  it("creates native drafts and appends their ids through the public input action", () => {
    const drafts = [{ id: "draft-a" }, { id: "draft-b" }];
    const createDraftImages = vi.fn(() => drafts);
    const releaseDraftImages = vi.fn();
    const addImages = vi.fn(() => true);
    const sink = createNativeImageSink(
      { createDraftImages, releaseDraftImages },
      { addImages },
    );
    const files = [image(), image()];

    sink.add(files);

    expect(createDraftImages).toHaveBeenCalledWith(files);
    expect(addImages).toHaveBeenCalledWith(["draft-a", "draft-b"]);
    expect(releaseDraftImages).not.toHaveBeenCalled();
  });

  it("releases native draft objects when the input machine refuses admission", () => {
    const drafts = [{ id: "draft-a" }];
    const releaseDraftImages = vi.fn();
    const sink = createNativeImageSink(
      { createDraftImages: () => drafts, releaseDraftImages },
      { addImages: () => false },
    );

    sink.add([image()]);

    expect(releaseDraftImages).toHaveBeenCalledWith(drafts);
  });

  it("fails with an explicit compatibility error if either rc.6 seam drifts", () => {
    expect(() => createNativeImageSink({}, { addImages: () => true })).toThrowError(
      expect.objectContaining({ code: "FILE_WEB_COMPATIBILITY" }),
    );
    expect(() =>
      createNativeImageSink(
        { createDraftImages: () => [], releaseDraftImages: () => undefined },
        {},
      ),
    ).toThrowError(expect.objectContaining({ code: "FILE_WEB_COMPATIBILITY" }));
  });
});
