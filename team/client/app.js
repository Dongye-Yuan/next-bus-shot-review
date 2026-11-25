import { moviePlan, renderMovie } from "./movie.js";
import { setupProduction } from "./production.js";

let clips = [];
let projects = [];
let activeProject = "demo";
let state = { versions: [], selected: {}, activity: [], openShot: null };
let revision = 0;
let role = "viewer";
let ready = false;
let busy = false;
let capabilities = {};
const drafts = new Map();
const statuses = { approved: "已通过", rejected: "已退回", pending: "待审" };
const $ = (id) => document.getElementById(id);
const element = (tag, text, classes) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (classes) node.className = classes;
  return node;
};
const button = (label, callback, classes) => {
  const node = element("button", label, classes);
  node.type = "button";
  node.onclick = callback;
  return node;
};
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = !message;
}
const projectKey = "shot-review.active-project";
const scopedPath = (path, project = activeProject) => path + "?project=" + encodeURIComponent(project);
const shotNumber = (index) => String(index + 1).padStart(2, "0");
const currentShot = () => clips.find((clip) => clip.id === state.openShot);

function rememberProject(id) {
  try { localStorage.setItem(projectKey, id); } catch {}
}
function savedProject() {
  try { return localStorage.getItem(projectKey); } catch { return null; }
}

async function requestData(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.message ?? "无法读取团队记录，请刷新重试。");
    error.status = response.status;
    throw error;
  }
  return data;
}
const post = (path, data) => requestData(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
});

function renderProjects() {
  $("project-select").replaceChildren(...projects.map(({ id, title }) => {
    const option = element("option", id === "demo" ? title + "（示例）" : title);
    option.value = id;
    return option;
  }));
  $("project-select").value = activeProject;
  const title = projects.find(({ id }) => id === activeProject)?.title ?? "";
  $("project-title").textContent = title;
  document.title = title ? title + " · 团队审核" : "团队镜头审核";
}

function applySnapshot(data, project) {
  const switching = activeProject !== project || !ready;
  const { clip, offset } = previewInfo();
  if (switching) drafts.clear();
  const preferredShot = switching ? (project === "demo" ? "03" : null) : state.openShot;
  activeProject = project;
  clips = data.state.clips;
  const openShot = clips.some(({ id }) => id === preferredShot) ? preferredShot : (clips[0]?.id ?? null);
  state = { ...data.state, openShot };
  revision = data.revision;
  role = data.role;
  capabilities = data.capabilities ?? {};
  ready = true;
  const labels = { owner: "所有者", reviewer: "审核员", viewer: "只读成员" };
  $("storage").textContent = "团队共享 · " + labels[role];
  $("new-project").hidden = role === "viewer";
  $("open-members").hidden = role !== "owner";
  $("export-review").disabled = false;
  $("open-movie").disabled = false;
  renderProjects();
  renderReview();
  renderTimeline();
  const sameClip = !switching && clip && clips.find(({ id }) => id === clip.id);
  seekTo(sameClip ? clipStart(sameClip.id) + Math.min(offset, Math.max(0, sameClip.duration - 0.01)) : 0);
}

async function refreshWorkspace(project) {
  const listing = await requestData("/api/projects");
  const requested = project ?? (ready ? activeProject : savedProject());
  const target = listing.projects.some(({ id }) => id === requested) ? requested : "demo";
  const data = await requestData(scopedPath("/api/state", target));
  projects = listing.projects;
  applySnapshot(data, target);
  rememberProject(target);
}

async function commit(action, form, path = form ? "/api/upload" : "/api/review", onError = notice) {
  if (busy || !ready || role === "viewer") return false;
  busy = true;
  $("project-select").disabled = true;
  try {
    if (form) form.set("revision", String(revision));
    const data = form
      ? await requestData(scopedPath(path), { method: "POST", body: form })
      : await post(scopedPath(path), { ...action, revision });
    applySnapshot(data, activeProject);
    return true;
  } catch (error) {
    if (error.status === 409) {
      try {
        await refreshWorkspace(activeProject);
        onError("其他成员已更新记录。已载入最新版本，请重新确认本次操作。", true);
      } catch (refreshError) {
        onError(refreshError.message, true);
      }
    } else {
      onError(error.message || "保存失败，请重试。", true);
    }
    return false;
  } finally {
    busy = false;
    $("project-select").disabled = false;
  }
}

