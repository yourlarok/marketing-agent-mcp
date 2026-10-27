CREATE TABLE analysis_graphs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  parent_graph_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_graph_id) REFERENCES analysis_graphs(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX analysis_graphs_workspace_idx ON analysis_graphs(workspace_id, id);
CREATE INDEX analysis_graphs_parent_idx ON analysis_graphs(workspace_id, parent_graph_id);

CREATE TABLE analysis_graph_datasets (
  workspace_id TEXT NOT NULL,
  graph_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (graph_id, dataset_id),
  UNIQUE (graph_id, position),
  FOREIGN KEY (workspace_id, graph_id) REFERENCES analysis_graphs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES datasets(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX analysis_graph_datasets_dataset_idx ON analysis_graph_datasets(workspace_id, dataset_id);

CREATE TABLE analysis_graph_evidence (
  workspace_id TEXT NOT NULL,
  graph_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (graph_id, evidence_id),
  UNIQUE (graph_id, position),
  FOREIGN KEY (workspace_id, graph_id) REFERENCES analysis_graphs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES evidence(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX analysis_graph_evidence_evidence_idx ON analysis_graph_evidence(workspace_id, evidence_id);

INSERT INTO schema_migrations(version, applied_at)
VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
