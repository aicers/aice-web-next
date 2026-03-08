CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER PRIMARY KEY DEFAULT 1
);

INSERT INTO _schema_version (version) VALUES (1);
