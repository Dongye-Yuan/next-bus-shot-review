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
      assert.deepEqual(input.text.format.schema.properties.unclear.items.properties.frame.enum, [0]);
      const text = JSON.stringify({
        issues: [{ reference: ref.id, frame: 0, feature: issue.feature, note: issue.note }],
        unclear: [{ reference: ref.id, frame: 0, feature: "脸型", note: "角度无法核对清楚。" }],
      });
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
  const checked = detection.state.versions.find(({ id }) => id === "03-old");
  assert.deepEqual(checked.issues.map(({ source }) => source), ["manual", "vision"]);
  assert.deepEqual(checked.visionUnclear.map(({ time, feature, reference }) => ({ time, feature, reference })),
    [{ time: 0, feature: "脸型", reference: ref.id }]);
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

test("imports a Colab sample into one version without changing review or manual evidence", async (t) => {
  const { db, send, post, origin } = fixture();
  t.after(() => db.close());
  const form = new FormData();
  for (const [key, value] of Object.entries({ revision: "0", name: "许棠", identity: "本人右侧黄色发夹", outfit: "米白雨衣" })) form.set(key, value);
  for (const angle of ["front", "side", "full"]) form.set(angle, new File(["reference"], angle + ".png", { type: "image/png" }));
  const referenceReply = await send("/api/references", "owner", { method: "POST", headers: { Origin: origin }, body: form });
  assert.equal(referenceReply.status, 200);
  const ref = (await referenceReply.json()).state.production.references[0];
  let revision = 1;
  async function change(path, body) {
    const response = await post(path, "owner", { ...body, revision });
    assert.equal(response.status, 200);
    const next = await response.json();
    revision = next.revision;
    return next.state;
  }
  await change("/api/production", { kind: "confirmReference", reference: ref.id });
  await change("/api/production", { kind: "bindReferences", shot: "03", references: [{ reference: ref.id, angle: "side" }] });
  await change("/api/production", { kind: "addIssue", shot: "03", version: "03-old", reference: ref.id,
    feature: "标志性特征", note: "人工发现发夹错侧" });
  await change("/api/review", { kind: "review", version: "03-old", status: "rejected", note: "发夹错侧" });
  const report = { kind: "importColabCheck", shot: "03", version: "03-old", model: "gemini-3.5-flash-lite",
    runAt: "2026-11-26T02:48:15.922467+00:00", group: "development", sample: "D01", time: 0, issues: [] };
  const variant = (payload, role = "owner") => post("/api/production", role, { ...report, revision, ...payload });
  assert.equal((await variant({}, "viewer")).status, 403);
  assert.equal((await variant({ revision: revision - 1 })).status, 409);
  assert.equal((await variant({ shot: "04" })).status, 404);
  assert.equal((await variant({ time: 2.5 })).status, 400);
  const missed = await change("/api/production", report);
  const old = missed.versions.find(({ id }) => id === "03-old");
  assert.equal(old.status, "rejected");
  assert.equal(old.colabCheck.status, "completed");
  assert.deepEqual(old.issues.map(({ source }) => source), ["manual"]);
  assert.equal(missed.selected["03"], "03-fixed");
  assert.equal(missed.versions.find(({ id }) => id === "03-fixed").colabCheck, undefined);

  const hit = { ...report, sample: "H06", group: "holdout",
    issues: [{ character: "许棠", feature: "黄色发夹", observed_side: "左", note: "画面中黄色发夹在本人左侧" }] };
  assert.equal((await variant({ ...hit, issues: [{ ...hit.issues[0], character: "未绑定角色" }] })).status, 400);
  const hitState = await change("/api/production", hit);
  const stored = hitState.versions.find(({ id }) => id === "03-old").issues.at(-1);
  assert.deepEqual({ source: stored.source, reference: stored.reference, angle: stored.angle, time: stored.time,
    sample: stored.sample, side: stored.observedSide },
  { source: "colab", reference: ref.id, angle: "side", time: 0, sample: "H06", side: "左" });
  assert.equal((await send(ref.images[stored.angle].file, "viewer")).status, 200);
  const errored = await change("/api/production", { ...report, issues: undefined, error: "HTTP 429" });
  const failed = errored.versions.find(({ id }) => id === "03-old");
  assert.equal(failed.colabCheck.status, "failed");
  assert.equal(failed.colabCheck.error, "HTTP 429");
  assert.deepEqual(failed.issues.map(({ source }) => source), ["manual", "colab"]);
  const refetched = await (await send("/api/state", "owner")).json();
  assert.equal(refetched.state.selected["03"], "03-fixed");
  assert.equal(refetched.state.versions.find(({ id }) => id === "03-old").status, "rejected");
  const replaced = await change("/api/production", report);
  assert.deepEqual(replaced.versions.find(({ id }) => id === "03-old").issues.map(({ source }) => source), ["manual"]);
});

