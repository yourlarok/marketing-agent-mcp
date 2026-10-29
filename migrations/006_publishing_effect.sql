CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, asset_version_id),
  FOREIGN KEY (workspace_id, asset_version_id) REFERENCES asset_versions(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX approvals_asset_version_idx ON approvals(workspace_id, asset_version_id);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, asset_version_id) REFERENCES asset_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX schedules_due_idx ON schedules(status, scheduled_for);
CREATE INDEX schedules_workspace_idx ON schedules(workspace_id, id);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  schedule_id TEXT NOT NULL,
  asset_version_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, schedule_id),
  UNIQUE (workspace_id, operation_key),
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, asset_version_id) REFERENCES asset_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX publications_recovery_idx ON publications(workspace_id, status, updated_at, id);
CREATE INDEX publications_schedule_idx ON publications(workspace_id, schedule_id);

CREATE TABLE publication_evidence (
  workspace_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (publication_id, evidence_id),
  UNIQUE (publication_id, position),
  FOREIGN KEY (workspace_id, publication_id) REFERENCES publications(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX publication_evidence_evidence_idx ON publication_evidence(workspace_id, evidence_id);

CREATE TABLE metric_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  publication_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, publication_id) REFERENCES publications(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX metric_snapshots_publication_idx ON metric_snapshots(workspace_id, publication_id);

CREATE TABLE metric_snapshot_evidence (
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (snapshot_id, evidence_id),
  UNIQUE (snapshot_id, position),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES metric_snapshots(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX metric_snapshot_evidence_evidence_idx ON metric_snapshot_evidence(workspace_id, evidence_id);

CREATE TABLE effect_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX effect_reviews_workspace_idx ON effect_reviews(workspace_id, id);

CREATE TABLE effect_review_publications (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (review_id, publication_id),
  UNIQUE (review_id, position),
  FOREIGN KEY (workspace_id, review_id) REFERENCES effect_reviews(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, publication_id) REFERENCES publications(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX effect_review_publications_publication_idx ON effect_review_publications(workspace_id, publication_id);

CREATE TABLE effect_review_metric_snapshots (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (review_id, snapshot_id),
  UNIQUE (review_id, position),
  FOREIGN KEY (workspace_id, review_id) REFERENCES effect_reviews(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES metric_snapshots(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX effect_review_metric_snapshots_snapshot_idx ON effect_review_metric_snapshots(workspace_id, snapshot_id);

CREATE TABLE effect_review_evidence (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (review_id, evidence_id),
  UNIQUE (review_id, position),
  FOREIGN KEY (workspace_id, review_id) REFERENCES effect_reviews(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX effect_review_evidence_evidence_idx ON effect_review_evidence(workspace_id, evidence_id);

CREATE TRIGGER approvals_no_update
BEFORE UPDATE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are immutable');
END;
CREATE TRIGGER approvals_no_delete
BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are immutable');
END;
CREATE TRIGGER metric_snapshots_no_update
BEFORE UPDATE ON metric_snapshots
BEGIN
  SELECT RAISE(ABORT, 'metric snapshots are immutable');
END;
CREATE TRIGGER metric_snapshots_no_delete
BEFORE DELETE ON metric_snapshots
BEGIN
  SELECT RAISE(ABORT, 'metric snapshots are immutable');
END;
CREATE TRIGGER effect_reviews_no_update
BEFORE UPDATE ON effect_reviews
BEGIN
  SELECT RAISE(ABORT, 'effect reviews are immutable');
END;
CREATE TRIGGER effect_reviews_no_delete
BEFORE DELETE ON effect_reviews
BEGIN
  SELECT RAISE(ABORT, 'effect reviews are immutable');
END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
