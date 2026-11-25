const demoClips = [
  { id: "01", title: "雨夜站棚", duration: 4, context: "双人中景，建立站棚与人物站位。" },
  { id: "02", title: "林澈近景", duration: 4, context: "核对林澈本人左眉尾的浅疤。" },
  { id: "03", title: "许棠看伞", duration: 4, context: "核对黄色发夹是否在许棠本人右侧。" },
  { id: "04", title: "开伞与共伞", duration: 5, context: "检查伞面尺寸、伞柄和两人的外观。两个通过版本都可选用。" },
];
const demoProject = { id: "demo", title: "下一班车" };
const demo = "https://next-bus-shot-review.riferice4.chatgpt.site/media/";
const sample = (id, shot, title, file, status, poster) => ({
  id, shot, title, status, note: "", type: file.endsWith(".mp4") ? "video" : "image",
  file: demo + file, ...(poster ? { poster: demo + poster } : {}),
});
const initial = {
  clips: demoClips,
  versions: [
    sample("01-approved", "01", "雨夜站棚关键帧", "01.png", "approved"),
    sample("02-approved", "02", "林澈正面近景", "02.png", "approved"),
    sample("03-old", "03", "旧版 · 发夹换边", "03-old.png", "pending"),
    sample("03-fixed", "03", "修正版 · 本人右侧发夹", "03.png", "approved"),
    sample("04-doubao", "04", "豆包 · 开伞原版", "04-open.mp4", "approved", "04.png"),
    sample("04-flow", "04", "Flow · 共伞替代版", "04-shared.mp4", "approved", "04-shared.png"),
    sample("04-failed", "04", "Flow · 失败样片", "04-failed.mp4", "pending"),
  ],
  selected: { "01": "01-approved", "02": "02-approved", "03": "03-fixed", "04": "04-doubao" },
  activity: [],
};
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};
const json = (data, status = 200) => Response.json(data, { status, headers });
const fail = (message, status) => json({ message }, status);
const mediaTypes = new Map([
  ["image/png", "image"], ["image/jpeg", "image"], ["image/webp", "image"], ["video/mp4", "video"],
]);
const sizeLimit = 50 * 1024 * 1024;

async function identity(request, env) {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!id || !email) return null;
  if (email === env.OWNER_EMAIL?.trim().toLowerCase()) return { id, email, role: "owner" };
  const member = await env.DB.prepare("SELECT role FROM team_member WHERE email = ?").bind(email).first();
  if (member) return member.role === "revoked" ? null : { id, email, role: member.role };
  const includes = (list) => (list ?? "").split(",").some((entry) => entry.trim().toLowerCase() === email);
  if (includes(env.REVIEWER_EMAILS)) return { id, email, role: "reviewer" };
  if (includes(env.VIEWER_EMAILS)) return { id, email, role: "viewer" };
  return null;
}
async function load(env, project) {
  if (project !== demoProject.id) {
    const row = await env.DB.prepare("SELECT revision, state FROM review_project WHERE id = ?").bind(project).first();
    return row ? { project, revision: row.revision, state: JSON.parse(row.state) } : null;
  }
  const row = await env.DB.prepare("SELECT revision, state FROM review_workspace WHERE id = 1").first();
  return {
    project, revision: row?.revision ?? 0,
    state: row ? { clips: structuredClone(demoClips), ...JSON.parse(row.state) } : structuredClone(initial),
  };
}
async function save(env, current, action, user, entry) {
  current.state.activity.unshift({ at: new Date().toISOString(), actor: user.email, action, ...entry });
  const data = JSON.stringify(current.state);
  if (new TextEncoder().encode(data).byteLength > 1_500_000) return 413;
  let result;
  if (current.project !== demoProject.id) {
    result = await env.DB.prepare("UPDATE review_project SET revision = revision + 1, state = ? WHERE id = ? AND revision = ?")
      .bind(data, current.project, current.revision).run();
  } else if (current.revision === 0) {
    result = await env.DB.prepare("INSERT INTO review_workspace (id, revision, state) VALUES (1, 1, ?) ON CONFLICT(id) DO NOTHING")
      .bind(data).run();
  } else {
    result = await env.DB.prepare("UPDATE review_workspace SET revision = revision + 1, state = ? WHERE id = 1 AND revision = ?")
      .bind(data, current.revision).run();
  }
  if (result.meta.changes !== 1) return 409;
  current.revision++;
  return 200;
}
const snapshot = (current, user) => json({ ...current, role: user.role });
const saveError = (status) => fail(status === 413
  ? "此项目的审核记录已达容量上限。"
  : "记录已被更新，请重新确认。", status);

async function listProjects(env, user) {
  const { results } = await env.DB.prepare("SELECT id, title FROM review_project ORDER BY created_at DESC, id").all();
  return json({ projects: [demoProject, ...results], role: user.role });
}

