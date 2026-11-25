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
      put: async (id, file, { httpMetadata } = {}) => {
        const blob = file instanceof Blob ? file
          : new Blob([await new Response(file).arrayBuffer()], { type: httpMetadata.contentType });
        files.set(id, blob);
      },
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
  return { db, files, env, send, post, upload, origin };
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

test("moves a shot directly across the list and retains its selected version", async (t) => {
  const { db, post, send } = fixture();
  t.after(() => db.close());
  const move = (input, role = "owner") => post("/api/shots", role, { kind: "move", ...input });
  assert.equal((await move({ revision: 0, shot: "04", target: "01" }, "viewer")).status, 403);
  assert.equal((await move({ revision: 0, shot: "04", target: "missing" })).status, 400);
  const same = await (await move({ revision: 0, shot: "04", target: "04" })).json();
  assert.equal(same.revision, 0);
  assert.equal((await move({ revision: 0, shot: "04", target: "01" })).status, 200);
  assert.equal((await move({ revision: 0, shot: "04", target: "03" })).status, 409);
  const saved = await (await send("/api/state", "viewer")).json();
  assert.deepEqual(saved.state.clips.map(({ id }) => id), ["04", "01", "02", "03"]);
  assert.equal(saved.state.selected["04"], "04-doubao");
  const movedBack = await (await move({ revision: 1, shot: "04", target: "03" })).json();
  assert.deepEqual(movedBack.state.clips.map(({ id }) => id), ["01", "02", "03", "04"]);
});

