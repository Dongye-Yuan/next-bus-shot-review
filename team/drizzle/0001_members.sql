CREATE TABLE team_member (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('reviewer','viewer','revoked')),
  updated_at TEXT NOT NULL
);
