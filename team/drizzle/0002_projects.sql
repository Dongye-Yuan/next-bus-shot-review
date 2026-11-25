CREATE TABLE review_project (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
);