test("locks references, preserves evidence and collects the queued repair as a separate version", async (t) => {
  const { db, env, send, post, origin } = fixture();
  t.after(() => db.close());
  const form = new FormData();
  for (const [key, val] of Object.entries({ revision: "0", name: "许棠", identity: "本人右侧黄色发夹", outfit: "米白雨衣" })) form.set(key, val);
  for (const angle of ["front", "side", "full"]) form.set(angle, new File(["sample"], angle + ".png", { type: "image/png" }));
  const owner = (path, body) => post(path, "owner", body);
  const uploaded = await send("/api/references", "owner", { method: "POST", headers: { Origin: origin }, body: form });
  assert.equal(uploaded.status, 200);
  const ref = (await uploaded.json()).state.production.references[0];
  assert.equal(ref.confirmedAt, undefined);
  assert.equal((await send(ref.images.side.file, "outsider")).status, 403);
  assert.equal((await send(ref.images.side.file, "viewer")).status, 200);
  const bind = { kind: "bindReferences", shot: "03", references: [{ reference: ref.id, angle: "side" }], revision: 1 };
  assert.equal((await owner("/api/production", bind)).status, 400);
  assert.equal((await owner("/api/production", { kind: "confirmReference", reference: ref.id, revision: 1 })).status, 200);
  assert.equal((await owner("/api/production", { ...bind, revision: 2 })).status, 200);
  const issue = { kind: "addIssue", shot: "03", version: "03-old", reference: ref.id, time: 10,
    feature: "标志性特征", note: "黄色发夹跑到了本人左侧。" };
  const marked = await (await owner("/api/production", { ...issue, revision: 3 })).json();
  assert.equal(marked.state.versions.find(({ id }) => id === "03-old").issues[0].time, 0);
  assert.equal((await owner("/api/review", { kind: "review", version: "03-old", status: "rejected", note: issue.note, revision: 4 })).status, 200);
  const start = { kind: "submit", type: "image", shot: "03", from: "03-old", prompt: "修复发夹位置", revision: 5 };
  assert.equal((await owner("/api/generation", start)).status, 503);
  assert.equal((await owner("/api/vision", { version: "03-old", revision: 5, frames: [] })).status, 503);

  env.FAL_KEY = "test-generation-key";
  env.OPENAI_API_KEY = "test-vision-key";
  const frames = [{ time: 0, image: "data:image/jpeg;base64,YQ==" }];
  let submitted = 0;
  let queueState = "IN_QUEUE";
  let uncertain = false;
  let videoJob = false;
  t.mock.method(globalThis, "fetch", async (resource, init) => {
    const url = new URL(resource);
    if (url.hostname === "api.openai.com") {
      const input = JSON.parse(init.body);
      assert.equal(input.store, false);
      assert.equal(input.input[0].content.filter(({ type }) => type === "input_image").length, 2);
      const text = JSON.stringify({ issues: [{ reference: ref.id, frame: 0, feature: issue.feature, note: issue.note }] });
      return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text }] }] });
    }
    if (url.hostname === "queue.fal.run" && init.method === "POST") {
      submitted++;
      if (uncertain) throw new Error("connection dropped");
      const input = JSON.parse(init.body);
      videoJob = url.pathname.endsWith("/image-to-video");
      if (videoJob) {
        assert.ok(input.image_url.startsWith("data:image/jpeg;base64,"));
        assert.equal(input.duration, "5");
        return Response.json({ request_id: "test-video-000" + submitted });
      }
      assert.equal(input.aspect_ratio, "9:16");
      assert.ok(input.image_urls[0].endsWith("/03-old.png"));
      assert.ok(input.image_urls[1].startsWith("data:image/png;base64,"));
      assert.match(input.prompt, /本人右侧/);
      return Response.json({ request_id: "test-request-0001" });
    }
    if (url.hostname === "queue.fal.run" && url.pathname.endsWith("/status")) return Response.json({ status: queueState });
    if (url.hostname === "queue.fal.run") return Response.json(videoJob
      ? { video: { url: "https://v3.fal.media/test/result.mp4" } }
      : { images: [{ url: "https://v3.fal.media/test/result.jpeg" }] });
    assert.equal(url.hostname, "v3.fal.media");
    return new Response(videoJob ? "mp4!" : "jpeg", { headers: {
      "Content-Type": videoJob ? "video/mp4" : "image/jpeg", "Content-Length": "4",
    } });
  });
  const detection = await (await owner("/api/vision", { version: "03-old", revision: 5, frames })).json();
  assert.deepEqual(detection.state.versions.find(({ id }) => id === "03-old").issues.map(({ source }) => source), ["manual", "vision"]);
  const queued = await (await owner("/api/generation", { ...start, revision: 6 })).json();
  const job = queued.state.production.jobs[0];
  assert.equal(job.status, "queued");
  assert.equal((await owner("/api/generation", { ...start, revision: queued.revision })).status, 409);
  const poll = { kind: "poll", job: job.id };
  assert.equal((await owner("/api/generation", poll)).status, 200);
  queueState = "COMPLETED";
  const done = await (await owner("/api/generation", poll)).json();
  const version = done.state.versions.find(({ id }) => id === job.id);
  assert.equal(version.status, "pending");
  assert.equal(version.replaces, "03-old");
  assert.equal(done.state.selected["03"], "03-fixed");
  assert.equal(await (await send(version.file, "viewer")).text(), "jpeg");
  assert.equal((await owner("/api/production", { kind: "lockFrame", shot: "03", version: job.id, revision: done.revision })).status, 400);
  const reviewed = await (await owner("/api/review", { kind: "review", version: job.id, status: "approved", revision: done.revision })).json();
  const locked = await (await owner("/api/production", { kind: "lockFrame", shot: "03", version: job.id, revision: reviewed.revision })).json();
  assert.equal(locked.state.production.shots["03"].keyframe, job.id);

  const motion = { ...start, type: "video", from: undefined, revision: locked.revision };
  const firstVideo = await (await owner("/api/generation", motion)).json();
  const firstVideoId = firstVideo.state.production.jobs.at(-1).id;
  const videoResult = await (await owner("/api/generation", { kind: "poll", job: firstVideoId })).json();
  assert.equal(videoResult.state.versions.at(-1).keyframe, job.id);
  const returned = await (await owner("/api/review", { kind: "review", version: firstVideoId,
    status: "rejected", note: "重做动作", revision: videoResult.revision })).json();
  const motionRepair = { ...motion, from: firstVideoId, revision: returned.revision };
  assert.equal((await owner("/api/generation", { ...motionRepair, reuse: false })).status, 400);
  const secondVideo = await (await owner("/api/generation", { ...motionRepair, reuse: true })).json();
  const completedVideo = await (await owner("/api/generation", { kind: "poll", job: secondVideo.state.production.jobs.at(-1).id })).json();
  assert.equal(completedVideo.state.versions.at(-1).replaces, firstVideoId);
  assert.equal(completedVideo.state.versions.at(-1).keyframe, job.id);

  uncertain = true;
  const failed = await (await owner("/api/generation", { ...start, revision: completedVideo.revision })).json();
  assert.equal(failed.state.production.jobs.at(-1).status, "unknown");
  assert.equal((await owner("/api/generation", { ...start, revision: failed.revision })).status, 409);
  assert.equal(submitted, 4);
  const repair = new FormData();
  repair.set("revision", String(failed.revision));
  repair.set("shot", "03");
  repair.set("replaces", "03-old");
  repair.set("file", new File(["manual repair"], "修正版.png", { type: "image/png" }));
  const manual = await (await send("/api/upload", "owner", { method: "POST", headers: { Origin: origin }, body: repair })).json();
  assert.equal(manual.state.versions.at(-1).replaces, "03-old");
  assert.equal(manual.state.versions.find(({ id }) => id === "03-old").status, "rejected");
});
