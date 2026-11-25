import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/index.js";

test("isolates access, persists shared review revisions and serves private media ranges", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0000_workspace.sql", import.meta.url), "utf8"));
  const files = new Map();
  const env = {
    OWNER_EMAIL: "owner@example.com", REVIEWER_EMAILS: "reviewer@example.com", VIEWER_EMAILS: "viewer@example.com",
    DB: { prepare: (sql) => ({
      first: () => db.prepare(sql).get(),
      bind: (...parameters) => ({ run: () => ({ meta: db.prepare(sql).run(...parameters) }) }),
    }) },
    BUCKET: {
      put: (id, file) => files.set(id, file),
      delete: (id) => files.delete(id),
      head: (id) => {
        const file = files.get(id);
        return file && { size: file.size, writeHttpMetadata: (h) => h.set("Content-Type", file.type) };
      },
      get: (id, { range } = {}) => ({ body: range
        ? files.get(id).slice(range.offset, range.offset + range.length)
        : files.get(id) }),
    },
  };
  const origin = "https://test.example";
  const send = (path, role, options = {}) => worker.fetch(new Request(origin + path, {
    ...options, headers: { ...options.headers, ...(role ? {
      "oai-authenticated-user-id": role, "oai-authenticated-user-email": role + "@example.com",
    } : {}) },
  }), env);
  const action = (role, revision, kind, version, extra = {}, caller = origin) => send("/api/review", role, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: caller },
    body: JSON.stringify({ revision, kind, version, ...extra }),
  });
  assert.equal((await send("/api/state")).status, 403);
  assert.equal((await send("/api/state", "outsider")).status, 403);
  assert.equal((await action("viewer", 0, "pick", "04-flow")).status, 403);
  assert.equal((await action("owner", 0, "pick", "04-flow", {}, "https://other.example")).status, 403);
  assert.equal((await action("reviewer", 0, "pick", "04-failed")).status, 400);
  assert.equal((await action("reviewer", 0, "review", "04-failed", { status: "rejected" })).status, 400);
  assert.equal((await action("owner", 0, "pick", "04-flow")).status, 200);
  assert.equal((await action("reviewer", 0, "pick", "04-doubao")).status, 409);
  const form = new FormData();
  form.append("shot", "04");
  form.append("file", new File(["media bytes"], "test.mp4", { type: "video/mp4" }));
  const uploaded = await send("/api/upload", "reviewer", { method: "POST", headers: { Origin: origin }, body: form });
  assert.equal(uploaded.status, 200);
  const version = (await uploaded.json()).state.versions.at(-1);
  assert.equal(version.status, "pending");
  assert.equal((await send(version.file)).status, 403);
  const range = await send(version.file, "viewer", { headers: { Range: "bytes=0-4" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "media");
  assert.equal((await action("reviewer", 2, "review", version.id, { status: "approved", note: "checked" })).status, 200);
  assert.equal((await action("reviewer", 3, "pick", version.id, { note: "checked" })).status, 200);
  const latest = await (await send("/api/state", "viewer")).json();
  assert.equal(latest.state.selected["04"], version.id);
  assert.equal(latest.state.versions.at(-1).reviewedBy, "reviewer@example.com");
  assert.equal(latest.state.activity.length, 4);
  db.close();
});
