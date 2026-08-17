import { OpenFileError } from "../errors.js";
import { canonicalService } from "./canonical.js";

const ADAPTER = Symbol.for("dsh-open-file.rc6.plus-menu-adapter");

interface TriggerSourceShape {
  readonly trigger: string;
  readonly name: string;
  readonly order?: number;
}

interface HitShape {
  readonly trigger: string;
  readonly [key: string]: unknown;
}

interface SnapshotStoreShape {
  getSnapshot(): unknown;
  set(value: unknown): void;
}

type ToggleSource = (source: string, hit: HitShape) => void;

interface ControllerShape {
  toggleSource: ToggleSource;
  launcher: SnapshotStoreShape;
  menu: SnapshotStoreShape;
  deps: {
    roster: {
      sources(trigger: string): readonly TriggerSourceShape[];
    };
  };
  dismiss(): void;
  stopFetch(): void;
  reduce(action: unknown): void;
  fetchCandidates(hit: HitShape, sources: readonly TriggerSourceShape[]): void;
  hit?: HitShape;
}

type SessionOf = (...args: unknown[]) => unknown;

interface WrappedController {
  readonly original: ToggleSource;
  readonly wrapped: ToggleSource;
}

interface ServiceShape {
  live: { controllers: Map<unknown, unknown> };
  sessionOf: SessionOf;
  [ADAPTER]?: unknown;
}

export interface PlusMenuGroupAdapterOptions {
  readonly attachmentSourceName: () => string;
}

function compatibility(message: string): OpenFileError {
  return new OpenFileError("FILE_WEB_COMPATIBILITY", message);
}

function record(value: unknown): Record<PropertyKey, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<PropertyKey, unknown>
    : undefined;
}

function storeShape(value: unknown): SnapshotStoreShape | undefined {
  const candidate = record(value);
  return candidate !== undefined &&
    typeof candidate.getSnapshot === "function" &&
    typeof candidate.set === "function"
    ? candidate as unknown as SnapshotStoreShape
    : undefined;
}

function controllerShape(value: unknown): ControllerShape {
  const candidate = record(value);
  const deps = record(candidate?.deps);
  const roster = record(deps?.roster);
  if (
    candidate === undefined ||
    typeof candidate.toggleSource !== "function" ||
    storeShape(candidate.launcher) === undefined ||
    storeShape(candidate.menu) === undefined ||
    typeof roster?.sources !== "function" ||
    typeof candidate.dismiss !== "function" ||
    typeof candidate.stopFetch !== "function" ||
    typeof candidate.reduce !== "function" ||
    typeof candidate.fetchCandidates !== "function"
  ) {
    throw compatibility("DSH rc.6 plus-menu controller does not match the supported contract.");
  }
  return candidate as unknown as ControllerShape;
}

function serviceShape(value: unknown): ServiceShape {
  const canonical = canonicalService(value);
  const candidate = record(canonical);
  const live = record(candidate?.live);
  if (
    candidate === undefined ||
    typeof candidate.sessionOf !== "function" ||
    !(live?.controllers instanceof Map)
  ) {
    throw compatibility("DSH rc.6 plus-menu service does not match the supported contract.");
  }
  return candidate as unknown as ServiceShape;
}

function menuSnapshot(value: unknown): Record<string, unknown> {
  const snapshot = record(value);
  if (snapshot === undefined || typeof snapshot.open !== "boolean") {
    throw compatibility("DSH rc.6 plus-menu state does not match the supported contract.");
  }
  return snapshot as Record<string, unknown>;
}

function sourceRoster(value: unknown): value is readonly TriggerSourceShape[] {
  return Array.isArray(value) && value.every((item: unknown) => {
    const candidate = record(item);
    return typeof candidate?.trigger === "string" && typeof candidate.name === "string";
  });
}

export function installPlusMenuGroupAdapter(
  serviceValue: unknown,
  options: PlusMenuGroupAdapterOptions,
): () => void {
  const service = serviceShape(serviceValue);
  if (service[ADAPTER] !== undefined) {
    throw compatibility("The rc.6 plus-menu adapter is already installed.");
  }
  const originalSessionOf = service.sessionOf;
  const wrappedControllers = new Map<ControllerShape, WrappedController>();

  const wrapController = (value: unknown): ControllerShape => {
    const controller = controllerShape(value);
    if (wrappedControllers.has(controller)) return controller;
    const originalToggleSource = controller.toggleSource;
    const wrappedToggleSource: ToggleSource = (source, hit) => {
      if (source !== "command") {
        originalToggleSource.call(controller, source, hit);
        return;
      }
      const currentMenu = menuSnapshot(controller.menu.getSnapshot());
      if (controller.launcher.getSnapshot() === source && currentMenu.open === true) {
        controller.dismiss();
        return;
      }
      const rosterValue: unknown = controller.deps.roster.sources(hit.trigger);
      if (!sourceRoster(rosterValue)) {
        throw compatibility("DSH rc.6 plus-menu source roster does not match the supported contract.");
      }
      const attachmentSourceName = options.attachmentSourceName();
      if (typeof attachmentSourceName !== "string" || attachmentSourceName.length === 0) {
        throw compatibility("The dsh-open-file attachment source name is unavailable.");
      }
      const sources = rosterValue.filter(
        (item) => item.name === source || item.name === attachmentSourceName,
      );
      if (!sources.some((item) => item.name === source)) {
        controller.dismiss();
        return;
      }
      controller.stopFetch();
      controller.hit = hit;
      controller.launcher.set(source);
      controller.menu.set({
        ...currentMenu,
        groups: sources.map((item) => ({
          source: item.name,
          status: "pending",
          items: [],
        })),
        highlight: null,
      });
      controller.reduce({ type: "hit", hit });
      controller.fetchCandidates(hit, sources);
    };
    wrappedControllers.set(controller, {
      original: originalToggleSource,
      wrapped: wrappedToggleSource,
    });
    controller.toggleSource = wrappedToggleSource;
    return controller;
  };

  try {
    for (const controller of service.live.controllers.values()) wrapController(controller);
    const wrappedSessionOf: SessionOf = function(this: unknown, ...args: unknown[]) {
      return wrapController(originalSessionOf.apply(this, args));
    };
    service.sessionOf = wrappedSessionOf;
    service[ADAPTER] = Object.freeze({ wrappedSessionOf });
  } catch (error) {
    for (const [controller, state] of wrappedControllers) {
      if (controller.toggleSource === state.wrapped) controller.toggleSource = state.original;
    }
    throw error;
  }

  return () => {
    const marker = record(service[ADAPTER]);
    const wrappedSessionOf = marker?.wrappedSessionOf;
    if (service.sessionOf === wrappedSessionOf) service.sessionOf = originalSessionOf;
    for (const [controller, state] of wrappedControllers) {
      if (controller.toggleSource === state.wrapped) controller.toggleSource = state.original;
    }
    if (service[ADAPTER] !== undefined) delete service[ADAPTER];
  };
}