function clipSource(version) {
  return version.file;
}
function media(version, controls = false) {
  const node = element(version.type === "video" ? "video" : "img");
  node.src = clipSource(version);
  if (version.type === "video") {
    node.controls = controls;
    node.playsInline = true;
    node.preload = "metadata";
    if (version.poster) node.poster = version.poster;
    node.setAttribute("aria-label", version.title);
  } else {
    node.alt = version.title;
  }
  return node;
}
function selectedVersion(shot) {
  return state.versions.find((version) => version.id === state.selected[shot]);
}

function selectShot(id) {
  if (!ready || busy || id === state.openShot) return;
  state.openShot = id;
  notice("");
  renderReview();
}
function versionCard(version) {
  const picked = state.selected[version.shot] === version.id;
  const card = element("article", "", picked ? "card active" : "card");
  card.dataset.version = version.id;
  const frame = element("div", "", "media");
  const asset = media(version, true);
  if (version.type === "video") {
    asset.onplay = () => {
      stopPlayback();
      document.querySelectorAll("#versions video").forEach((other) => {
        if (other !== asset) other.pause();
      });
    };
  }
  frame.append(asset);
  const body = element("div", "", "card-body");
  const badges = element("div", "", "badges");
  badges.append(element("span", statuses[version.status], "badge " + version.status));
  if (picked) badges.append(element("span", "当前选用", "badge picked"));
  const label = element("label", "审核备注", "note-label");
  const note = element("textarea");
  note.rows = 1;
  note.maxLength = 500;
  note.placeholder = "填写退回原因或审核意见";
  note.value = drafts.get(version.id) ?? version.note;
  note.oninput = () => drafts.set(version.id, note.value);
  label.append(note);
  const actions = element("div", "", "actions");
  const reject = button("退回", () => review(version, "rejected", note), "reject");
  const approve = button("通过", () => review(version, "approved", note), "approve");
  const pick = button(picked ? "已选用" : "选用", () => pickVersion(version, note), "pick");
  pick.disabled = role === "viewer" || picked || version.status !== "approved";
  if (version.status !== "approved") pick.title = "通过审核后即可选用";
  actions.append(approve, reject, pick, button("保存备注", () => review(version, version.status, note)));
  if (role === "viewer") {
    note.readOnly = true;
    actions.hidden = true;
  }
  body.append(element("h3", version.title), badges, label, actions, productionUI.versionTools(version, currentShot()));
  if (version.reviewedBy) body.append(element("small", "最近审核 · " + version.reviewedBy));
  card.append(frame, body);
  return card;
}
async function review(version, status, input) {
  const note = input.value.trim();
  if (status === "rejected" && !note) {
    notice("请先填写退回原因。", true);
    input.focus();
    return;
  }
  const deselected = status === "rejected" && state.selected[version.shot] === version.id;
  if (await commit({ kind: "review", version: version.id, status, note })) {
    drafts.delete(version.id);
    renderReview();
    notice(deselected ? "已退回并取消选用，请为此镜头选一个通过版。" : statuses[status] + " · 备注已保存");
    if (deselected) seekTo(clipStart(version.shot));
  }
}
async function pickVersion(version, input) {
  if (version.status !== "approved") return;
  if (await commit({ kind: "pick", version: version.id, note: input.value.trim() })) {
    drafts.delete(version.id);
    renderReview();
    seekTo(clipStart(version.shot));
    notice("已选用「" + version.title + "」，预览已跳到该镜头。");
  }
}
function shotDragHandle(clip, index, row) {
  const handle = element("span", "⠿", "shot-grip");
  handle.title = "拖动调整镜头顺序";
  handle.setAttribute("aria-hidden", "true");
  let drag;
  function clear() {
    if (!drag) return;
    drag.target?.removeAttribute("data-drop");
    row.classList.remove("dragging");
    drag = null;
  }
  function findTarget(event) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".shot-row");
    return target?.parentElement === $("shots") && target !== row ? target : null;
  }
  handle.onpointerdown = (event) => {
    if (!event.isPrimary || event.button !== 0 || busy) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, project: activeProject, revision, target: null };
    row.classList.add("dragging");
  };
  handle.onpointermove = (event) => {
    if (drag?.id !== event.pointerId) return;
    const target = findTarget(event);
    if (target === drag.target) return;
    drag.target?.removeAttribute("data-drop");
    if (target) {
      const targetIndex = clips.findIndex(({ id }) => id === target.dataset.shot);
      target.dataset.drop = targetIndex < index ? "before" : "after";
    }
    drag.target = target;
  };
  handle.onpointerup = async (event) => {
    if (drag?.id !== event.pointerId) return;
    const target = findTarget(event);
    const current = drag.project === activeProject && drag.revision === revision;
    clear();
    if (current && target) await saveShotOrder({ shot: clip.id, target: target.dataset.shot });
  };
  handle.onpointercancel = clear;
  handle.onlostpointercapture = clear;
  return handle;
}

