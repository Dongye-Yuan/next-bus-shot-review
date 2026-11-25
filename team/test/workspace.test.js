import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/index.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0000_workspace.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../drizzle/0001_members.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../drizzle/0002_projects.sql", import.meta.url), "utf8"));
  const files = new Map();
  const env = {
    OWNER_EMAIL: "owner@example.com", REVIEWER_EMAILS: "reviewer@example.com", VIEWER_EMAILS: "viewer@example.com",
    DB: { prepare: (sql) => ({
      first: () => db.prepare(sql).get(),
      all: () => ({ results: db.prepare(sql).all() }),
      bind: (...parameters) => ({
        first: () => db.prepare(sql).get(...parameters),
        run: () => ({ meta: db.prepare(sql).run(...parameters) }),
      }),
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
  const post = (path, role, data, caller = origin) => send(path, role, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: caller },
    body: JSON.stringify(data),
  });
  const upload = (path, role, revision, shot) => {
    const form = new FormData();
    form.append("revision", String(revision));
    form.append("shot", shot);
    form.append("file", new File(["media bytes"], "test.mp4", { type: "video/mp4" }));
    return send(path, role, { method: "POST", headers: { Origin: origin }, body: form });
  };
  return { db, files, send, post, upload };
}

test("isolates access, persists shared review revisions and serves private media ranges", async (t) => {
  const { db, send, post, upload } = fixture();
  t.after(() => db.close());
  const action = (role, revision, kind, version, extra = {}, caller) =>
    post("/api/review", role, { revision, kind, version, ...extra }, caller);
  assert.equal((await send("/api/state")).status, 403);
  assert.equal((await send("/api/state", "outsider")).status, 403);
  assert.equal((await action("viewer", 0, "pick", "04-flow")).status, 403);
  assert.equal((await action("owner", 0, "pick", "04-flow", {}, "https://other.example")).status, 403);
  assert.equal((await action("reviewer", 0, "pick", "04-failed")).status, 400);
  assert.equal((await action("reviewer", 0, "review", "04-failed", { status: "rejected" })).status, 400);
  assert.equal((await action("owner", 0, "pick", "04-flow")).status, 200);
  assert.equal((await action("reviewer", 0, "pick", "04-doubao")).status, 409);
  const uploaded = await upload("/api/upload", "reviewer", 1, "04");
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
  const membership = (actor, email, role, caller) => post("/api/members", actor, { email, role }, caller);
  assert.equal((await send("/api/members", "viewer")).status, 403);
  assert.equal((await membership("reviewer", "outsider@example.com", "viewer")).status, 403);
  assert.equal((await membership("owner", "outsider@example.com", "viewer", "https://other.example")).status, 403);
  assert.equal((await membership("owner", "owner@example.com", "revoked")).status, 400);
  assert.equal((await membership("owner", "outsider@example.com", "viewer")).status, 200);
  assert.equal((await (await send("/api/state", "outsider")).json()).role, "viewer");
  assert.equal((await action("outsider", 4, "pick", "04-doubao")).status, 403);
  assert.equal((await membership("owner", "outsider@example.com", "reviewer")).status, 200);
  assert.equal((await action("outsider", 4, "pick", "04-doubao")).status, 200);
  assert.equal((await membership("owner", "outsider@example.com", "revoked")).status, 200);
  assert.equal((await send("/api/state", "outsider")).status, 403);
  assert.equal((await send(version.file, "outsider")).status, 403);
  assert.deepEqual((await (await send("/api/members", "owner")).json()).members, []);
});

test("keeps projects independent and preserves the legacy selection and revisions", async (t) => {
  const { db, files, post, send, upload } = fixture();
  t.after(() => db.close());
  db.prepare("INSERT INTO review_workspace (id, revision, state) VALUES (1, 7, ?)").run(JSON.stringify({
    versions: [], selected: { "04": "04-flow" }, activity: [],
  }));
  assert.equal((await post("/api/projects", "viewer", { title: "无权限" })).status, 403);
  assert.equal((await post("/api/projects", "owner", { title: "跨站" }, "https://elsewhere.test")).status, 403);
  assert.equal((await post("/api/projects", "owner", { title: "   " })).status, 400);
  const created = await post("/api/projects", "owner", { title: " 项目甲 " });
  assert.equal(created.status, 201);
  const { project, revision, state } = await created.json();
  assert.equal(project.title, "项目甲");
  assert.equal(revision, 0);
  assert.deepEqual(state.clips, []);
  assert.deepEqual(state.versions, []);

  const secondProject = (await (await post("/api/projects", "reviewer", { title: "项目乙" })).json()).project;
  const scope = (path, id = project.id) => path + "?project=" + id;
  const getState = async (id) => (await send(scope("/api/state", id), "viewer")).json();
  const shots = (action, role = "reviewer") => post(scope("/api/shots"), role, action);
  const newShot = { kind: "add", revision: 0, title: "街口", duration: 4, context: "远景" };
  assert.equal((await shots(newShot, "viewer")).status, 403);
  assert.equal((await shots({ ...newShot, duration: 0 })).status, 400);
  const first = (await (await shots(newShot)).json()).state.clips[0];
  assert.ok(first.id);
  assert.equal((await upload(scope("/api/upload", secondProject.id), "owner", 0, first.id)).status, 400);
  assert.equal((await upload(scope("/api/upload"), "owner", 0, first.id)).status, 409);
  assert.equal(files.size, 0);

  const uploads = await Promise.all([
    upload(scope("/api/upload"), "reviewer", 1, first.id),
    upload(scope("/api/upload"), "owner", 1, first.id),
  ]);
  assert.deepEqual(uploads.map(({ status }) => status).sort(), [200, 409]);
  assert.equal(files.size, 1);
  const version = (await uploads.find(({ ok }) => ok).json()).state.versions[0];
  assert.equal((await send(version.file, "outsider")).status, 403);
  assert.equal((await send(version.file, "viewer", { method: "HEAD" })).status, 200);
  assert.equal((await send(scope("/api/media/" + version.id, secondProject.id), "owner")).status, 404);
  assert.equal((await send("/api/media/" + version.id, "owner")).status, 404);
  const review = (operation, id) => post(scope("/api/review", id), "reviewer", { ...operation, version: version.id });
  assert.equal((await review({ revision: 0, kind: "review", status: "approved" }, secondProject.id)).status, 404);
  assert.equal((await review({ revision: 2, kind: "review", status: "rejected", note: "需重做" })).status, 200);
  assert.equal((await review({ revision: 3, kind: "pick" })).status, 400);
  assert.equal((await review({ revision: 3, kind: "review", status: "approved" })).status, 200);
  assert.equal((await review({ revision: 4, kind: "pick" })).status, 200);
  const second = (await (await shots({ ...newShot, revision: 5, title: "站台", duration: 65 })).json()).state.clips[1];
  assert.equal((await shots({ kind: "move", revision: 6, shot: second.id, direction: -1 })).status, 200);
  assert.equal((await shots({ kind: "edit", revision: 6, shot: first.id, title: "过期", duration: 3 })).status, 409);
  assert.equal((await shots({ kind: "edit", revision: 7, shot: first.id, title: "站外", duration: 3 })).status, 200);

  const saved = await getState(project.id);
  assert.equal(saved.revision, 8);
  assert.deepEqual(saved.state.clips.map(({ title, duration }) => [title, duration]), [["站台", 65], ["站外", 3]]);
  assert.equal(saved.state.selected[first.id], version.id);
  assert.equal(saved.state.activity[1].action, "moveShot");
  assert.deepEqual((await getState(secondProject.id)).state.versions, []);
  const legacy = await getState("demo");
  assert.equal(legacy.revision, 7);
  assert.equal(legacy.state.clips.length, 4);
  assert.equal(legacy.state.selected["04"], "04-flow");
  const listing = await (await send("/api/projects", "viewer")).json();
  assert.deepEqual(new Set(listing.projects.map(({ id }) => id)), new Set(["demo", project.id, secondProject.id]));
});