async function createProject(request, env, user) {
  const input = await request.json();
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 100) return fail("片名须为 1–100 字。", 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const state = {
    clips: [], versions: [], selected: {},
    activity: [{ at: now, actor: user.email, action: "createProject", title }],
  };
  await env.DB.prepare("INSERT INTO review_project (id, title, created_at, revision, state) VALUES (?, ?, ?, 0, ?)")
    .bind(id, title, now, JSON.stringify(state)).run();
  return json({ project: { id, title }, revision: 0, state, role: user.role }, 201);
}

async function manageShots(request, env, current, user) {
  const input = await request.json();
  if (!input || !["add", "edit", "move"].includes(input.kind)) return fail("镜头操作无效。", 400);
  if (current.revision !== input.revision) return saveError(409);
  const { clips } = current.state;
  const index = clips.findIndex((clip) => clip.id === input.shot);
  if (input.kind !== "add" && index === -1) return fail("找不到该镜头。", 404);
  let shot;
  if (input.kind === "move") {
    const next = typeof input.target === "string" && input.direction === undefined
      ? clips.findIndex((clip) => clip.id === input.target)
      : input.target === undefined && [-1, 1].includes(input.direction) ? index + input.direction : -1;
    if (next < 0 || next >= clips.length) return fail("该镜头无法移到这个位置。", 400);
    if (next === index) return snapshot(current, user);
    [shot] = clips.splice(index, 1);
    clips.splice(next, 0, shot);
  } else {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const context = typeof input.context === "string" ? input.context.trim() : "";
    const { duration } = input;
    if (!title || title.length > 100 || context.length > 2000 ||
        !Number.isInteger(duration) || duration < 1 || duration > 300) {
      return fail("请填写 1–100 字的标题、最多 2000 字的描述和 1–300 秒的整数时长。", 400);
    }
    shot = { id: input.kind === "add" ? crypto.randomUUID() : clips[index].id, title, context, duration };
    if (input.kind === "add") clips.push(shot);
    else clips[index] = shot;
  }
  const events = { add: "addShot", edit: "editShot", move: "moveShot" };
  const status = await save(env, current, events[input.kind], user, { shot: shot.id, title: shot.title });
  return status === 200 ? snapshot(current, user) : saveError(status);
}

const mediaPath = (project, id) => "/api/media/" + id + (project === demoProject.id ? "" : "?project=" + project);

async function update(request, env, current, user) {
  const action = await request.json();
  if (!action || typeof action !== "object") return fail("审核操作无效。", 400);
  if (current.revision !== action.revision) return fail("记录已被更新，请重新确认。", 409);
  const version = current.state.versions.find(({ id }) => id === action.version);
  if (!version) return fail("找不到该版本。", 404);
  const note = typeof action.note === "string" ? action.note.trim() : "";
  if (note.length > 500) return fail("备注最多 500 字。", 400);
  if (action.kind === "review") {
    if (!["pending", "approved", "rejected"].includes(action.status)) return fail("审核状态无效。", 400);
    if (action.status === "rejected" && !note) return fail("请先填写退回原因。", 400);
    version.note = note;
    version.status = action.status;
    version.reviewedAt = new Date().toISOString();
    version.reviewedBy = user.email;
    if (version.status !== "approved" && current.state.selected[version.shot] === version.id) {
      delete current.state.selected[version.shot];
    }
  } else if (action.kind === "pick" && version.status === "approved") {
    current.state.selected[version.shot] = version.id;
    version.note = note;
  } else {
    return fail("只有通过审核的版本可以选用。", 400);
  }
  const status = await save(env, current, action.kind, user, { shot: version.shot, version: version.id });
  return status === 200 ? snapshot(current, user) : saveError(status);
}

async function upload(request, env, current, user) {
  const submitted = Number(request.headers.get("content-length"));
  if (submitted > sizeLimit + 65536) return fail("文件最大为 50 MB。", 413);
  const form = await request.formData();
  const shot = form.get("shot");
  const file = form.get("file");
  const revision = form.get("revision");
  if (typeof revision !== "string" || String(current.revision) !== revision) return saveError(409);
  if (!current.state.clips.some((clip) => clip.id === shot) || !(file instanceof File) || !file.size || !mediaTypes.has(file.type)) {
    return fail("请选择有效的图片或 MP4。", 400);
  }
  if (file.size > sizeLimit) return fail("文件最大为 50 MB。", 413);
  const id = crypto.randomUUID();
  const version = {
    id, shot, title: file.name.slice(0, 240), type: mediaTypes.get(file.type),
    status: "pending", note: "", file: mediaPath(current.project, id),
    importedAt: new Date().toISOString(), importedBy: user.email,
  };
  await env.BUCKET.put(id, file, { httpMetadata: { contentType: file.type } });
  current.state.versions.push(version);
  // A database error can leave the commit outcome uncertain. Only remove files after a definitive rejection.
  const status = await save(env, current, "import", user, { shot, version: version.id });
  if (status === 200) return snapshot(current, user);
  await env.BUCKET.delete(id);
  return saveError(status);
}