test("saves story and draft separately and confirms ordered shots once", async (t) => {
  const { db, send, post } = fixture();
  t.after(() => db.close());
  const { project } = await (await post("/api/projects", "owner", { title: "分镜验收" })).json();
  const scope = (route) => route + "?project=" + project.id;
  const board = (body, role = "owner") => post(scope("/api/storyboard"), role, body);
  const story = "  雨夜，两个人在公交站等车。\n后来他们共伞。\n";
  assert.equal((await board({ kind: "story", story, revision: 0 }, "viewer")).status, 403);
  assert.equal((await board({ kind: "story", story, revision: 0 })).status, 200);
  assert.equal((await board({ kind: "draft", rows: [{ number: "01" }], revision: 1 })).status, 200);
  const row = { number: "01", characters: "许棠", scene: "雨夜站棚", framing: "右侧面",
    action: "低头看伞", duration: "6秒", costume: "米白雨衣", dialogue: "" };
  const rows = [{ ...row, number: "02", action: "两人共伞", duration: "5" }, row];
  assert.equal((await board({ kind: "confirm", rows, revision: 1 })).status, 409);
  assert.equal((await board({ kind: "confirm", rows: [row, row], revision: 2 })).status, 400);
  const confirmed = await (await board({ kind: "confirm", rows, revision: 2 })).json();
  assert.equal(confirmed.revision, 3);
  assert.equal(confirmed.state.story.text, story);
  assert.deepEqual(confirmed.state.clips.map(({ title, duration, storyboard }) => [title, duration, storyboard.number]),
    [["两人共伞", 5, "02"], ["低头看伞", 6, "01"]]);
  assert.match(confirmed.state.clips[1].context, /米白雨衣/);
  assert.equal((await board({ kind: "confirm", rows, revision: 3 })).status, 409);
  const edit = await (await post(scope("/api/shots"), "owner", {
    kind: "edit", shot: confirmed.state.storyboard.shotIds[0], title: "共伞走向路口", duration: 7, context: "", revision: 3,
  })).json();
  assert.equal(edit.state.clips[0].storyboard.number, "02");
  const readback = await (await send(scope("/api/state"), "viewer")).json();
  assert.equal(readback.state.clips.length, 2);
  assert.equal(readback.state.storyboard.rows[0].action, "两人共伞");
  assert.equal((await (await send("/api/state", "viewer")).json()).state.clips.length, 4);
});

test("keeps the confirmed script available while a later draft is edited", async (t) => {
  const { db, send, post } = fixture();
  t.after(() => db.close());
  const endpoint = "/api/storyboard";
  const first = { scene: "雨夜站棚", characters: "许棠、林澈", action: "两人并肩撑伞。",
    dialogue: "", beat: "从各自等车到共伞。" };
  const saveScript = (kind, scenes, revision, role = "reviewer") => post(endpoint, role, { kind, scenes, revision });
  assert.equal((await saveScript("saveScript", [first], 0, "viewer")).status, 403);
  assert.equal((await saveScript("confirmScript", [{ ...first, beat: "" }], 0)).status, 400);
  const drafted = await (await saveScript("saveScript", [first], 0)).json();
  assert.equal(drafted.state.script.draft.scenes[0].action, first.action);
  assert.equal(drafted.state.script.confirmed, undefined);
  const approved = await (await saveScript("confirmScript", [first], 1)).json();
  assert.equal(approved.state.script.draft, null);
  assert.equal(approved.state.script.confirmed.scenes[0].action, first.action);
  const newer = { ...first, action: "许棠把伞往林澈身边移了半步。" };
  assert.equal((await saveScript("saveScript", [newer], 2)).status, 200);
  assert.equal((await saveScript("confirmScript", [newer], 2)).status, 409);
  const readback = await (await send("/api/state", "viewer")).json();
  assert.equal(readback.state.script.confirmed.scenes[0].action, first.action);
  assert.equal(readback.state.script.draft.scenes[0].action, newer.action);
  assert.equal(readback.state.clips.length, 4);
  const revised = await (await saveScript("confirmScript", [newer], 3)).json();
  assert.equal(revised.state.script.confirmed.scenes[0].action, newer.action);
});