function renderReview() {
  const canWrite = ready && role !== "viewer";
  const canSort = canWrite && clips.length > 1;
  $("shot-sort-hint").hidden = !canSort;
  $("shots").replaceChildren(...clips.map((clip, index) => {
    const node = button("", () => selectShot(clip.id), "shot-tab");
    const label = element("span");
    label.append(element("strong", shotNumber(index)), document.createTextNode(clip.title));
    label.append(element("small", selectedVersion(clip.id) ? "已有选用版本" : "待选择版本"));
    node.append(label);
    node.setAttribute("aria-current", String(clip.id === state.openShot));
    const row = element("div", "", "shot-row");
    row.dataset.shot = clip.id;
    row.append(node);
    if (canSort) row.append(shotDragHandle(clip, index, row));
    return row;
  }));
  const current = currentShot();
  const index = clips.indexOf(current);
  $("shot-count").textContent = String(clips.length);
  $("add-shot").hidden = !canWrite;
  $("upload-label").hidden = !canWrite || !current;
  $("shot-actions").hidden = !canWrite || !current;
  $("move-up").disabled = index <= 0;
  $("move-down").disabled = index < 0 || index >= clips.length - 1;
  $("shot-number").textContent = current ? "镜头 " + shotNumber(index) + " · " + current.duration + " 秒" : "";
  $("shot-title").textContent = current?.title ?? (ready ? "这个项目还没有镜头" : "正在打开项目…");
  $("shot-context").textContent = current?.context ?? (canWrite ? "点击「新增镜头」填写分镜，再导入该镜头的图片或视频。" : "");
  productionUI.renderShot(current, ready);
  const versions = state.versions.filter((version) => version.shot === current?.id);
  $("versions").replaceChildren(...versions.map(versionCard));
  if (current && versions.length === 0) {
    $("versions").append(element("p", "此镜头还没有导入版本。", "context"));
  }
  const actions = {
    review: "审核", pick: "选用", import: "导入",
    createProject: "新建项目", addShot: "新增镜头", editShot: "编辑镜头", moveShot: "调整镜头顺序",
    addReference: "新增角色参考", confirmReference: "确认角色参考", bindReferences: "绑定角色参考",
    lockFrame: "确认关键帧", addIssue: "标记问题", checkConsistency: "AI 一致性检查",
    startGeneration: "发起生成", generationReceipt: "保存任务回执", generationProgress: "更新生成状态", generationComplete: "导入生成结果",
  };
  $("team-activity").replaceChildren(...state.activity.slice(0, 10).map((entry) => {
    const version = state.versions.find(({ id }) => id === entry.version);
    const clip = clips.find(({ id }) => id === entry.shot);
    return element("li", [new Date(entry.at).toLocaleString(), entry.actor, actions[entry.action],
      clip?.title ?? entry.title, version?.title].filter(Boolean).join(" · "));
  }));
  $("activity-panel").hidden = !state.activity.length;
}

function editorError(message = "") {
  $("editor-error").textContent = message;
  $("editor-error").hidden = !message;
}

let editor;
function openEditor(kind, clip) {
  if (!ready || busy || role === "viewer") return;
  editor = { kind, shot: clip?.id };
  const projectForm = kind === "project";
  $("editor-heading").textContent = { project: "新建项目", add: "新增镜头", edit: "编辑镜头" }[kind];
  $("editor-title-label").textContent = projectForm ? "片名" : "镜头标题";
  $("editor-title").value = clip?.title ?? "";
  $("editor-context").value = clip?.context ?? "";
  $("editor-duration").value = clip?.duration ?? 4;
  $("editor-duration").required = !projectForm;
  $("editor-shot-fields").hidden = projectForm;
  editorError();
  $("editor-dialog").showModal();
  $("editor-title").focus();
}

