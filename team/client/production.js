import { angles, shotPrompt } from "./shot-prompt.js";
const features = ["脸型", "发型", "标志性特征", "服装", "其他"];
const imageTypes = "image/jpeg,image/png,image/webp";
const demoPath = "https://next-bus-shot-review.riferice4.chatgpt.site/media/";
const demoFiles = "https://raw.githubusercontent.com/Dongye-Yuan/next-bus-shot-review/5034e17b5910d7cd439b71c9a8f14a48dec2461c/dist/media/";
const jobLabels = { submitting: "正在提交", queued: "排队中", running: "生成中", completed: "已导入待审", failed: "失败", unknown: "提交状态不明" };

function waitFor(node, event, start) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("素材读取超时。")), 12000);
    function finish(error) {
      clearTimeout(timer);
      node.removeEventListener(event, complete);
      node.removeEventListener("error", failed);
      if (error) reject(error);
      else resolve();
    }
    const complete = () => finish();
    const failed = () => finish(new Error("暂无法读取该素材，请重新导入后再试。"));
    node.addEventListener(event, complete, { once: true });
    node.addEventListener("error", failed, { once: true });
    start();
  });
}

async function sampledFrames(version) {
  const video = version.type === "video";
  const node = document.createElement(video ? "video" : "img");
  if (video) { node.preload = "auto"; node.playsInline = true; node.muted = true; }
  const demo = version.file.startsWith(demoPath);
  if (demo) node.crossOrigin = "anonymous";
  try {
    await waitFor(node, video ? "loadeddata" : "load", () => {
      node.src = demo ? demoFiles + encodeURIComponent(version.file.slice(demoPath.length)) : version.file;
    });
    const duration = video ? Math.min(node.duration, 300) : 0;
    if (!Number.isFinite(duration) || (video && duration <= 0)) throw new Error("该视频时长无效。");
    const times = video ? [0, ...[0.25, 0.5, 0.75, 0.92].map((part) => duration * part)] : [0];
    const canvas = document.createElement("canvas");
    const w = video ? node.videoWidth : node.naturalWidth;
    const h = video ? node.videoHeight : node.naturalHeight;
    const scale = Math.min(1, 960 / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const context = canvas.getContext("2d");
    const frames = [];
    for (const time of times) {
      if (video && time) await waitFor(node, "seeked", () => { node.currentTime = time; });
      context.drawImage(node, 0, 0, canvas.width, canvas.height);
      frames.push({ time: Math.round(time * 100) / 100, image: canvas.toDataURL("image/jpeg", 0.78) });
    }
    return frames;
  } finally {
    node.removeAttribute("src");
    if (video) node.load();
  }
}

export function setupProduction({ $, element, button, context, commit, checkFile }) {
  const dialog = $("production-dialog");
  const content = $("production-body");
  const notice = $("production-notice");
  let working = false;
  function message(text = "", error = false) {
    notice.textContent = text;
    notice.classList.toggle("error", error);
    notice.hidden = !text;
  }
  function open(title) {
    message();
    content.replaceChildren();
    $("production-title").textContent = title;
    if (!dialog.open) dialog.showModal();
  }
  function field(label, type, options = {}) {
    const wrapper = element("label", label, "production-field");
    const input = element(type);
    Object.assign(input, options);
    wrapper.append(input);
    return [wrapper, input];
  }
  function select(label, choices) {
    const [wrapper, input] = field(label, "select");
    for (const [value, text] of choices) {
      const option = element("option", text);
      option.value = value;
      input.append(option);
    }
    return [wrapper, input];
  }
  const config = () => context().state.production ?? { references: [], shots: {}, jobs: [] };
  const writable = () => context().role !== "viewer";
  const bindings = (shot) => config().shots[shot]?.references ?? [];
  const findRef = (id) => config().references.find((ref) => ref.id === id);
  const findVersion = (id) => context().state.versions.find((version) => version.id === id);

  async function run(action, form, path, success) {
    if (working) return false;
    working = true;
    dialog.setAttribute("aria-busy", "true");
    try {
      const ok = await commit(action, form, path, message);
      if (ok) {
        success?.();
        message("已保存。");
      }
      return ok;
    } finally {
      working = false;
      dialog.removeAttribute("aria-busy");
    }
  }

  function image(src, alt) {
    const img = element("img");
    img.src = src;
    img.alt = alt;
    img.loading = "lazy";
    return img;
  }
  function figures(ref) {
    const gallery = element("div", "", "references-gallery");
    for (const [key, title] of Object.entries(angles)) {
      const figure = element("figure");
      figure.append(image(ref.images[key].file, ref.name + " " + title), element("figcaption", title));
      gallery.append(figure);
    }
    return gallery;
  }
  function showReferences() {
    open("项目角色参考");
    if (writable()) content.append(button("新增角色参考版本", newReference, "pick"));
    if (!config().references.length) content.append(element("p", "还没有角色参考。每套参考包含角色特征、服装、正面、侧面和全身图。", "context"));
    for (const ref of [...config().references].reverse()) {
      const card = element("article", "", "production-card");
      card.append(element("h3", ref.name + " · 第 " + ref.edition + " 版 · " + (ref.confirmedAt ? "已确认" : "待确认")),
        element("p", ref.identity, "context"), element("p", "服装 · " + ref.outfit, "context"), figures(ref));
      if (writable() && !ref.confirmedAt) {
        card.append(button("确认该版本", () => run({ kind: "confirmReference", reference: ref.id }, null, "/api/production", showReferences)));
      }
      content.append(card);
    }
  }
  function newReference() {
    open("新增角色参考版本");
    const form = element("form", "", "production-form");
    const [nameLabel, name] = field("角色名", "input", { required: true, maxLength: 80 });
    const [identityLabel, identity] = field("身份特征（脸型、发型、标志性特征）", "textarea", { required: true, maxLength: 600, rows: 3 });
    const [outfitLabel, outfit] = field("本版服装", "input", { required: true, maxLength: 300 });
    form.append(nameLabel, identityLabel, outfitLabel);
    const files = Object.entries(angles).map(([key, label]) => {
      const [wrapper, input] = field(label + "图（最大 3 MB）", "input", { type: "file", accept: imageTypes, required: true });
      form.append(wrapper);
      return { key, input };
    });
    const save = element("button", "保存草稿", "pick");
    save.type = "submit";
    form.append(save);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const upload = new FormData();
      for (const [key, input] of Object.entries({ name, identity, outfit })) upload.set(key, input.value);
      save.disabled = true;
      try {
        for (const { key, input } of files) {
          const file = input.files[0];
          if (!file || file.size > 3 * 1024 * 1024) throw new Error("每张参考图最大 3 MB。");
          await checkFile(file, "image");
          upload.set(key, file);
        }
        await run(null, upload, "/api/references", showReferences);
      } catch (error) {
        message(error.message, true);
      } finally {
        save.disabled = false;
      }
    };
    content.append(form);
  }

  function assign(shot) {
    open("绑定镜头角色");
    const refs = config().references.filter(({ confirmedAt }) => confirmedAt);
    if (!refs.length) {
      content.append(element("p", "请先上传并确认角色参考。", "context"), button("打开角色参考", showReferences));
      return;
    }
    const form = element("form", "", "production-form");
    const slots = [0, 1, 2].map((index) => {
      const saved = bindings(shot.id)[index];
      const row = element("div", "", "production-inline");
      const [roleLabel, role] = select("角色 " + (index + 1), [["", "未分配"], ...refs.map((ref) => [ref.id, ref.name + " · 第 " + ref.edition + " 版"])]);
      const [angleLabel, angle] = select("参考视角", Object.entries(angles));
      role.value = saved?.reference ?? "";
      angle.value = saved?.angle ?? "front";
      row.append(roleLabel, angleLabel);
      form.append(row);
      return { role, angle };
    });
    const save = element("button", "保存绑定", "pick");
    save.type = "submit";
    form.append(save);
    form.onsubmit = (event) => {
      event.preventDefault();
      const references = slots.filter(({ role }) => role.value).map(({ role, angle }) => ({ reference: role.value, angle: angle.value }));
      run({ kind: "bindReferences", shot: shot.id, references }, null, "/api/production", () => dialog.close());
    };
    content.append(form);
  }

  function attachment({ from, shot, type, frame, reuse }) {
    open(from?.type === type ? "导入外部返工版本" : "导入外部生成版本");
    const video = type === "video";
    const form = element("form", "", "production-form");
    const [label, input] = field(video ? "新版 MP4" : "新版图片", "input", {
      type: "file", required: true, accept: video ? "video/mp4,.mp4" : imageTypes,
    });
    const origin = video && frame
      ? element("p", (from ? (reuse ? "沿用关键帧 · " : "更新后关键帧 · ") : "生成用关键帧 · ") + frame.title, "context") : null;
    if (origin) form.append(origin);
    const save = element("button", "导入为待审", "pick");
    save.type = "submit";
    form.append(label, save);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const chosen = input.files[0];
      const upload = new FormData();
      save.disabled = true;
      try {
        if (!chosen || chosen.size > 50 * 1024 * 1024) throw new Error("素材最大 50 MB。");
        await checkFile(chosen, type);
        const file = video && !chosen.type
          ? new File([chosen], chosen.name, { type: "video/mp4" }) : chosen;
        upload.set("file", file);
        upload.set("shot", shot.id);
        upload.set("externalGeneration", "1");
        if (from?.type === type) upload.set("replaces", from.id);
        if (video && frame) upload.set("keyframe", frame.id);
        await run(null, upload, "/api/upload", () => dialog.close());
      } catch (error) {
        message(error.message, true);
      } finally {
        save.disabled = false;
      }
    };
    if (from) content.append(element("p", "原版 · " + from.title + " · " + from.note, "context"));
    content.append(form);
  }

  function externalPrompt({ shot, type, from, frame, references, reuse, instruction, videoReady }) {
    const box = element("section", "", "production-card external-prompt");
    const title = element("h3", "在外部工具生成");
    const tools = element("div", "", "actions");
    const [promptLabel, preview] = field("完整提示词", "textarea", { readOnly: true, rows: 10 });
    promptLabel.hidden = true;
    const copy = button("复制" + (type === "image" ? "关键帧" : "视频") + "提示词", async () => {
      try {
        const { text } = shotPrompt({ shot, type, from, frame, references, directive: instruction.value });
        preview.value = text;
        promptLabel.hidden = false;
        try {
          await navigator.clipboard.writeText(text);
          message("提示词已复制。按下方清单上传素材，生成后可导回当前镜头。");
        } catch {
          preview.focus();
          preview.select();
          message("提示词已选中，可手动复制。");
        }
      } catch (error) {
        message(error.message, true);
      }
    }, "pick");
    const importButton = button(from?.type === type ? "导入外部返工版本" : "导入外部生成版本",
      () => attachment({ from, shot, type, frame, reuse }));
    copy.disabled = !videoReady;
    importButton.disabled = !videoReady && (!from || !reuse || from.type !== type);
    tools.append(copy, importButton);
    box.append(title, tools);
    if (!videoReady) {
      box.append(element("p", "确认选定的关键帧后，即可复制视频提示词。", "context"));
    } else {
      const { assets } = shotPrompt({ shot, type, from, frame, references });
      if (assets.length) {
        const list = element("ul", "", "shot-prompt-assets");
        for (const { file, label, optional } of assets) {
          const item = element("li");
          const link = element("a", label);
          link.href = file;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          item.append(link);
          if (optional) item.append(element("small", "支持角色参考时附加"));
          list.append(item);
        }
        box.append(element("p", "要上传的素材（按顺序）", "context"), list);
      }
    }
    box.append(promptLabel);
    return box;
  }

  function preparation(shot, type, from, reuse = true) {
    open(from ? "镜头返工" : type === "image" ? "生成关键帧" : "生成视频");
    const references = bindings(shot.id).map(({ reference, angle }) => ({ ref: findRef(reference), angle }))
      .filter(({ ref }) => ref?.confirmedAt);
    const currentFrame = config().shots[shot.id]?.keyframe;
    const selected = findVersion(reuse ? (from?.keyframe ?? currentFrame) : currentFrame);
    const frame = selected?.status === "approved" && selected.type === "image" && selected.shot === shot.id ? selected : null;
    const videoReady = type !== "video" || Boolean(frame && (reuse || frame.id !== from?.keyframe));
    if (from) content.append(element("p", "退回原因 · " + from.note, "context"));
    if (type === "video" && from) {
      const modes = element("div", "", "actions");
      const same = button("沿用已确认的关键帧", () => preparation(shot, type, from, true));
      const revised = button("使用修改后的关键帧", () => preparation(shot, type, from, false));
      same.setAttribute("aria-pressed", String(reuse));
      revised.setAttribute("aria-pressed", String(!reuse));
      modes.append(same, revised);
      content.append(modes);
      if (!reuse) {
        content.append(element("p", "先导入或生成修改后的图片，通过审核并确认它为关键帧，然后回来重做视频。", "context"),
          button("生成修改后的关键帧", () => preparation(shot, "image", from)));
      }
    }
    if (type === "video") content.append(element("p", "将使用关键帧 · " + (videoReady ? frame.title : "暂未确认"), "context"));
    if (!references.length) content.append(element("p", "已绑定的角色参考会随提示词列出。有人物入镜时，请先绑定角色参考。", "context"));
    const form = element("form", "", "production-form");
    const [label, prompt] = field("生成或返工提示", "textarea", { rows: 4, maxLength: 1400,
      value: from?.note || shot.context });
    form.append(label);
    if (context().capabilities.generation) {
      const submit = element("button", "提交站内生成", "pick");
      submit.type = "submit";
      submit.disabled = !references.length || !videoReady;
      prompt.required = true;
      form.append(submit, element("p", "提交会把此镜头的素材和提示发送给 fal，按你的服务账户计费。", "context"));
      form.onsubmit = (event) => {
        event.preventDefault();
        run({ kind: "submit", type, shot: shot.id, from: from?.id, prompt: prompt.value, reuse },
          null, "/api/generation", () => showJobs(shot));
      };
    } else {
      form.onsubmit = (event) => event.preventDefault();
    }
    content.append(form, externalPrompt({ shot, type, from, frame, references, reuse, instruction: prompt, videoReady }));
  }

  function showJobs(shot) {
    open("单镜头生成任务");
    const jobs = config().jobs.filter((job) => job.shot === shot.id).slice(-12).reverse();
    if (!jobs.length) content.append(element("p", "此镜头暂无生成任务。", "context"));
    for (const job of jobs) {
      const card = element("article", "", "production-card");
      card.append(element("h3", (job.type === "image" ? "关键帧" : "视频") + " · " + jobLabels[job.status]));
      if (job.message) card.append(element("p", job.message, "context"));
      if (job.requestId) card.append(element("p", "服务任务 ID · " + job.requestId, "context"));
      if (writable() && ["queued", "running"].includes(job.status)) {
        card.append(button("查询并同步结果", () => run({ kind: "poll", job: job.id }, null, "/api/generation", () => showJobs(shot))));
      }
      content.append(card);
    }
  }

  function issueForm(version) {
    open("标记角色一致性问题");
    const refs = bindings(version.shot);
    if (!refs.length) {
      content.append(element("p", "请先在该镜头绑定已确认角色。", "context"));
      return;
    }
    const form = element("form", "", "production-form");
    const [whoLabel, who] = select("角色", refs.map(({ reference }) => [reference, findRef(reference)?.name ?? "角色"]));
    const [featureLabel, feature] = select("检查项", features.map((item) => [item, item]));
    const [timeLabel, time] = field("问题帧时间（秒）", "input", { type: "number", min: 0, max: 300, step: 0.01, required: true, value: "0" });
    const [noteLabel, note] = field("具体差异", "textarea", { maxLength: 400, required: true, rows: 3 });
    const save = element("button", "保存问题", "pick");
    save.type = "submit";
    form.append(whoLabel, featureLabel);
    if (version.type === "video") form.append(timeLabel);
    form.append(noteLabel, save);
    form.onsubmit = (event) => {
      event.preventDefault();
      run({ kind: "addIssue", shot: version.shot, version: version.id, reference: who.value,
        feature: feature.value, time: Number(time.value), note: note.value }, null, "/api/production", () => dialog.close());
    };
    content.append(form);
  }

  function compare(version, issue) {
    open("角色参考与问题帧");
    const ref = findRef(issue.reference);
    if (!ref) return;
    const pair = element("div", "", "issue-compare");
    const left = element("figure");
    left.append(image(ref.images[issue.angle].file, ref.name + "参考图"),
      element("figcaption", ref.name + " · 已确认参考 · " + angles[issue.angle]));
    const right = element("figure");
    const frame = version.type === "image" ? image(version.file, "问题关键帧") : element("video");
    if (version.type === "video") {
      frame.controls = true;
      frame.playsInline = true;
      frame.preload = "auto";
      frame.onloadedmetadata = () => { frame.currentTime = Math.min(issue.time, Math.max(0, frame.duration - 0.01)); };
      frame.src = version.file;
    }
    right.append(frame, element("figcaption", version.type === "image" ? "问题关键帧" : issue.time + " 秒 · 问题帧"));
    pair.append(left, right);
    content.append(element("p", issue.feature + " · " + issue.note, "context"), pair);
  }

  function inspect(version) {
    open("检查角色一致性");
    content.append(element("p", "将已确认角色参考与待检帧发送给 OpenAI。视频抽检 5 帧，结果由创作者复核。", "context"));
    const start = button("开始一致性检查", async () => {
      if (start.disabled) return;
      start.disabled = true;
      $("production-close").disabled = true;
      message("正在读取素材并抽帧…");
      try {
        const frames = await sampledFrames(version);
        message("正在比较角色参考和问题帧…");
        await run({ version: version.id, frames }, null, "/api/vision", () => dialog.close());
      } catch (error) {
        message(error.message, true);
      } finally {
        start.disabled = false;
        $("production-close").disabled = false;
      }
    }, "pick");
    content.append(start);
  }

  function renderShot(shot, ready) {
    $("project-references").hidden = !ready;
    $("shot-production").hidden = !shot;
    if (!shot) return;
    const line = $("shot-production-summary");
    const names = bindings(shot.id).map(({ reference, angle }) => {
      const ref = findRef(reference);
      return ref?.name + " 第 " + ref?.edition + " 版（" + angles[angle] + "）";
    }).join("、");
    const keyframe = findVersion(config().shots[shot.id]?.keyframe);
    line.textContent = "角色参考 · " + (names || "未绑定") + "　关键帧 · " + (keyframe?.status === "approved" ? keyframe.title : "未确认");
    const items = [button("查看生成任务", () => showJobs(shot))];
    if (writable()) items.unshift(button("绑定角色参考", () => assign(shot)),
      button("生成关键帧", () => preparation(shot, "image")), button("生成视频", () => preparation(shot, "video")));
    $("shot-production-actions").replaceChildren(...items);
    const pending = config().jobs.filter((job) => job.shot === shot.id && ["queued", "running", "unknown", "submitting"].includes(job.status));
    if (pending.length) line.textContent += "　任务 · " + jobLabels[pending.at(-1).status];
  }

  function versionTools(version, shot) {
    const section = element("div", "", "version-production");
    const actions = element("div", "", "actions");
    const from = findVersion(version.replaces);
    if (from) section.append(element("p", "返工自 · " + from.title, "context"));
    const keyframe = findVersion(version.keyframe);
    if (keyframe) section.append(element("p", "生成用关键帧 · " + keyframe.title, "context"));
    if (writable()) {
      if (version.type === "image" && version.status === "approved") {
        const isLocked = config().shots[shot.id]?.keyframe === version.id;
        const lock = button(isLocked ? "已确认关键帧" : "确认为关键帧", () => commit({ kind: "lockFrame", shot: shot.id, version: version.id }, null, "/api/production"));
        lock.disabled = isLocked;
        actions.append(lock);
      }
      if (bindings(shot.id).length) {
        actions.append(button("标记问题", () => issueForm(version)));
        if (context().capabilities.vision) actions.append(button("一致性检查", () => inspect(version)));
      }
      if (version.status === "rejected") actions.append(button("发起返工", () => preparation(shot, version.type, version), "pick"));
    }
    section.append(actions);
    if (version.checkedAt) {
      const flagged = (version.issues ?? []).some(({ source }) => source === "vision");
      section.append(element("p", "AI 已抽检 " + version.checkedFrames + " 帧。" +
        (flagged ? "请复核下方提示。" : "抽检未发现明显偏差，请按需人工复核。"), "context"));
    }
    for (const issue of version.issues ?? []) {
      const ref = findRef(issue.reference);
      const label = (ref?.name ?? "角色") + " · " + (version.type === "video" ? issue.time + " 秒" : "关键帧") +
        " · " + issue.feature + (issue.source === "vision" ? " · AI 提示" : " · 人工");
      const details = element("div", "", "issue-summary");
      details.append(button(label, () => compare(version, issue)), element("p", issue.note, "context"));
      section.append(details);
    }
    return section;
  }
  $("project-references").onclick = showReferences;
  $("production-close").onclick = () => { if (!working) dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (working || $("production-close").disabled) event.preventDefault(); });
  dialog.addEventListener("close", () => { content.replaceChildren(); message(); });
  return { renderShot, versionTools };
}
