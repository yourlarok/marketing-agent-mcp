import type { ContentChannel } from "../domain/content-production-model.js";
import type { ApprovalDecision, DeliveryMode } from "../domain/publishing-model.js";

export interface RecordApproval {
  id: string;
  workspaceId: string;
  assetVersionId: string;
  expectedAssetVersion: number;
  decision: ApprovalDecision;
  comment: string;
}

export interface GetApproval {
  id: string;
  workspaceId: string;
}

export interface CreateSchedule {
  id: string;
  publicationId: string;
  workspaceId: string;
  assetVersionId: string;
  expectedAssetVersion: number;
  approvalId: string;
  channel: ContentChannel;
  accountId: string;
  scheduledFor: string;
  timeZone: string;
  deliveryMode: DeliveryMode;
}

export interface Reschedule {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  scheduledFor: string;
  timeZone: string;
}

export interface CancelSchedule {
  id: string;
  workspaceId: string;
  expectedVersion: number;
}

export interface GetSchedule {
  id: string;
  workspaceId: string;
}

export interface PublicationOperation {
  id: string;
  workspaceId: string;
  expectedVersion: number;
}

export interface GetPublication {
  id: string;
  workspaceId: string;
}

export interface ManualComplete {
  id: string;
  workspaceId: string;
  publicationId: string;
  expectedPublicationVersion: number;
  evidenceIds: string[];
  externalPublicationId: string;
  publishedAt: string;
}

export interface GetDeliveryPackage {
  id: string;
  workspaceId: string;
  offset?: number;
  length?: number;
}

export interface DeliveryPackageChunk {
  content: Buffer;
  offset: number;
  length: number;
  totalBytes: number;
  contentHash: string;
  mediaType: "application/json";
}