$("new-project").onclick = () => openEditor("project");
$("add-shot").onclick = () => openEditor("add");
$("edit-shot").onclick = () => openEditor("edit", currentShot());
$("editor-cancel").onclick = () => { if (!busy) $("editor-dialog").close(); };
$("editor-dialog").addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });

async function makeProject(title) {
  busy = true;
  $("project-select").disabled = true;
  try {
    const data = await post("/api/projects", { title });
    projects = [projects[0], data.project, ...projects.slice(1)];
    applySnapshot(data, data.project.id);
    rememberProject(activeProject);
    return true;
  } catch (error) {
    editorError(error.message);
    return false;
  } finally {
    busy = false;
    $("project-select").disabled = false;
  }
}
$("editor-form").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  editorError();
  $("editor-save").disabled = true;
  const { kind, shot } = editor;
  const title = $("editor-title").value;
  const saved = kind === "project"
    ? await makeProject(title)
    : await commit({
      kind, shot, title, context: $("editor-context").value, duration: $("editor-duration").valueAsNumber,
    }, null, "/api/shots", editorError);
  $("editor-save").disabled = false;
  if (!saved) return;
  $("editor-dialog").close();
  if (kind === "add") selectShot(clips.at(-1).id);
  notice({ project: "已创建空白项目。", add: "已新增镜头。", edit: "已保存镜头设置并更新预览。" }[kind]);
};
async function saveShotOrder(move) {
  if (!await commit({ kind: "move", ...move }, null, "/api/shots")) return false;
  notice("镜头顺序和预览已更新。");
  return true;
}
async function moveShot(direction, control) {
  if (currentShot() && await saveShotOrder({ shot: state.openShot, direction })) {
    (control.disabled ? $("edit-shot") : control).focus();
  }
}
$("move-up").onclick = () => moveShot(-1, $("move-up"));
$("move-down").onclick = () => moveShot(1, $("move-down"));


function validateAsset(file, type) {
  const src = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const node = element(type === "video" ? "video" : "img");
    const finish = (error, videoDuration) => {
      clearTimeout(timer);
      node.removeAttribute("src");
      URL.revokeObjectURL(src);
      if (error) reject(new Error("浏览器无法读取该素材，请检查文件或视频编码。"));
      else resolve(videoDuration);
    };
    const timer = setTimeout(() => finish(true), 10000);
    node.onerror = () => finish(true);
    if (type === "video") {
      node.preload = "metadata";
      node.onloadedmetadata = () => finish(!Number.isFinite(node.duration) || node.duration <= 0, node.duration);
    } else {
      node.onload = () => finish(false);
    }
    node.src = src;
  });
}
$("upload").addEventListener("change", async (event) => {
  const input = event.target;
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  if (!ready || busy || !state.openShot) return;
  const shot = state.openShot;
  const project = activeProject;
  if (file.size > 50 * 1024 * 1024) {
    notice("文件最大为 50 MB。", true);
    return;
  }
  const type = file.type === "video/mp4" || (!file.type && /\.mp4$/i.test(file.name)) ? "video" : "image";
  if (type === "image" && !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    notice("请选择 PNG、JPEG、WebP 图片或 MP4 视频。", true);
    return;
  }
  try {
    notice("正在检查素材…");
    await validateAsset(file, type);
    if (project !== activeProject || shot !== state.openShot) {
      notice("导入已取消。请在目标镜头中重新选择文件。", true);
      return;
    }
    if (busy) {
      notice("正在保存其他操作。请稍后重新导入。", true);
      return;
    }
    const form = new FormData();
    form.append("shot", shot);
    form.append("file", !file.type && type === "video" ? new File([file], file.name, { type: "video/mp4" }) : file, file.name);
    if (await commit(null, form)) {
      renderReview();
      notice("已导入「" + currentShot()?.title + "」的新版本，状态为待审。");
    }
  } catch (error) {
    notice(error.message, true);
  }
});

let total = 0;
let starts = [];
const clipStart = (id) => starts[clips.findIndex((clip) => clip.id === id)];
const video = $("preview-video");
let position = 0;
let playing = false;
let displayed = "";
let run = 0;
let timer;
let stillStartedAt;
let stillStartPosition;
let holding = false;
const clock = (seconds) => [
  Math.floor(seconds / 60), Math.floor(seconds % 60),
].map((part) => String(part).padStart(2, "0")).join(":");

