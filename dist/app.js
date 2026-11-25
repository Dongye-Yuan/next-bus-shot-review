const clips = [
  { id: "01", title: "雨夜站棚", duration: 4, context: "双人中景，建立站棚与人物站位。" },
  { id: "02", title: "林澈近景", duration: 4, context: "核对林澈本人左眉尾的浅疤。" },
  { id: "03", title: "许棠看伞", duration: 4, context: "核对黄色发夹是否在许棠本人右侧。" },
  { id: "04", title: "开伞与共伞", duration: 5, context: "检查伞面尺寸、伞柄和两人的外观。两个通过版本都可选用。" },
];

const sample = (id, shot, title, file, status, note = "", poster) => ({
  id, shot, title, file: "./media/" + file, status, note,
  type: file.endsWith(".mp4") ? "video" : "image", poster: poster && "./media/" + poster,
});
const initial = {
  versions: [
    sample("01-approved", "01", "雨夜站棚关键帧", "01.png", "approved"),
    sample("02-approved", "02", "林澈正面近景", "02.png", "approved"),
    sample("03-old", "03", "旧版 · 发夹换边", "03-old.png", "pending"),
    sample("03-fixed", "03", "修正版 · 本人右侧发夹", "03.png", "approved"),
    sample("04-doubao", "04", "豆包 · 开伞原版", "04-open.mp4", "approved", "", "04.png"),
    sample("04-flow", "04", "Flow · 共伞替代版", "04-shared.mp4", "approved", "", "04-shared.png"),
    sample("04-failed", "04", "Flow · 失败样片", "04-failed.mp4", "pending"),
  ],
  selected: { "01": "01-approved", "02": "02-approved", "03": "03-fixed", "04": "04-doubao" },
  openShot: "03",
};
let state = structuredClone(initial);
let database;
let busy = false;
const urls = new Map();
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
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("next-bus-review", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("project");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function readState() {
  return new Promise((resolve, reject) => {
    const request = database.transaction("project").objectStore("project").get("current");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function commit(next) {
  if (busy) return false;
  busy = true;
  try {
    if (database) {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("project", "readwrite");
        transaction.objectStore("project").put(next, "current");
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    }
    state = next;
    return true;
  } catch {
    notice("保存失败。请检查浏览器的可用存储空间。", true);
    return false;
  } finally {
    busy = false;
  }
}
function clipSource(version) {
  if (!version.blob) return version.file;
  if (!urls.has(version.id)) urls.set(version.id, URL.createObjectURL(version.blob));
  return urls.get(version.id);
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

async function selectShot(id) {
  if (id === state.openShot) return;
  const next = { ...state, openShot: id };
  if (await commit(next)) {
    notice("");
    renderReview();
  }
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
  pick.disabled = picked || version.status !== "approved";
  if (version.status !== "approved") pick.title = "通过审核后即可选用";
  actions.append(approve, reject, pick, button("保存备注", () => review(version, version.status, note)));
  body.append(element("h3", version.title), badges, label, actions);
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
  const next = {
    ...state,
    versions: state.versions.map((entry) => entry.id === version.id ? { ...entry, status, note, reviewedAt: new Date().toISOString() } : entry),
    selected: { ...state.selected },
  };
  const deselected = status === "rejected" && next.selected[version.shot] === version.id;
  if (deselected) delete next.selected[version.shot];
  if (await commit(next)) {
    drafts.delete(version.id);
    renderReview();
    notice(deselected ? "已退回并取消选用，请为此镜头选一个通过版。" : statuses[status] + " · 备注已保存");
    if (deselected) seekTo(clipStart(version.shot));
  }
}
async function pickVersion(version, input) {
  if (version.status !== "approved") return;
  const next = {
    ...state,
    selected: { ...state.selected, [version.shot]: version.id },
    versions: state.versions.map((entry) =>
      entry.id === version.id ? { ...entry, note: input.value.trim() } : entry),
  };
  if (await commit(next)) {
    drafts.delete(version.id);
    renderReview();
    seekTo(clipStart(version.shot));
    notice("已选用「" + version.title + "」，预览已跳到该镜头。");
  }
}
function renderReview() {
  $("shots").replaceChildren(...clips.map((clip) => {
    const node = button("", () => selectShot(clip.id), "shot-tab");
    const label = element("span");
    label.append(element("strong", clip.id), document.createTextNode(clip.title));
    label.append(element("small", selectedVersion(clip.id) ? "已有选用版本" : "待选择版本"));
    node.append(label);
    node.setAttribute("aria-current", String(clip.id === state.openShot));
    return node;
  }));
  const current = clips.find((clip) => clip.id === state.openShot);
  $("shot-number").textContent = "镜头 " + current.id;
  $("shot-title").textContent = current.title;
  $("shot-context").textContent = current.context;
  $("versions").replaceChildren(...state.versions.filter((version) => version.shot === current.id).map(versionCard));
}

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
  const shot = state.openShot;
  const type = file.type === "video/mp4" || (!file.type && /\.mp4$/i.test(file.name)) ? "video" : "image";
  if (type === "image" && !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    notice("请选择 PNG、JPEG、WebP 图片或 MP4 视频。", true);
    return;
  }
  try {
    notice("正在检查素材…");
    const duration = await validateAsset(file, type);
    const imported = { id: crypto.randomUUID(), shot, title: file.name, type, blob: file, status: "pending", note: "", duration };
    if (await commit({ ...state, openShot: shot, versions: [...state.versions, imported] })) {
      renderReview();
      notice("已导入镜头 " + shot + " 的新版本，状态为待审。");
    }
  } catch (error) {
    notice(error.message, true);
  }
});

let total = 0;
const starts = clips.map(({ duration }) => {
  const start = total;
  total += duration;
  return start;
});
const clipStart = (id) => starts[clips.findIndex((clip) => clip.id === id)];
const video = $("preview-video");
let position = 0;
let playing = false;
let displayed = "";
let run = 0;
let timer;
let stillStartedAt;
let stillStartPosition;
const clock = (seconds) => "00:" + String(Math.floor(seconds)).padStart(2, "0");

function previewInfo() {
  const index = starts.findLastIndex((start) => position >= start);
  const clip = clips[index];
  return { clip, offset: position - starts[index], version: selectedVersion(clip.id) };
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
  const label = version ? clip.id + " · " + version.title : clip.id + " · 暂无选用版本";
  if ($("preview-status").textContent !== label) $("preview-status").textContent = label;
  for (const node of $("timeline").children) {
    node.setAttribute("aria-current", String(node.dataset.shot === clip.id));
  }
}
function showPreview() {
  const { clip, version } = previewInfo();
  const key = clip.id + "/" + (version?.id ?? "");
  if (key !== displayed) {
    displayed = key;
    video.pause();
    video.onloadedmetadata = null;
    const image = $("preview-image");
    image.hidden = version?.type !== "image";
    video.hidden = version?.type !== "video";
    $("preview-empty").hidden = Boolean(version);
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
function beginClip() {
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
  if (video.hidden) {
    position = Math.min(end, stillStartPosition + (performance.now() - stillStartedAt) / 1000);
  } else {
    position = video.ended ? end : Math.min(end, start + video.currentTime);
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
$("export-review").onclick = () => {
  const report = {
    project: "下一班车",
    exportedAt: new Date().toISOString(),
    shots: clips.map(({ id, title, duration }) => ({
      id, title, duration, selectedVersion: state.selected[id] ?? null,
      versions: state.versions.filter((version) => version.shot === id).map(({ id, title, type, status, note, reviewedAt }) => ({
        id, title, type, status: statuses[status], note, reviewedAt: reviewedAt ?? null,
      })),
    })),
  };
  const link = element("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  link.download = "next-bus-review.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
$("timeline").replaceChildren(...clips.map((clip, index) => {
  const node = button("", () => seekTo(starts[index]));
  node.dataset.shot = clip.id;
  node.setAttribute("aria-label", "跳到镜头 " + clip.id);
  node.append(element("span", clip.id), element("small", clock(starts[index])));
  return node;
}));

try {
  database = await openDatabase();
  state = await readState() ?? state;
  $("storage").textContent = "审核记录保存在此浏览器";
} catch {
  database = undefined;
  $("storage").textContent = "浏览器存储不可用 · 刷新前有效";
}
renderReview();
showPreview();