test("confirms scene drafts and pins shared sets for two cast shots and an empty shot", async (t) => {
  const { db, env, send, post, origin } = fixture();
  t.after(() => db.close());
  const project = (await (await post("/api/projects", "owner", { title: "场景验收" })).json()).project;
  const path = (route) => route + "?project=" + project.id;
  let revision = 0;
  const accept = async (response) => {
    assert.equal(response.status, 200);
    const data = await response.json();
    revision = data.revision;
    return data.state;
  };
  const write = (route, data) => post(path(route), "owner", { ...data, revision });
  const sceneUpload = (description, file, draft, role = "owner") => {
    const body = new FormData();
    body.set("revision", String(revision));
    body.set("name", "雨夜站棚");
    body.set("description", description);
    if (draft) body.set("draft", draft);
    if (file) body.set("image", new File([file], "shelter.png", { type: "image/png" }));
    return send(path("/api/scenes"), role, { method: "POST", headers: { Origin: origin }, body });
  };
  const rows = ["许棠", "林澈", "无人"].map((characters, index) => ({
    number: String(index + 1), characters, scene: "雨夜站棚", framing: "全景", action: "等车", duration: "4",
  }));
  const clips = (await accept(await write("/api/storyboard", { kind: "confirm", rows }))).clips;
  assert.equal((await sceneUpload("暖灯", "scene-v1", null, "viewer")).status, 403);
  const draft = (await accept(await sceneUpload("草稿", "scene-v1"))).production.scenes[0];
  const bind = (shot, scene, references = []) => write("/api/production", { kind: "bindReferences", shot, scene, references });
  assert.equal((await bind(clips[2].id, draft.id)).status, 400);
  await accept(await sceneUpload("暖灯和湿路面", null, draft.id));
  await accept(await write("/api/production", { kind: "confirmScene", scene: draft.id }));
  assert.equal((await sceneUpload("改图", "new", draft.id)).status, 400);
  const newer = (await accept(await sceneUpload("不同天气", "scene-v2"))).production.scenes[1];
  assert.equal(newer.edition, 2);
  await accept(await write("/api/production", { kind: "confirmScene", scene: newer.id }));
  assert.equal((await send(draft.image.file, null)).status, 403);
  assert.equal((await send(draft.image.file.split("?")[0], "owner")).status, 404);
  assert.equal(await (await send(draft.image.file, "viewer")).text(), "scene-v1");

  for (const [index, name] of ["许棠", "林澈"].entries()) {
    const body = new FormData();
    for (const [key, value] of Object.entries({ revision: String(revision), name, identity: "角色特征", outfit: "雨衣" })) body.set(key, value);
    for (const angle of ["front", "side", "full"]) body.set(angle, new File(["ref"], "role.png", { type: "image/png" }));
    const ref = (await accept(await send(path("/api/references"), "owner", {
      method: "POST", headers: { Origin: origin }, body,
    }))).production.references.at(-1);
    await accept(await write("/api/production", { kind: "confirmReference", reference: ref.id }));
    await accept(await bind(clips[index].id, draft.id, [{ reference: ref.id, angle: "front" }]));
  }
  await accept(await bind(clips[2].id, draft.id));
  const read = await (await send(path("/api/state"), "viewer")).json();
  assert.deepEqual(clips.map(({ id }) => read.state.production.shots[id].scene), Array(3).fill(draft.id));
  assert.deepEqual(clips.map(({ id }) => read.state.production.shots[id].references.length), [1, 1, 0]);

  env.FAL_KEY = "fixture";
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).hostname, "queue.fal.run");
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload.image_urls, ["data:image/png;base64,c2NlbmUtdjE="]);
    assert.match(payload.prompt, /暖灯和湿路面/);
    return Response.json({ request_id: "scene-request-test" });
  });
  const started = await accept(await write("/api/generation", { kind: "submit", type: "image", shot: clips[2].id, prompt: "灯光空镜" }));
  assert.equal(started.production.jobs[0].scene, draft.id);
  assert.equal(started.production.jobs[0].status, "queued");
});

