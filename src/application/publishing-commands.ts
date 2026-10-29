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
