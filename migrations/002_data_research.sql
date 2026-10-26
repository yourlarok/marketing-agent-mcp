CREATE TABLE data_request_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX data_request_plans_workspace_idx ON data_request_plans(workspace_id, id);

CREATE TABLE ingestion_batches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX ingestion_batches_workspace_idx ON ingestion_batches(workspace_id, id);

CREATE TABLE ingestion_batch_sources (
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (batch_id, source_id),
  UNIQUE (batch_id, position),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES ingestion_batches(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ingestion_batch_sources_source_idx ON ingestion_batch_sources(workspace_id, source_id);

CREATE TABLE ingestion_batch_datasets (
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (batch_id, dataset_id),
  UNIQUE (batch_id, position),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES ingestion_batches(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES datasets(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ingestion_batch_datasets_dataset_idx ON ingestion_batch_datasets(workspace_id, dataset_id);

CREATE TABLE ingestion_batch_evidence (
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (batch_id, evidence_id),
  UNIQUE (batch_id, position),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES ingestion_batches(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ingestion_batch_evidence_evidence_idx ON ingestion_batch_evidence(workspace_id, evidence_id);

CREATE TABLE research_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX research_sessions_workspace_idx ON research_sessions(workspace_id, id);

CREATE TABLE research_session_evidence (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (session_id, evidence_id),
  UNIQUE (session_id, position),
  FOREIGN KEY (workspace_id, session_id) REFERENCES research_sessions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX research_session_evidence_evidence_idx ON research_session_evidence(workspace_id, evidence_id);

CREATE TABLE competitors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX competitors_workspace_idx ON competitors(workspace_id, id);

CREATE TABLE competitor_evidence (
  workspace_id TEXT NOT NULL,
  competitor_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (competitor_id, evidence_id),
  UNIQUE (competitor_id, position),
  FOREIGN KEY (workspace_id, competitor_id) REFERENCES competitors(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX competitor_evidence_evidence_idx ON competitor_evidence(workspace_id, evidence_id);

CREATE TABLE competitor_diffs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX competitor_diffs_workspace_idx ON competitor_diffs(workspace_id, id);

CREATE TABLE competitor_diff_findings (
  workspace_id TEXT NOT NULL,
  diff_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (diff_id, finding_id),
  UNIQUE (diff_id, position),
  FOREIGN KEY (workspace_id, diff_id) REFERENCES competitor_diffs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, finding_id) REFERENCES findings(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX competitor_diff_findings_finding_idx ON competitor_diff_findings(workspace_id, finding_id);

INSERT INTO schema_migrations(version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
