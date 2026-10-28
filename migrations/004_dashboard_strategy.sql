CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX dashboards_workspace_idx ON dashboards(workspace_id, id);

CREATE TABLE dashboard_sources (
  workspace_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (dashboard_id, source_id),
  UNIQUE (dashboard_id, position),
  FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX dashboard_sources_source_idx ON dashboard_sources(workspace_id, source_id);

CREATE TABLE dashboard_datasets (
  workspace_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (dashboard_id, dataset_id),
  UNIQUE (dashboard_id, position),
  FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES datasets(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX dashboard_datasets_dataset_idx ON dashboard_datasets(workspace_id, dataset_id);

CREATE TABLE dashboard_evidence (
  workspace_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (dashboard_id, evidence_id),
  UNIQUE (dashboard_id, position),
  FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX dashboard_evidence_evidence_idx ON dashboard_evidence(workspace_id, evidence_id);

CREATE TABLE dashboard_analysis_graphs (
  workspace_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  graph_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (dashboard_id, graph_id),
  UNIQUE (dashboard_id, position),
  FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, graph_id) REFERENCES analysis_graphs(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX dashboard_analysis_graphs_graph_idx ON dashboard_analysis_graphs(workspace_id, graph_id);

CREATE TABLE dashboard_competitor_diffs (
  workspace_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  diff_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (dashboard_id, diff_id),
  UNIQUE (dashboard_id, position),
  FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, diff_id) REFERENCES competitor_diffs(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX dashboard_competitor_diffs_diff_idx ON dashboard_competitor_diffs(workspace_id, diff_id);

CREATE TABLE dashboard_tasks (
  workspace_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (dashboard_id, task_id),
  UNIQUE (dashboard_id, position),
  FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX dashboard_tasks_task_idx ON dashboard_tasks(workspace_id, task_id);

INSERT INTO schema_migrations(version, applied_at)
VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
