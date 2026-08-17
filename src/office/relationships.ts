import { posix } from "node:path";

import { OpenFileError } from "../errors.js";
import { attribute, startTags } from "./xml.js";

export interface Relationship {
  readonly id: string;
  readonly target: string;
  readonly external: boolean;
}

export function readRelationships(xml: string): ReadonlyMap<string, Relationship> {
  const relationships = new Map<string, Relationship>();
  for (const tag of startTags(xml, "Relationship")) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (id === undefined || target === undefined || relationships.has(id)) {
      throw new OpenFileError("FILE_PARSE_FAILED", "The Office relationship table is invalid.");
    }
    relationships.set(
      id,
      Object.freeze({ id, target, external: attribute(tag, "TargetMode") === "External" })
    );
  }
  return relationships;
}

export function resolveRelationshipTarget(baseDirectory: string, relationship: Relationship): string {
  if (relationship.external) return relationship.target;
  const normalized = posix.normalize(posix.join(baseDirectory, relationship.target.replace(/^\/+/, "")));
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    throw new OpenFileError("FILE_PARSE_FAILED", "An Office relationship leaves the container.");
  }
  return normalized;
}
