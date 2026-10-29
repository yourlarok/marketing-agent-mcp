CREATE TRIGGER metric_snapshot_evidence_no_insert_after_snapshot
BEFORE INSERT ON metric_snapshot_evidence
WHEN EXISTS (
  SELECT 1 FROM metric_snapshots
  WHERE workspace_id = NEW.workspace_id AND id = NEW.snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'metric snapshot references are immutable');
END;
CREATE TRIGGER metric_snapshot_evidence_no_update
BEFORE UPDATE ON metric_snapshot_evidence
WHEN EXISTS (
  SELECT 1 FROM metric_snapshots
  WHERE workspace_id = OLD.workspace_id AND id = OLD.snapshot_id
) OR EXISTS (
  SELECT 1 FROM metric_snapshots
  WHERE workspace_id = NEW.workspace_id AND id = NEW.snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'metric snapshot references are immutable');
END;
CREATE TRIGGER metric_snapshot_evidence_no_delete
BEFORE DELETE ON metric_snapshot_evidence
WHEN EXISTS (
  SELECT 1 FROM metric_snapshots
  WHERE workspace_id = OLD.workspace_id AND id = OLD.snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'metric snapshot references are immutable');
END;

CREATE TRIGGER effect_review_publications_no_insert_after_review
BEFORE INSERT ON effect_review_publications
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = NEW.workspace_id AND id = NEW.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;
CREATE TRIGGER effect_review_publications_no_update
BEFORE UPDATE ON effect_review_publications
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = OLD.workspace_id AND id = OLD.review_id
) OR EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = NEW.workspace_id AND id = NEW.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;
CREATE TRIGGER effect_review_publications_no_delete
BEFORE DELETE ON effect_review_publications
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = OLD.workspace_id AND id = OLD.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;

CREATE TRIGGER effect_review_metric_snapshots_no_insert_after_review
BEFORE INSERT ON effect_review_metric_snapshots
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = NEW.workspace_id AND id = NEW.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;
CREATE TRIGGER effect_review_metric_snapshots_no_update
BEFORE UPDATE ON effect_review_metric_snapshots
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = OLD.workspace_id AND id = OLD.review_id
) OR EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = NEW.workspace_id AND id = NEW.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;
CREATE TRIGGER effect_review_metric_snapshots_no_delete
BEFORE DELETE ON effect_review_metric_snapshots
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = OLD.workspace_id AND id = OLD.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;

CREATE TRIGGER effect_review_evidence_no_insert_after_review
BEFORE INSERT ON effect_review_evidence
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = NEW.workspace_id AND id = NEW.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;
CREATE TRIGGER effect_review_evidence_no_update
BEFORE UPDATE ON effect_review_evidence
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = OLD.workspace_id AND id = OLD.review_id
) OR EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = NEW.workspace_id AND id = NEW.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;
CREATE TRIGGER effect_review_evidence_no_delete
BEFORE DELETE ON effect_review_evidence
WHEN EXISTS (
  SELECT 1 FROM effect_reviews
  WHERE workspace_id = OLD.workspace_id AND id = OLD.review_id
)
BEGIN
  SELECT RAISE(ABORT, 'effect review references are immutable');
END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
