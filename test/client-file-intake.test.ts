// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  FileIntakeCoordinator,
  partitionAttachmentFiles,
} from "../src/client/file-intake.js";

function file(name: string, type: string): File {
  return new File(["data"], name, { type });
}

describe("attachment intake arbitration", () => {
  it("keeps only the four DSH-native image MIME types on the native path", () => {
    const png = file("a.png", "image/png");
    const jpeg = file("b.jpg", "image/jpeg");
    const webp = file("c.webp", "image/webp");
    const gif = file("d.gif", "image/gif");
    const svg = file("e.svg", "image/svg+xml");
    const spoofed = file("f.png", "application/octet-stream");

    expect(partitionAttachmentFiles([png, jpeg, webp, gif, svg, spoofed])).toEqual({
      nativeImages: [png, jpeg, webp, gif],
      ordinaryFiles: [svg, spoofed],
    });
  });

  it("delegates native images and enqueues all other files exactly once", () => {
    const enqueue = vi.fn();
    const addNativeImages = vi.fn();
    const intake = new FileIntakeCoordinator({ enqueue });
    intake.registerNativeImageSink("session-a", { add: addNativeImages });
    const png = file("native.png", "image/png");
    const pdf = file("report.pdf", "application/pdf");
    const svg = file("drawing.svg", "image/svg+xml");

    intake.accept("session-a", [png, pdf, svg]);

    expect(addNativeImages).toHaveBeenCalledOnce();
    expect(addNativeImages).toHaveBeenCalledWith([png]);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith("session-a", [pdf, svg]);
  });

  it("fails closed when the native DSH draft seam is unavailable", () => {
    const enqueue = vi.fn();
    const intake = new FileIntakeCoordinator({ enqueue });

    expect(() => intake.accept("session-a", [file("native.png", "image/png")])).toThrowError(
      expect.objectContaining({ code: "FILE_WEB_COMPATIBILITY" }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("removes only the sink registration it created", () => {
    const intake = new FileIntakeCoordinator({ enqueue: vi.fn() });
    const first = { add: vi.fn() };
    const second = { add: vi.fn() };
    const disposeFirst = intake.registerNativeImageSink("session-a", first);
    intake.registerNativeImageSink("session-a", second);
    disposeFirst();

    intake.accept("session-a", [file("native.gif", "image/gif")]);
    expect(first.add).not.toHaveBeenCalled();
    expect(second.add).toHaveBeenCalledOnce();
  });
});