test("returns optional model drafts without saving or exposing unconfirmed inputs", async (t) => {
  const { db, env, post, send } = fixture();
  t.after(() => db.close());
  const story = "小满在车站等待。";
  const scenes = [{ scene: "站台", characters: "小满", action: "小满等车。", dialogue: "", beat: "等待。" }];
  const rows = [{ number: "01", scene: "站台", characters: "小满", action: "等待。", framing: "中景", duration: "60", dialogue: "", costume: "" }];
  const draft = (kind, revision, role = "owner", options = {}) => post("/api/text-draft", role, { kind, revision, ...options });
  assert.equal((await draft("script", 0)).status, 503);
  env.STORY_DRAFT_OPENAI_KEY = "fixture-text-key";
  assert.equal((await draft("script", 0, "viewer")).status, 403);
  assert.equal((await draft("script", 0)).status, 400);
  await post("/api/storyboard", "owner", { kind: "story", story, revision: 0 });
  await post("/api/storyboard", "owner", { kind: "saveScript", scenes, revision: 1 });
  assert.equal((await draft("board", 2)).status, 400);
  assert.equal((await draft("script", 1)).status, 409);

  let output = scenes;
  let expected = story;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.match(url, /api.openai.com\/v1\/responses/);
    const request = JSON.parse(init.body);
    assert.equal(request.store, false);
    assert.equal(request.input, expected);
    return Response.json({ status: "completed", output: [{ content: [
      { type: "output_text", text: JSON.stringify({ rows: output }) },
    ] }] });
  });
  assert.deepEqual((await (await draft("script", 2)).json()).rows, scenes);
  await post("/api/storyboard", "owner", { kind: "confirmScript", scenes, revision: 2 });
  await post("/api/storyboard", "owner", { kind: "saveScript", scenes: [{ ...scenes[0], action: "未确认修订。" }], revision: 3 });
  expected = JSON.stringify(scenes);
  output = rows;
  assert.equal((await draft("board", 4, "owner", { seconds: 59 })).status, 502);
  assert.deepEqual((await (await draft("board", 4)).json()).rows, rows);
  const snapshot = await (await send("/api/state", "viewer")).json();
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.state.storyboard, undefined);
});

test("persists editable visual settings only against their confirmed script", async (t) => {
  const { db, post, send, env } = fixture();
  t.after(() => db.close());
  const write = (data, role = "owner") => post("/api/storyboard", role, data);
  const scenes = [{ scene: "旧站台", characters: "小满", action: "抬头看车灯。", dialogue: "", beat: "发现车来" }];
  const settings = { characters: [{ name: "小满", identity: "栗色短发", outfit: "米白雨衣" }],
    locations: [{ name: "旧站台", layout: "旧站牌和长椅", lighting: "暖灯", props: "" }] };
  const save = { kind: "saveSettingsDraft", settings };
  assert.equal((await write({ ...save, revision: 0 })).status, 400);
  const confirmed = await (await write({ kind: "confirmScript", scenes, revision: 0 })).json();
  const scriptAt = confirmed.state.script.confirmed.at;
  const action = { ...save, revision: 1, scriptAt };
  assert.equal((await write(action, "viewer")).status, 403);
  assert.equal((await write({ ...action, scriptAt: "earlier" })).status, 400);
  assert.equal((await write({ ...action, settings: { ...settings, characters: [{ name: "陌生角色" }] } })).status, 400);
  const saved = await (await write(action)).json();
  assert.deepEqual(saved.state.settingsDraft.characters, settings.characters);
  assert.equal(saved.state.settingsDraft.scriptAt, scriptAt);
  assert.equal((await write(action)).status, 409);
  const snapshot = await (await send("/api/state", "viewer")).json();
  assert.deepEqual(snapshot.state.settingsDraft.locations, settings.locations);
  assert.equal(snapshot.state.production, undefined);
  assert.equal((await post("/api/text-draft", "owner", { kind: "settings", revision: 2 })).status, 503);
  env.STORY_DRAFT_OPENAI_KEY = "fixture";
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.store, false);
    assert.deepEqual(JSON.parse(request.input), { scenes, characters: ["小满"], locations: ["旧站台"] });
    return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(settings) }] }] });
  });
  const result = await (await post("/api/text-draft", "owner", { kind: "settings", revision: 2 })).json();
  assert.deepEqual(result.settings, settings);
  assert.equal((await (await send("/api/state", "owner")).json()).revision, 2);
});

