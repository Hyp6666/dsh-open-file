import { DEFAULT_LIMITS, type OpenFileLimits } from "./contracts.js";

export type OpenFileConfig = Partial<OpenFileLimits>;

export function resolveLimits(config: OpenFileConfig = {}): Readonly<OpenFileLimits> {
  return Object.freeze({ ...DEFAULT_LIMITS, ...config });
}
