const shotIds = ["01", "02", "03", "04"];
const demo = "https://next-bus-shot-review.riferice4.chatgpt.site/media/";
const sample = (id, shot, title, file, status, poster) => ({
  id, shot, title, status, note: "", type: file.endsWith(".mp4") ? "video" : "image",
  file: demo + file, ...(poster ? { poster: demo + poster } : {}),
});
const initial = {
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

function identity(request, env) {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!id || !email) return null;
  if (email === env.OWNER_EMAIL?.trim().toLowerCase()) return { id, email, role: "owner" };
  const includes = (list) => (list ?? "").split(",").some((entry) => entry.trim().toLowerCase() === email);
  if (includes(env.REVIEWER_EMAILS)) return { id, email, role: "reviewer" };
  if (includes(env.VIEWER_EMAILS)) return { id, email, role: "viewer" };
  return null;
}
async function load(env) {
  const row = await env.DB.prepare("SELECT revision, state FROM review_workspace WHERE id = 1").first();
  return row ? { revision: row.revision, state: JSON.parse(row.state) } : { revision: 0, state: structuredClone(initial) };
}
async function save(env, current, action, user, version) {
  current.state.activity.unshift({
    at: new Date().toISOString(), actor: user.email, action, shot: version.shot, version: version.id,
  });
  const data = JSON.stringify(current.state);
  const result = current.revision === 0
    ? await env.DB.prepare("INSERT INTO review_workspace (id, revision, state) VALUES (1, 1, ?) ON CONFLICT(id) DO NOTHING").bind(data).run()
    : await env.DB.prepare("UPDATE review_workspace SET revision = revision + 1, state = ? WHERE id = 1 AND revision = ?").bind(data, current.revision).run();
  return result.meta.changes === 1;
}
const snapshot = (current, user) => json({ ...current, role: user.role });

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
  if (!await save(env, current, action.kind, user, version)) return fail("记录已被更新，请重新确认。", 409);
  current.revision++;
  return snapshot(current, user);
}

async function upload(request, env, current, user) {
  const submitted = Number(request.headers.get("content-length"));
  if (submitted > sizeLimit + 65536) return fail("文件最大为 50 MB。", 413);
  const form = await request.formData();
  const shot = form.get("shot");
  const file = form.get("file");
  if (!shotIds.includes(shot) || !(file instanceof File) || !file.size || !mediaTypes.has(file.type)) {
    return fail("请选择有效的图片或 MP4。", 400);
  }
  if (file.size > sizeLimit) return fail("文件最大为 50 MB。", 413);
  const id = crypto.randomUUID();
  const version = {
    id, shot, title: file.name.slice(0, 240), type: mediaTypes.get(file.type),
    status: "pending", note: "", file: "/api/media/" + id,
    importedAt: new Date().toISOString(), importedBy: user.email,
  };
  await env.BUCKET.put(id, file, { httpMetadata: { contentType: file.type } });
  current.state.versions.push(version);
  try {
    if (await save(env, current, "import", user, version)) {
      current.revision++;
      return snapshot(current, user);
    }
  } catch (error) {
    // Preserve the object when the database outcome is uncertain.
    throw error;
  }
  await env.BUCKET.delete(id);
  return fail("记录已被更新，请重新导入。", 409);
}

async function media(request, env, current, id) {
  if (!current.state.versions.some((version) => version.id === id && version.file === "/api/media/" + id)) {
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

export default {
  async fetch(request, env) {
    const user = identity(request, env);
    const url = new URL(request.url);
    if (!user) return fail("此团队工作区仅供已授权的成员访问。", 403);
    const { pathname } = url;
    if (request.method === "GET" && ["/", "/app.js", "/style.css"].includes(pathname)) {
      const key = pathname === "/" ? "index.html" : pathname.slice(1);
      const type = { "index.html": "text/html", "app.js": "text/javascript", "style.css": "text/css" }[key];
      return new Response(assets[key], { headers: { ...headers, "Content-Type": type + "; charset=utf-8" } });
    }
    try {
      const current = await load(env);
      if (pathname === "/api/state" && request.method === "GET") return snapshot(current, user);
      const match = /^\/api\/media\/([a-f\d-]{36})$/.exec(pathname);
      if (match && ["GET", "HEAD"].includes(request.method)) return await media(request, env, current, match[1]);
      if (request.method !== "POST") return fail("找不到此页面。", 404);
      if (user.role === "viewer" || request.headers.get("Origin") !== url.origin) return fail("此账户没有修改权限。", 403);
      if (pathname === "/api/review") {
        if (!request.headers.get("Content-Type")?.startsWith("application/json")) return fail("请求格式无效。", 415);
        if (Number(request.headers.get("Content-Length")) > 16384) return fail("请求太大。", 413);
        return await update(request, env, current, user);
      }
      if (pathname === "/api/upload") return await upload(request, env, current, user);
      return fail("找不到此页面。", 404);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return fail("请求或素材格式无法读取。", 400);
      console.error("team review request failed", error);
      return fail("团队存储暂不可用，请稍后重试。", 503);
    }
  },
};
