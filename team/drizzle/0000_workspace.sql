CREATE TABLE review_workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL
);
