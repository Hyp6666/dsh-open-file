import { describe, expect, it, vi } from "vitest";

import { installPlusMenuGroupAdapter } from "../src/client/plus-menu-adapter.js";

const hit = {
  trigger: "/",
  query: "",
  position: "leading" as const,
  span: { start: 0, end: 0, draftRev: 1 },
};

function store<T>(initial: T) {
  let value = initial;
  return {
    getSnapshot: () => value,
    set: vi.fn((next: T) => { value = next; }),
  };
}

function controller(sources: readonly { trigger: string; name: string; order?: number }[]) {
  const menu = store({ open: false, hit: null, generation: 0, groups: [], highlight: null });
  const launcher = store<string | null>(null);
  const originalToggle = vi.fn();
  return {
    disposed: false,
    launcher,
    menu,
    deps: {
      roster: {
        sources: (trigger: string) => sources
          .filter((source) => source.trigger === trigger)
          .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
      },
    },
    dismiss: vi.fn(),
    stopFetch: vi.fn(),
    reduce: vi.fn(),
    fetchCandidates: vi.fn(),
    toggleSource: originalToggle,
    originalToggle,
  };
}

describe("rc.6 plus-menu group adapter", () => {
  it("opens only command and the owned attachment source from the stock command launcher", () => {
    const sources = [
      { trigger: "/", name: "command", order: 0 },
      { trigger: "/", name: "skill", order: 5 },
      { trigger: "/", name: "添加", order: 10 },
      { trigger: "/", name: "reference", order: 20 },
    ];
    const current = controller(sources);
    const service = {
      live: { controllers: new Map([["session-a", current]]) },
      sessionOf: vi.fn(() => current),
    };
    installPlusMenuGroupAdapter(service, { attachmentSourceName: () => "添加" });

    current.toggleSource("command", hit);

    expect(current.menu.getSnapshot().groups).toEqual([
      { source: "command", status: "pending", items: [] },
      { source: "添加", status: "pending", items: [] },
    ]);
    expect(current.fetchCandidates).toHaveBeenCalledWith(hit, [sources[0], sources[2]]);
    expect(current.originalToggle).not.toHaveBeenCalled();

    current.toggleSource("reference", hit);
    expect(current.originalToggle).toHaveBeenCalledWith("reference", hit);
  });

  it("wraps controllers created later and restores every exact method on dispose", () => {
    const sources = [{ trigger: "/", name: "command" }, { trigger: "/", name: "Add" }];
    const existing = controller(sources);
    const later = controller(sources);
    const originalSessionOf = vi.fn((scope: unknown) => {
      void scope;
      return later;
    });
    const service = {
      live: { controllers: new Map([["session-a", existing]]) },
      sessionOf: originalSessionOf,
    };
    const existingToggle = existing.toggleSource;
    const laterToggle = later.toggleSource;
    const dispose = installPlusMenuGroupAdapter(service, { attachmentSourceName: () => "Add" });
    expect(existing.toggleSource).not.toBe(existingToggle);

    expect(service.sessionOf({})).toBe(later);
    expect(later.toggleSource).not.toBe(laterToggle);
    dispose();

    expect(service.sessionOf).toBe(originalSessionOf);
    expect(existing.toggleSource).toBe(existingToggle);
    expect(later.toggleSource).toBe(laterToggle);
  });

  it("does not overwrite a later toggleSource replacement during disposal", () => {
    const current = controller([{ trigger: "/", name: "command" }]);
    const service = {
      live: { controllers: new Map([["session-a", current]]) },
      sessionOf: vi.fn(() => current),
    };
    const dispose = installPlusMenuGroupAdapter(service, { attachmentSourceName: () => "Add" });
    const laterReplacement = vi.fn();
    current.toggleSource = laterReplacement;

    dispose();

    expect(current.toggleSource).toBe(laterReplacement);
  });

  it("fails closed when the private rc.6 controller seam drifts", () => {
    expect(() => installPlusMenuGroupAdapter({}, { attachmentSourceName: () => "Add" })).toThrowError(
      expect.objectContaining({ code: "FILE_WEB_COMPATIBILITY" }),
    );
    expect(() => installPlusMenuGroupAdapter({
      live: { controllers: new Map([["session-a", { toggleSource: vi.fn() }]]) },
      sessionOf: vi.fn(),
    }, { attachmentSourceName: () => "Add" })).toThrowError(
      expect.objectContaining({ code: "FILE_WEB_COMPATIBILITY" }),
    );
  });
});