function previewInfo() {
  const index = starts.findLastIndex((start) => position >= start);
  const clip = clips[index];
  return { clip, offset: clip ? position - starts[index] : 0, version: clip && selectedVersion(clip.id) };
}
function playerMessage(message = "") {
  $("player-message").textContent = message;
  $("player-message").hidden = !message;
}
function updatePlayer() {
  const { clip, version } = previewInfo();
  $("seek").value = position;
  $("clock").textContent = clock(position) + " / " + clock(total);
  $("play").textContent = playing ? "Ⅱ 暂停" : "▶ 播放";
  $("sound").textContent = video.muted ? "静音" : "有声";
  $("sound").setAttribute("aria-pressed", String(!video.muted));
  $("play").disabled = !$("timeline").children.length;
  $("seek").disabled = !total;
  $("sound").disabled = !total;
  const label = clip ? shotNumber(clips.indexOf(clip)) + " · " + (version?.title ?? "暂无选用版本") : "";
  if ($("preview-status").textContent !== label) $("preview-status").textContent = label;
  for (const node of $("timeline").children) {
    node.setAttribute("aria-current", String(node.dataset.shot === clip?.id));
  }
}
function showPreview() {
  const { clip, version } = previewInfo();
  const key = [activeProject, clip?.id, version?.id].join("/");
  if (key !== displayed) {
    displayed = key;
    video.pause();
    video.onloadedmetadata = null;
    const image = $("preview-image");
    image.hidden = version?.type !== "image";
    video.hidden = version?.type !== "video";
    $("preview-empty").hidden = Boolean(version);
    $("preview-empty").textContent = clip ? "此镜头还没有选用版本" : "新增镜头后，预览将在这里显示";
    if (image.hidden) image.removeAttribute("src");
    if (video.hidden && video.hasAttribute("src")) {
      video.removeAttribute("src");
      video.removeAttribute("poster");
      video.load();
    }
    if (!image.hidden) {
      image.alt = version.title;
      image.src = clipSource(version);
    }
    if (!video.hidden) {
      video.setAttribute("aria-label", version.title);
      if (version.poster) video.poster = version.poster;
      else video.removeAttribute("poster");
      video.src = clipSource(version);
    }
  }
  updatePlayer();
}
function seekVideo(offset) {
  const apply = () => {
    if (!Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(offset, video.duration);
  };
  if (video.readyState >= 1) apply();
  else video.onloadedmetadata = apply;
}
function stopPlayback() {
  run++;
  playing = false;
  clearTimeout(timer);
  video.pause();
  updatePlayer();
}
function seekTo(seconds) {
  stopPlayback();
  playerMessage();
  position = Math.max(0, Math.min(total, seconds));
  showPreview();
  if (!video.hidden) seekVideo(previewInfo().offset);
}
function playVideo(attempt) {
  playerMessage("视频正在加载…");
  seekVideo(previewInfo().offset);
  if (video.readyState >= 1 && previewInfo().offset >= video.duration) {
    return holdFrame(previewInfo().offset);
  }
  const start = () => video.play();
  start().catch((error) => {
    if (attempt !== run || error.name === "AbortError") return;
    if (error.name !== "NotAllowedError" || video.muted) throw error;
    video.muted = true;
    updatePlayer();
    return start();
  }).catch(() => {
    if (attempt !== run) return;
    stopPlayback();
    playerMessage("浏览器未能开始播放。请点击播放重试。");
  });
}
function holdFrame(offset) {
  holding = true;
  stillStartedAt = performance.now();
  stillStartPosition = clipStart(previewInfo().clip.id) + offset;
  playerMessage();
}
function beginClip() {
  holding = false;
  stillStartedAt = performance.now();
  stillStartPosition = position;
  if (!video.hidden) playVideo(run);
  else playerMessage();
}
function tick() {
  if (!playing) return;
  const { clip } = previewInfo();
  const start = clipStart(clip.id);
  const end = start + clip.duration;
  if (!video.hidden && !holding && video.ended) {
    holdFrame(Math.max(position - start, video.currentTime));
  }
  if (video.hidden || holding) {
    position = Math.min(end, stillStartPosition + (performance.now() - stillStartedAt) / 1000);
  } else {
    position = Math.min(end, start + video.currentTime);
    if (video.currentTime > 0 && video.readyState >= 3) playerMessage();
  }
  if (position >= total) {
    position = total;
    stopPlayback();
    return;
  }
  showPreview();
  if (position >= end) beginClip();
  timer = setTimeout(tick, 80);
}
video.addEventListener("error", () => {
  if (video.hidden) return;
  stopPlayback();
  playerMessage("预览视频加载失败。请点击播放重试，或检查素材能否打开。");
});
video.addEventListener("waiting", () => {
  if (playing && !video.hidden) playerMessage("视频正在缓冲…");
});
video.addEventListener("playing", () => {
  if (playing && !video.hidden) playerMessage();
});
$("play").onclick = () => {
  if (!total) return;
  if (playing) {
    stopPlayback();
    playerMessage();
    return;
  }
  document.querySelectorAll("#versions video").forEach((version) => version.pause());
  if (position >= total) position = 0;
  playing = true;
  showPreview();
  if (!video.hidden && video.error) video.load();
  beginClip();
  timer = setTimeout(tick, 80);
};
$("sound").onclick = () => {
  video.muted = !video.muted;
  updatePlayer();
};
$("seek").max = total;
$("seek").oninput = (event) => seekTo(Number(event.target.value));
let exportPlan;
let exportTitle;
let movieController;
let movieUrl;
function movieMessage(message = "", error = false) {
  const status = $("movie-message");
  status.textContent = message;
  status.classList.toggle("error", error);
  status.hidden = !message;
}
$("open-movie").onclick = () => {
  if (!ready || busy || movieController) return;
  stopPlayback();
  document.querySelectorAll("#versions video").forEach((item) => item.pause());
  exportPlan = moviePlan(clips, state.versions, state.selected);
  exportTitle = projects.find(({ id }) => id === activeProject)?.title ?? "竖屏成片";
  const { shots, missing, duration } = exportPlan;
  $("movie-details").textContent = shots.length
    ? exportTitle + " · " + shots.length + " 个镜头 · " + clock(duration) + " · 720 × 1280 MP4"
    : "这个项目还没有镜头。";
  const list = $("movie-missing");
  list.hidden = !missing.length;
  list.replaceChildren(...missing.map((shot) => {
    const row = element("li");
    row.append(button("镜头 " + shotNumber(shot.index) + " · " + shot.title, () => {
      $("movie-dialog").close();
      selectShot(shot.id);
      seekTo(clipStart(shot.id));
      notice("请选用一个已通过的版本，再导出成片。", true);
      $("shot-title").focus();
    }));
    return row;
  }));
  movieMessage(missing.length ? "请先为以下镜头选用版本。" : "");
  $("start-movie").hidden = !shots.length || Boolean(missing.length);
  $("movie-dialog").showModal();
};
$("close-movie").onclick = () => $("movie-dialog").close();
$("movie-dialog").addEventListener("close", () => {
  movieController?.abort();
  if (movieUrl) URL.revokeObjectURL(movieUrl);
  movieUrl = null;
  $("download-movie").removeAttribute("href");
  $("download-movie").hidden = true;
  $("movie-progress").hidden = true;
});
$("start-movie").onclick = async () => {
  if (movieController || !exportPlan?.shots.length || exportPlan.missing.length) return;
  const controller = new AbortController();
  movieController = controller;
  const start = $("start-movie");
  const progress = $("movie-progress");
  start.disabled = true;
  progress.hidden = false;
  progress.removeAttribute("value");
  progress.max = exportPlan.duration;
  $("close-movie").textContent = "取消导出";
  movieMessage("正在加载素材，请保持此页面在前台。");
  try {
    let rendering = false;
    const file = await renderMovie(exportPlan, (elapsed) => {
      if (!rendering) {
        movieMessage("正在生成 MP4，请保持此页面在前台。");
        rendering = true;
      }
      progress.value = elapsed;
    }, controller);
    controller.signal.throwIfAborted();
    progress.value = progress.max;
    movieUrl = URL.createObjectURL(file);
    const link = $("download-movie");
    link.href = movieUrl;
    link.download = exportTitle.replace(/[<>:"/\\|?*]/g, "_") + "-竖屏成片.mp4";
    link.hidden = false;
    start.hidden = true;
    movieMessage("成片已生成。");
  } catch (error) {
    if ($("movie-dialog").open) {
      progress.hidden = true;
      movieMessage(error.message || "导出失败，请重试。", true);
    }
  } finally {
    movieController = null;
    start.disabled = false;
    $("close-movie").textContent = "关闭";
  }
};
$("export-review").onclick = () => {
  const report = {
    project: projects.find(({ id }) => id === activeProject)?.title,
    projectId: activeProject,
    revision,
    exportedAt: new Date().toISOString(),
    activity: state.activity,
    shots: clips.map(({ id, title, duration, context }, index) => ({
      id, title, duration, context, start: starts[index], selectedVersion: state.selected[id] ?? null,
      versions: state.versions.filter((version) => version.shot === id).map(({ id, title, type, status, note, reviewedAt, reviewedBy, checkedAt, checkedFrames, issues, replaces, keyframe }) => ({
        id, title, type, status: statuses[status], note, reviewedAt: reviewedAt ?? null, reviewedBy: reviewedBy ?? null,
        checkedAt, checkedFrames, issues, replaces, keyframe,
      })),
    })),
  };
  const link = element("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  link.download = (report.project ?? "review").replace(/[<>:"/\\|?*]/g, "_") + "-review.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
function renderTimeline() {
  total = 0;
  starts = clips.map(({ duration }) => {
    const start = total;
    total += duration;
    return start;
  });
  $("seek").max = total;
  $("timeline").replaceChildren(...clips.map((clip, index) => {
    const node = button("", () => seekTo(starts[index]));
    node.dataset.shot = clip.id;
    node.setAttribute("aria-label", "跳到镜头 " + shotNumber(index) + " " + clip.title);
    node.append(element("span", shotNumber(index)), element("small", clock(starts[index])));
    return node;
  }));
}

async function openProject(project) {
  if (busy) return;
  busy = true;
  $("project-select").disabled = true;
  stopPlayback();
  try {
    await refreshWorkspace(project);
    notice(project ? "" : "已载入最新团队记录。");
  } catch (error) {
    notice(error.message, true);
    $("project-select").value = activeProject;
  } finally {
    busy = false;
    $("project-select").disabled = !ready;
  }
}
$("project-select").onchange = (event) => openProject(event.target.value);
$("refresh-team").onclick = () => openProject();
const productionUI = setupProduction({ $, element, button, context: () => ({ state, role, capabilities }),
  commit, checkFile: validateAsset });
renderReview();
showPreview();
openProject();

let managingMembers = false;
const memberRoles = { reviewer: "审核员", viewer: "只读成员" };
function memberMessage(value, error = false) {
  const node = $("member-message");
  node.textContent = value;
  node.hidden = !value;
  node.classList.toggle("error", error);
}
async function fetchMembers() {
  const response = await fetch("/api/members", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取成员，请重试。");
  const data = await response.json();
  const rows = data.members.map(({ email, role }) => {
    const row = element("div", "", "member-row");
    row.append(
      element("span", email + " · " + memberRoles[role]),
      button("修改角色", () => {
        $("member-email").value = email;
        $("member-role").value = role;
        $("member-role").focus();
      }),
      button("撤销角色", () => {
        if (window.confirm("撤销 " + email + " 的团队审核权限？")) saveMember(email, "revoked");
      }),
    );
    return row;
  });
  $("member-list").replaceChildren(...rows);
  if (!rows.length) $("member-list").append(element("p", "暂无通过此页面配置的成员。", "context"));
}
async function saveMember(email, role) {
  if (managingMembers) return;
  managingMembers = true;
  $("save-member").disabled = true;
  try {
    const response = await fetch("/api/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    memberMessage(role === "revoked"
      ? "审片权限已撤销。如需清理站点访问名单，也请从「共享」中移除此邮箱。"
      : "角色已保存。请在站点「共享」中授权此邮箱，再发送邀请说明。");
    await fetchMembers();
  } catch (error) {
    memberMessage(error.message, true);
  } finally {
    managingMembers = false;
    $("save-member").disabled = false;
  }
}
$("open-members").onclick = async () => {
  $("members-dialog").showModal();
  memberMessage("");
  try { await fetchMembers(); }
  catch (error) { memberMessage(error.message, true); }
};
$("member-form").onsubmit = (event) => {
  event.preventDefault();
  saveMember($("member-email").value, $("member-role").value);
};
$("copy-invite").onclick = async () => {
  const message = "请用获邀的 ChatGPT 邮箱登录《下一班车》团队审核工作区：" + location.origin + "/";
  try {
    await navigator.clipboard.writeText(message);
    memberMessage("邀请说明已复制。");
  } catch {
    const fallback = $("invite-copy-fallback");
    fallback.value = message;
    fallback.hidden = false;
    fallback.select();
  }
};