test("keeps quality evidence and its chosen repair checklist through external replacement", async (t) => {
  const { db, send, post, origin } = fixture();
  t.after(() => db.close());
  const check = { kind: "saveQualityCheck", shot: "04", version: "04-failed", category: "props", outcome: "problem",
    time: 3.2, note: "伞柄弯曲变形", fix: "保持一根黑色直柄" };
  assert.equal((await post("/api/production", "viewer", { ...check, revision: 0 })).status, 403);
  assert.equal((await post("/api/production", "owner", { ...check, fix: "", revision: 0 })).status, 400);
  const sendCheck = (fields, revision) => post("/api/production", "owner", { ...check, ...fields, revision });
  await sendCheck({ outcome: "unclear", category: "identity", note: "脸被伞挡住", fix: "" }, 0);
  const marked = await (await sendCheck({}, 1)).json();
  const original = marked.state.versions.find(({ id }) => id === "04-failed");
  const [unclear, problem] = original.qualityChecks;
  const reject = (ref, revision) => post("/api/review", "owner", {
    kind: "review", status: "rejected", version: original.id, check: ref, revision,
  });
  assert.equal((await reject(unclear.id, 2)).status, 400);
  const returned = await (await reject(problem.id, 2)).json();
  const selected = returned.state.versions.find(({ id }) => id === original.id);
  assert.equal(selected.note, check.fix);
  assert.deepEqual(selected.repairPlan.checks, [problem]);
  assert.equal(returned.state.selected["04"], "04-doubao");
  const form = new FormData();
  for (const [name, val] of Object.entries({ revision: "3", shot: "04", replaces: original.id, externalGeneration: "1" })) form.set(name, val);
  form.set("file", new File(["candidate"], "opening.mp4", { type: "video/mp4" }));
  const reply = await send("/api/upload", "owner", { method: "POST", headers: { Origin: origin }, body: form });
  assert.equal(reply.status, 200);
  const state = (await reply.json()).state;
  const candidate = state.versions.at(-1);
  assert.equal(candidate.status, "pending");
  assert.equal(candidate.replaces, original.id);
  assert.deepEqual(candidate.repairOrigin, selected.repairPlan);
  assert.equal(candidate.repairPlan, undefined);
  assert.equal(state.versions.find(({ id }) => id === original.id).status, "rejected");
});

test("can confirm a substitute keyframe without changing approved history or selected playback", async (t) => {
  const { db, send, post, origin } = fixture();
  t.after(() => db.close());
  const shot = "03";
  const locked = await (await post("/api/production", "owner",
    { kind: "lockFrame", shot, version: "03-fixed", revision: 0 })).json();
  const form = new FormData();
  form.set("revision", String(locked.revision));
  form.set("shot", shot);
  form.set("externalGeneration", "1");
  form.set("file", new File(["new still"], "alternate.png", { type: "image/png" }));
  const uploaded = await (await send("/api/upload", "owner",
    { method: "POST", headers: { Origin: origin }, body: form })).json();
  const version = uploaded.state.versions.at(-1).id;
  const confirm = (revision) => post("/api/production", "owner", { kind: "lockFrame", shot, version, revision });
  assert.equal(uploaded.state.production.shots[shot].keyframe, "03-fixed");
  assert.equal((await confirm(uploaded.revision)).status, 400);
  const approved = await (await post("/api/review", "owner",
    { kind: "review", version, status: "approved", revision: uploaded.revision })).json();
  assert.equal((await confirm(approved.revision)).status, 200);
  const state = (await (await send("/api/state", "viewer")).json()).state;
  assert.equal(state.production.shots[shot].keyframe, version);
  assert.equal(state.selected[shot], "03-fixed");
  assert.equal(state.versions.find(({ id }) => id === "03-fixed").status, "approved");
});
