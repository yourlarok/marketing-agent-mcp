import type { EntityRecord, JsonValue } from "../application/ports.js";

export interface Workspace extends EntityRecord {
  name: string;
  metadata?: JsonValue;
}

export const SOURCE_TYPES = ["file", "link", "api", "manual", "database"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_OWNERSHIPS = ["owned", "authorized", "external_public"] as const;
export type SourceOwnership = (typeof SOURCE_OWNERSHIPS)[number];

export interface Source extends EntityRecord {
  name: string;
  type: SourceType;
  ownership: SourceOwnership;
  metadata?: JsonValue;
}
