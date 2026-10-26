CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS sources_workspace_idx ON sources(workspace_id, id);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS datasets_workspace_idx ON datasets(workspace_id, id);
CREATE INDEX IF NOT EXISTS datasets_source_idx ON datasets(workspace_id, source_id);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS evidence_workspace_idx ON evidence(workspace_id, id);
CREATE INDEX IF NOT EXISTS evidence_source_idx ON evidence(workspace_id, source_id);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS findings_workspace_idx ON findings(workspace_id, id);

CREATE TABLE IF NOT EXISTS finding_evidence (
  workspace_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (finding_id, evidence_id),
  UNIQUE (finding_id, position),
  FOREIGN KEY (workspace_id, finding_id) REFERENCES findings(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finding_evidence_evidence_idx ON finding_evidence(workspace_id, evidence_id);

CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS recommendations_workspace_idx ON recommendations(workspace_id, id);

CREATE TABLE IF NOT EXISTS recommendation_findings (
  workspace_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (recommendation_id, finding_id),
  UNIQUE (recommendation_id, position),
  FOREIGN KEY (workspace_id, recommendation_id) REFERENCES recommendations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, finding_id) REFERENCES findings(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS recommendation_findings_finding_idx ON recommendation_findings(workspace_id, finding_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS tasks_workspace_idx ON tasks(workspace_id, id);

CREATE TABLE IF NOT EXISTS task_recommendations (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (task_id, recommendation_id),
  UNIQUE (task_id, position),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, recommendation_id) REFERENCES recommendations(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS task_recommendations_recommendation_idx ON task_recommendations(workspace_id, recommendation_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (task_id, dependency_id),
  UNIQUE (task_id, position),
  CHECK (task_id <> dependency_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, dependency_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS task_dependencies_dependency_idx ON task_dependencies(workspace_id, dependency_id);

CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  evidence_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS capabilities_workspace_idx ON capabilities(workspace_id, id);
CREATE INDEX IF NOT EXISTS capabilities_evidence_idx ON capabilities(workspace_id, evidence_id);

CREATE TABLE IF NOT EXISTS audit_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_workspace_entity_idx ON audit_records(workspace_id, entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS audit_request_idx ON audit_records(workspace_id, request_id);

CREATE TRIGGER IF NOT EXISTS audit_records_no_update
BEFORE UPDATE ON audit_records
BEGIN
  SELECT RAISE(ABORT, 'audit records are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_records_no_delete
BEFORE DELETE ON audit_records
BEGIN
  SELECT RAISE(ABORT, 'audit records are append-only');
END;

CREATE TABLE IF NOT EXISTS idempotency_records (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_created_idx ON idempotency_records(workspace_id, created_at);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