async function media(request, env, current, id) {
  if (!current.state.versions.some((version) => version.id === id && version.file === mediaPath(current.project, id))) {
    return fail("找不到该素材。", 404);
  }
  const head = await env.BUCKET.head(id);
  if (!head) return fail("找不到该素材。", 404);
  const resultHeaders = new Headers(headers);
  head.writeHttpMetadata(resultHeaders);
  resultHeaders.set("Accept-Ranges", "bytes");
  resultHeaders.set("Content-Length", head.size);
  if (request.method === "HEAD") return new Response(null, { headers: resultHeaders });
  const spec = request.headers.get("Range");
  let range;
  if (spec) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(spec);
    const start = parsed?.[1] ? Number(parsed[1]) : Math.max(0, head.size - Number(parsed?.[2]));
    const end = parsed?.[1] && parsed[2] ? Math.min(head.size - 1, Number(parsed[2])) : head.size - 1;
    if (!parsed || !Number.isSafeInteger(start) || start < 0 || start > end || end >= head.size) {
      resultHeaders.set("Content-Range", "bytes */" + head.size);
      resultHeaders.delete("Content-Length");
      return new Response(null, { status: 416, headers: resultHeaders });
    }
    range = { offset: start, length: end - start + 1 };
    resultHeaders.set("Content-Range", `bytes ${start}-${end}/${head.size}`);
    resultHeaders.set("Content-Length", range.length);
  }
  const object = await env.BUCKET.get(id, range ? { range } : {});
  return object ? new Response(object.body, { status: range ? 206 : 200, headers: resultHeaders }) : fail("找不到该素材。", 404);
}

async function members(request, env, user, url) {
  if (user.role !== "owner") return fail("只有工作区所有者可以管理成员。", 403);
  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT email, role, updated_at FROM team_member WHERE role != 'revoked' ORDER BY email",
    ).all();
    return json({ members: rows.results });
  }
  if (request.method !== "POST") return fail("请求方法无效。", 405);
  if (request.headers.get("Origin") !== url.origin) return fail("无法执行跨站修改。", 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return fail("请求格式无效。", 415);
  if (Number(request.headers.get("Content-Length")) > 4096) return fail("请求太大。", 413);
  const data = await request.json();
  const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    return fail("请输入有效的 ChatGPT 登录邮箱。", 400);
  }
  if (email === user.email || !["reviewer", "viewer", "revoked"].includes(data.role)) {
    return fail("不能修改所有者权限，或提供的角色无效。", 400);
  }
  await env.DB.prepare(
    "INSERT INTO team_member (email, role, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(email) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at",
  ).bind(email, data.role, new Date().toISOString()).run();
  return json({ email, role: data.role });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const user = await identity(request, env);
      if (!user) return fail("此团队工作区仅供已授权的成员访问。", 403);
      const { pathname } = url;
      if (request.method === "GET" && ["/", "/app.js", "/movie.js", "/style.css"].includes(pathname)) {
        const key = pathname === "/" ? "index.html" : pathname.slice(1);
        const type = { "index.html": "text/html", "app.js": "text/javascript", "movie.js": "text/javascript", "style.css": "text/css" }[key];
        return new Response(assets[key], { headers: { ...headers, "Content-Type": type + "; charset=utf-8" } });
      }
      if (pathname === "/api/members") return await members(request, env, user, url);
      if (pathname === "/api/projects" && request.method === "GET") return await listProjects(env, user);
      if (request.method === "POST") {
        if (user.role === "viewer" || request.headers.get("Origin") !== url.origin) return fail("此账户没有修改权限。", 403);
        if (["/api/projects", "/api/shots", "/api/review"].includes(pathname)) {
          if (!request.headers.get("Content-Type")?.startsWith("application/json")) return fail("请求格式无效。", 415);
          if (Number(request.headers.get("Content-Length")) > 16384) return fail("请求太大。", 413);
          if (pathname === "/api/projects") return await createProject(request, env, user);
        }
      }
      const match = /^\/api\/media\/([a-f\d-]{36})$/.exec(pathname);
      const project = url.searchParams.get("project") ?? demoProject.id;
      const current = await load(env, project);
      if (!current) return fail("找不到此项目。", 404);
      if (pathname === "/api/state" && request.method === "GET") return snapshot(current, user);
      if (match && ["GET", "HEAD"].includes(request.method)) return await media(request, env, current, match[1]);
      if (request.method === "POST") {
        if (pathname === "/api/review") return await update(request, env, current, user);
        if (pathname === "/api/shots") return await manageShots(request, env, current, user);
        if (pathname === "/api/upload") return await upload(request, env, current, user);
      }
      return fail("找不到此页面。", 404);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return fail("请求或素材格式无法读取。", 400);
      console.error("team review request failed", error);
      return fail("团队存储暂不可用，请稍后重试。", 503);
    }
  },
};
