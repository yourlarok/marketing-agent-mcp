CREATE TABLE benchmark_analyses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  competitor_diff_id TEXT,
  version INTEGER NOT NULL CHECK (version = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, competitor_diff_id) REFERENCES competitor_diffs(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX benchmark_analyses_workspace_idx ON benchmark_analyses(workspace_id, id);

CREATE TABLE benchmark_analysis_evidence (
  workspace_id TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (analysis_id, evidence_id),
  UNIQUE (analysis_id, position),
  FOREIGN KEY (workspace_id, analysis_id) REFERENCES benchmark_analyses(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX benchmark_analysis_evidence_evidence_idx ON benchmark_analysis_evidence(workspace_id, evidence_id);

CREATE TABLE benchmark_analysis_sources (
  workspace_id TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (analysis_id, source_id),
  UNIQUE (analysis_id, position),
  FOREIGN KEY (workspace_id, analysis_id) REFERENCES benchmark_analyses(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX benchmark_analysis_sources_source_idx ON benchmark_analysis_sources(workspace_id, source_id);

CREATE TABLE content_briefs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL,
  benchmark_analysis_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recommendation_id) REFERENCES recommendations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, benchmark_analysis_id) REFERENCES benchmark_analyses(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX content_briefs_workspace_idx ON content_briefs(workspace_id, id);

CREATE TABLE content_brief_findings (
  workspace_id TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (brief_id, finding_id),
  UNIQUE (brief_id, position),
  FOREIGN KEY (workspace_id, brief_id) REFERENCES content_briefs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, finding_id) REFERENCES findings(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX content_brief_findings_finding_idx ON content_brief_findings(workspace_id, finding_id);

CREATE TABLE content_brief_evidence (
  workspace_id TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (brief_id, evidence_id),
  UNIQUE (brief_id, position),
  FOREIGN KEY (workspace_id, brief_id) REFERENCES content_briefs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX content_brief_evidence_evidence_idx ON content_brief_evidence(workspace_id, evidence_id);

CREATE TABLE content_brief_sources (
  workspace_id TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (brief_id, source_id),
  UNIQUE (brief_id, position),
  FOREIGN KEY (workspace_id, brief_id) REFERENCES content_briefs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX content_brief_sources_source_idx ON content_brief_sources(workspace_id, source_id);

CREATE TABLE asset_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  content_id TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL,
  parent_version_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, content_id, version),
  UNIQUE (workspace_id, parent_version_id),
  CHECK (
    (version = 1 AND parent_version_id IS NULL)
    OR
    (version > 1 AND parent_version_id IS NOT NULL AND id <> parent_version_id)
  ),
  FOREIGN KEY (workspace_id, brief_id) REFERENCES content_briefs(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recommendation_id) REFERENCES recommendations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, parent_version_id) REFERENCES asset_versions(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX asset_versions_workspace_content_idx ON asset_versions(workspace_id, content_id, version);
CREATE INDEX asset_versions_parent_idx ON asset_versions(workspace_id, parent_version_id);

CREATE TABLE asset_version_evidence (
  workspace_id TEXT NOT NULL,
  asset_version_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (asset_version_id, evidence_id),
  UNIQUE (asset_version_id, position),
  FOREIGN KEY (workspace_id, asset_version_id) REFERENCES asset_versions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX asset_version_evidence_evidence_idx ON asset_version_evidence(workspace_id, evidence_id);

CREATE TABLE asset_version_sources (
  workspace_id TEXT NOT NULL,
  asset_version_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (asset_version_id, source_id),
  UNIQUE (asset_version_id, position),
  FOREIGN KEY (workspace_id, asset_version_id) REFERENCES asset_versions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX asset_version_sources_source_idx ON asset_version_sources(workspace_id, source_id);

CREATE TRIGGER benchmark_analyses_no_update
BEFORE UPDATE ON benchmark_analyses
BEGIN
  SELECT RAISE(ABORT, 'benchmark analyses are immutable');
END;
CREATE TRIGGER benchmark_analyses_no_delete
BEFORE DELETE ON benchmark_analyses
BEGIN
  SELECT RAISE(ABORT, 'benchmark analyses are immutable');
END;
CREATE TRIGGER content_briefs_no_update
BEFORE UPDATE ON content_briefs
BEGIN
  SELECT RAISE(ABORT, 'content briefs are immutable');
END;
CREATE TRIGGER content_briefs_no_delete
BEFORE DELETE ON content_briefs
BEGIN
  SELECT RAISE(ABORT, 'content briefs are immutable');
END;
CREATE TRIGGER asset_versions_no_update
BEFORE UPDATE ON asset_versions
BEGIN
  SELECT RAISE(ABORT, 'asset versions are immutable');
END;
CREATE TRIGGER asset_versions_no_delete
BEFORE DELETE ON asset_versions
BEGIN
  SELECT RAISE(ABORT, 'asset versions are immutable');
END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
