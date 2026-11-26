import { castNames, settingDraft, settingFields, locationDescription, normalizeSettings, qualityCategories, qualityOutcomes, repairFindings, packageInputFormat, packageResultFormat } from "./board-data.js";
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

export function setupProduction({ $, element, button, context, commit, modelSettings, checkFile, jumpToShot }) {
  const dialog = $("production-dialog");
  const content = $("production-body");
  const notice = $("production-notice");
  let working = false;
  function message(text = "", error = false) {
    notice.textContent = text;
    notice.classList.toggle("error", error);
    notice.hidden = !text;
  }
  function open(title, wide = false) {
    message();
    dialog.classList.toggle("visual-board-dialog", wide);
    content.replaceChildren();
    const heading = $("production-title");
    heading.textContent = title;
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    heading.focus({ preventScroll: true });
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
  const scenes = () => config().scenes ?? [];
  const sceneFor = (shot) => scenes().find(({ id, confirmedAt }) => confirmedAt && id === config().shots[shot]?.scene);
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
    if (writable()) content.append(button("新增角色参考版本", () => newReference(), "pick"));
    const suggestions = [...new Set(confirmedRows().flatMap((row) => castNames(row.characters)))];
    const missing = suggestions.filter((name) => !config().references.some((ref) => ref.name === name));
    if (missing.length && writable()) {
      const candidates = element("div", "", "actions");
      for (const name of missing) candidates.append(button("设定角色 · " + name, () => newReference(name)));
      content.append(element("p", "来自已确认剧本和分镜的角色", "context"), candidates);
    }
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
  function newReference(suggestedName = "", settings = {}) {
    open("新增角色参考版本");
    const form = element("form", "", "production-form");
    const [nameLabel, name] = field("角色名", "input", { required: true, maxLength: 80, value: suggestedName });
    const [identityLabel, identity] = field("身份特征（脸型、发型、标志性特征）", "textarea", { required: true, maxLength: 600, rows: 3, value: settings.identity ?? "" });
    const [outfitLabel, outfit] = field("本版服装", "input", { required: true, maxLength: 300, value: settings.outfit ?? "" });
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

  let settingsEditor;

  function showSettings() {
    open("角色与场景设定草稿");
    const { project, state, capabilities } = context();
    const script = state.script?.confirmed;
    const saved = state.settingsDraft;
    const resetEditor = () => {
      settingsEditor = { project, scriptAt: saved?.scriptAt, draft: saved ? structuredClone(saved) : null,
        storedAt: saved?.updatedAt, dirty: false };
    };
    if (settingsEditor?.project !== project || (!settingsEditor.dirty && settingsEditor.storedAt !== saved?.updatedAt)) resetEditor();
    const editor = settingsEditor;
    const stale = editor.draft && editor.scriptAt !== script?.at;
    const conflicting = editor.dirty && editor.storedAt !== saved?.updatedAt;
    const referenceInputs = () => ({ previous: editor.draft, references: config().references, locations: scenes() });
    function useDraft(draft) {
      editor.draft = draft;
      editor.scriptAt = script.at;
      editor.dirty = true;
      showSettings();
      message("设定草稿已生成，可以继续编辑。");
    }
    if (script?.scenes.length && writable()) {
      const actions = element("div", "", "actions");
      actions.append(button(editor.draft ? "按已确认剧本更新条目" : "从已确认剧本起草", () => {
        try { useDraft(settingDraft(script.scenes, referenceInputs())); }
        catch (error) { message(error.message, true); }
      }, "pick"));
      if (capabilities.textDraft) {
        actions.append(button("用文字模型补写空白设定", () => {
          const confirmation = element("div", "", "actions");
          confirmation.append(element("p", "此操作会把已确认剧本发送给文字服务。已有设定保留。", "context"),
            button("发送并生成", async () => {
              if (working) return;
              working = true;
              content.inert = true;
              try {
                const { settings } = await modelSettings();
                const baseline = settingDraft(script.scenes, referenceInputs());
                for (const [group, fields] of Object.entries(settingFields)) {
                  const supplements = new Map(settings[group].map((row) => [row.name, row]));
                  for (const row of baseline[group]) {
                    for (const { key } of fields) {
                      if (!row[key]?.trim()) row[key] = supplements.get(row.name)?.[key] ?? "";
                    }
                  }
                }
                useDraft(baseline);
              } catch (error) {
                message(error.message, true);
              } finally {
                content.inert = false;
                working = false;
              }
            }), button("取消", () => confirmation.remove()));
          if (!actions.nextElementSibling?.classList.contains("settings-model-confirm")) {
            confirmation.classList.add("settings-model-confirm");
            actions.after(confirmation);
          }
        }));
      }
      content.append(actions);
    }
    if (!script?.scenes.length) content.append(element("p", "请先在「故事与分镜」里确认剧本。", "context"));
    else if (!editor.draft) content.append(element("p", "按剧本列出角色和场景，并带入同名的已确认参考。其他外观、服装和环境设定可手动填写。", "context"));
    if (!editor.draft) return;
    if (conflicting) {
      content.append(element("p", "团队已保存更新的设定。可以查看当前编辑内容，或重新载入已保存稿后继续修改。", "context"),
        button("放弃本次编辑并载入已保存稿", () => { resetEditor(); showSettings(); }));
    }
    if (stale) content.append(element("p", "剧本有新确认稿。更新条目时会保留同名设定，按新剧本移除已不出场的条目。", "context"));
    const form = element("form", "", "production-form");
    const fresh = script?.scenes.length && !stale ? settingDraft(script.scenes, referenceInputs()) : null;
    for (const [group, fields] of Object.entries(settingFields)) {
      form.append(element("h3", group === "characters" ? "角色" : "场景"));
      if (!editor.draft[group].length) form.append(element("p", "已确认剧本没有人物出场。", "context"));
      for (const row of editor.draft[group]) {
        const card = element("article", "", "production-card");
        card.append(element("h4", row.name));
        const sources = fresh?.[group].find(({ name }) => name === row.name)?.source ?? [];
        if (sources.length) {
          const evidence = element("details");
          evidence.append(element("summary", "查看剧本来源（" + sources.length + " 场）"));
          for (const { index, scene, action } of sources) {
            evidence.append(element("p", "第 " + (index + 1) + " 场 · " + scene + " · " + action, "context"));
          }
          card.append(evidence);
        }
        for (const { key, title, limit } of fields) {
          const [label, input] = field(row.name + " · " + title, "textarea", {
            rows: 2, maxLength: limit, readOnly: !writable() || Boolean(stale), value: row[key] ?? "",
          });
          input.oninput = () => {
            row[key] = input.value;
            editor.dirty = true;
          };
          card.append(label);
        }
        if (writable() && !stale) {
          card.append(button("用于新增" + (group === "characters" ? "角色" : "场景") + "参考", () =>
            group === "characters" ? newReference(row.name, row)
              : sceneForm({ name: row.name, description: locationDescription(row) })));
        }
        form.append(card);
      }
    }
    if (writable() && !stale && !conflicting) {
      const save = element("button", "保存设定草稿", "pick");
      save.type = "submit";
      form.append(save);
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (working) return;
        try {
          const settings = normalizeSettings(editor.draft, fresh);
          form.inert = true;
          await run({ kind: "saveSettingsDraft", settings, scriptAt: editor.scriptAt }, null, "/api/storyboard", () => {
            settingsEditor = null;
            showSettings();
          });
        } catch (error) {
          message(error.message, true);
        } finally {
          form.inert = false;
        }
      };
    }
    content.append(form);
  }

  function confirmedRows() {
    const { script, storyboard } = context().state;
    return [...(script?.confirmed?.scenes ?? []), ...(storyboard?.confirmedAt ? storyboard.rows : [])];
  }

  function showScenes() {
    open("项目场景参考");
    if (writable()) {
      content.append(button("新增场景参考版本", () => sceneForm(), "pick"));
      const candidates = new Map();
      for (const row of confirmedRows()) {
        if (!candidates.has(row.scene) && !scenes().some(({ name }) => name === row.scene)) {
          candidates.set(row.scene, row.action);
        }
      }
      if (candidates.size) {
        const links = element("div", "", "actions");
        for (const [name, action] of candidates) links.append(button("设定场景 · " + name, () => sceneForm({ name, action })));
        content.append(element("p", "来自已确认剧本和分镜的场景", "context"), links);
      }
    }
    if (!scenes().length) content.append(element("p", "用一张参考图和场景设定统一不同镜头中的地点、光线和道具。", "context"));
    for (const scene of [...scenes()].reverse()) {
      const card = element("article", "", "production-card");
      const figure = element("figure", "", "scene-reference-image");
      figure.append(image(scene.image.file, scene.name + " · 场景参考图"));
      card.append(element("h3", scene.name + " · 第 " + scene.edition + " 版 · " + (scene.confirmedAt ? "已确认" : "待确认")),
        element("p", scene.description, "context"), figure);
      if (writable()) {
        const actions = element("div", "", "actions");
        if (scene.confirmedAt) actions.append(button("从此版新增版本", () => sceneForm({ name: scene.name, description: scene.description })));
        else actions.append(button("编辑草稿", () => sceneForm(scene)), button("确认场景版本", () =>
          run({ kind: "confirmScene", scene: scene.id }, null, "/api/production", showScenes)));
        card.append(actions);
      }
      content.append(card);
    }
  }

  function sceneForm(initial = {}) {
    open(initial.id ? "编辑场景草稿" : "新增场景参考版本");
    const form = element("form", "", "production-form");
    const [nameLabel, name] = field("场景名称", "input", { required: true, maxLength: 80, value: initial.name ?? "" });
    const [descriptionLabel, description] = field("场景设定", "textarea", { required: true, maxLength: 800, rows: 4,
      value: initial.description ?? "", placeholder: "填写空间布局、光线、色调和需要保持的道具。" });
    if (initial.action) form.append(element("p", "原剧本或分镜 · " + initial.action, "context"));
    const [fileLabel, input] = field(initial.id ? "替换场景参考图（选填）" : "场景参考图（最大 3 MB）", "input",
      { type: "file", accept: imageTypes, required: !initial.id });
    const save = element("button", "保存草稿", "pick");
    save.type = "submit";
    form.append(nameLabel, descriptionLabel, fileLabel, save, button("返回场景参考库", showScenes));
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const file = input.files[0];
      const upload = new FormData();
      upload.set("name", name.value);
      upload.set("description", description.value);
      if (initial.id) upload.set("draft", initial.id);
      save.disabled = true;
      try {
        if (file) {
          if (file.size > 3 * 1024 * 1024) throw new Error("场景图最大 3 MB。");
          await checkFile(file, "image");
          upload.set("image", file);
        }
        await run(null, upload, "/api/scenes", showScenes);
      } catch (error) {
        message(error.message, true);
      } finally {
        save.disabled = false;
      }
    };
    content.append(form);
  }

  function assign(shot) {
    open("绑定角色与场景");
    const refs = config().references.filter(({ confirmedAt }) => confirmedAt);
    const availableScenes = scenes().filter(({ confirmedAt }) => confirmedAt);
    if (!refs.length) content.append(button("打开角色参考", showReferences));
    if (!availableScenes.length) content.append(button("打开场景参考", showScenes));
    const row = shot.storyboard;
    const saved = config().shots[shot.id] ?? {};
    const upper = (value) => value.trim().normalize("NFKC").toLowerCase();
    const latestNamed = (list, name) => list.filter((item) => upper(item.name) === upper(name))
      .sort((a, b) => b.edition - a.edition)[0];
    const recommendedRoles = row && [...new Set(castNames(row.characters))].map((name) => latestNamed(refs, name)).filter(Boolean);
    const recommendedScene = row && latestNamed(availableScenes, row.scene);
    if (row) content.append(element("p", "按分镜名称匹配已确认版本。检查下列建议，保存后生效。", "context"));
    const form = element("form", "", "production-form");
    const [sceneLabel, scene] = select("场景版本", [["", "未绑定"], ...availableScenes.map((item) =>
      [item.id, item.name + " · 第 " + item.edition + " 版"])]);
    scene.value = saved.scene !== undefined ? (saved.scene ?? "") : (recommendedScene?.id ?? "");
    form.append(sceneLabel);
    const slots = [0, 1, 2].map((index) => {
      const assigned = saved.references?.[index];
      const fields = element("div", "", "production-inline");
      const [roleLabel, role] = select("角色 " + (index + 1), [["", "未分配"], ...refs.map((ref) => [ref.id, ref.name + " · 第 " + ref.edition + " 版"])]);
      const [angleLabel, angle] = select("参考视角", Object.entries(angles));
      role.value = saved.references ? (assigned?.reference ?? "") : (recommendedRoles?.[index]?.id ?? "");
      const framing = row?.framing ?? "";
      angle.value = assigned?.angle ?? (/侧[面脸]/.test(framing) ? "side" : /全景|背影|背面|全身/.test(framing) ? "full" : "front");
      fields.append(roleLabel, angleLabel);
      form.append(fields);
      return { role, angle };
    });
    const save = element("button", "保存绑定", "pick");
    save.type = "submit";
    form.append(save);
    form.onsubmit = (event) => {
      event.preventDefault();
      const references = slots.filter(({ role }) => role.value).map(({ role, angle }) => ({ reference: role.value, angle: angle.value }));
      run({ kind: "bindReferences", shot: shot.id, references, scene: scene.value || null }, null, "/api/production", () => dialog.close());
    };
    content.append(form);
  }

  function attachment({ from, shot, type, frame, reuse, afterImport }) {
    open(from?.type === type ? "导入外部返工版本" : "导入外部生成版本");
    const video = type === "video";
    const form = element("form", "", "production-form");
    const [label, input] = field(video ? "新版 MP4" : "新版图片", "input", {
      type: "file", required: true, accept: video ? "video/mp4,.mp4" : imageTypes,
    });
    const origin = video && frame
      ? element("p", (from ? (reuse ? "沿用关键帧 · " : "更新后关键帧 · ") : "生成用关键帧 · ") + frame.title, "context") : null;
    const linkFrame = video && from?.type === type && frame;
    const [association, associate] = field("此视频使用了上述关键帧", "input", { type: "checkbox", checked: true });
    if (origin) form.append(origin);
    if (linkFrame) form.append(association);
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
        if (video && frame && (!linkFrame || associate.checked)) upload.set("keyframe", frame.id);
        await run(null, upload, "/api/upload", afterImport ?? (() => dialog.close()));
      } catch (error) {
        message(error.message, true);
      } finally {
        save.disabled = false;
      }
    };
    if (afterImport) content.append(button("返回关键帧版本", afterImport));
    if (from) content.append(element("p", "原版 · " + from.title + " · " + from.note, "context"));
    content.append(form);
  }

  function externalPrompt({ shot, type, from, frame, references, scene, reuse, instruction, videoReady }) {
    const box = element("section", "", "production-card external-prompt");
    const title = element("h3", "在外部工具生成");
    const tools = element("div", "", "actions");
    const [promptLabel, preview] = field("完整提示词", "textarea", { readOnly: true, rows: 10 });
    promptLabel.hidden = true;
    const copy = button("复制" + (type === "image" ? "关键帧" : "视频") + "提示词", async () => {
      try {
        const { text } = shotPrompt({ shot, type, from, frame, references, scene, directive: instruction.value });
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
      const { assets } = shotPrompt({ shot, type, from, frame, references, scene });
      if (assets.length) {
        const list = element("ul", "", "shot-prompt-assets");
        for (const { file, label, optional } of assets) {
          const item = element("li");
          const link = element("a", label);
          link.href = file;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          item.append(link);
          if (optional) item.append(element("small", "支持额外参考图时附加"));
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
    const scene = sceneFor(shot.id);
    const currentFrame = config().shots[shot.id]?.keyframe;
    const selected = findVersion(reuse ? (from?.keyframe ?? currentFrame) : currentFrame);
    const frame = selected?.status === "approved" && selected.type === "image" && selected.shot === shot.id ? selected : null;
    const videoReady = type !== "video" || Boolean(frame && (reuse || frame.id !== from?.keyframe));
    if (from) {
      content.append(element("p", "退回原因 · " + from.note, "context"));
      const findings = repairFindings(from);
      if (findings.length) {
        const list = element("ul");
        for (const finding of findings) list.append(element("li", finding));
        const card = element("section", "", "production-card");
        card.append(element("h3", "返工清单"), list);
        content.append(card);
      }
    }
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
    const needsRoles = castNames(shot.storyboard?.characters).length > 0;
    if (!references.length && needsRoles) content.append(element("p", "此分镜有人物入镜，请先绑定角色参考。", "context"));
    if (scene) content.append(element("p", "将使用场景 · " + scene.name + " 第 " + scene.edition + " 版", "context"));
    const form = element("form", "", "production-form");
    const [label, prompt] = field("生成或返工提示", "textarea", { rows: 4, maxLength: 1400,
      value: from?.repairPlan?.note || from?.note || shot.context });
    form.append(label);
    if (context().capabilities.generation) {
      const submit = element("button", "提交站内生成", "pick");
      submit.type = "submit";
      submit.disabled = (!references.length && (needsRoles || !scene)) || !videoReady;
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
    content.append(form, externalPrompt({ shot, type, from, frame, references, scene, reuse, instruction: prompt, videoReady }));
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

  function reviewMedia(version, time = 0) {
    if (version.type === "image") return image(version.file, "待复核关键帧");
    const node = element("video");
    node.controls = true;
    node.playsInline = true;
    node.preload = "metadata";
    node.onloadedmetadata = () => { node.currentTime = Math.min(time, Math.max(0, node.duration - 0.01)); };
    node.src = version.file;
    return node;
  }

  function qualityForm(version) {
    open("复核镜头质量");
    const form = element("form", "", "production-form");
    const [categoryLabel, category] = select("质量分类", Object.entries(qualityCategories));
    const [outcomeLabel, outcome] = select("复核结果", Object.entries(qualityOutcomes));
    outcome.value = "problem";
    const [roleLabel, reference] = select("对照角色（选填）", [["", "未选择"],
      ...bindings(version.shot).map(({ reference }) => [reference, findRef(reference)?.name ?? "角色"])]);
    const [timeLabel, time] = field("证据时间（秒，素材内）", "input",
      { type: "number", min: 0, max: 300, step: 0.01, value: "0", required: true });
    const [noteLabel, note] = field("观察记录", "textarea", { required: true, maxLength: 400, rows: 2 });
    const [fixLabel, fix] = field("修改要求", "textarea", { required: true, maxLength: 400, rows: 2 });
    const preview = reviewMedia(version);
    const figure = element("figure", "", "quality-evidence");
    figure.append(preview, element("figcaption", version.title));
    form.append(categoryLabel, outcomeLabel, roleLabel, figure);
    if (version.type === "video") {
      form.append(timeLabel, button("使用当前播放位置", () => {
        time.value = String(Math.floor(preview.currentTime * 100) / 100);
      }));
      time.onchange = () => {
        if (Number.isFinite(preview.duration)) preview.currentTime = Math.min(Number(time.value), preview.duration);
      };
    }
    const updateFields = () => {
      roleLabel.hidden = category.value !== "identity" || !bindings(version.shot).length;
      fixLabel.hidden = outcome.value !== "problem";
      fix.required = outcome.value === "problem";
    };
    category.onchange = updateFields;
    outcome.onchange = updateFields;
    updateFields();
    const save = element("button", "保存复核记录", "pick");
    save.type = "submit";
    form.append(noteLabel, fixLabel, save);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (version.type === "video" && Number.isFinite(preview.duration) && Number(time.value) > preview.duration) {
        message("证据时间超出素材时长。", true);
        return;
      }
      run({ kind: "saveQualityCheck", version: version.id, shot: version.shot, category: category.value,
        outcome: outcome.value, reference: roleLabel.hidden ? "" : reference.value, time: Number(time.value),
        note: note.value, fix: fix.required ? fix.value : "" }, null, "/api/production", () => dialog.close());
    };
    content.append(form);
  }

  function qualityDetail(version, check, shot) {
    open("镜头复核证据");
    const pair = element("div", "", "issue-compare");
    const ref = findRef(check.reference);
    if (ref?.images[check.angle]) {
      const fig = element("figure");
      fig.append(image(ref.images[check.angle].file, ref.name + "参考图"),
        element("figcaption", ref.name + " · 已确认参考 · " + angles[check.angle]));
      pair.append(fig);
    }
    const figure = element("figure", "", "quality-evidence");
    figure.append(reviewMedia(version, check.time), element("figcaption",
      version.title + " · " + (version.type === "video" ? check.time + " 秒" : "关键帧")));
    pair.append(figure);
    content.append(element("p", qualityCategories[check.category] + " · " + qualityOutcomes[check.outcome], "context"),
      element("p", check.note), pair);
    if (check.fix) content.append(element("p", "修改要求 · " + check.fix));
    if (writable() && check.outcome === "problem") {
      if (context().state.selected[version.shot] === version.id) {
        content.append(element("p", "此版本正在时间轴中使用，退回后会取消选用。", "context"));
      }
      content.append(button("按此问题退回并打开返工", () =>
        run({ kind: "review", version: version.id, status: "rejected", check: check.id }, null, "/api/review",
          () => preparation(shot, version.type, findVersion(version.id))), "reject"));
    }
  }

  function compare(version, issue, unclear = false) {
    open(unclear ? "角色参考与待复核帧" : "角色参考与问题帧");
    const ref = findRef(issue.reference);
    if (!ref) return;
    const pair = element("div", "", "issue-compare");
    const left = element("figure");
    left.append(image(ref.images[issue.angle].file, ref.name + "参考图"),
      element("figcaption", ref.name + " · 已确认参考 · " + angles[issue.angle]));
    const right = element("figure");
    const frameLabel = unclear ? "待复核" : "问题";
    const frame = version.type === "image" ? image(version.file, frameLabel + "关键帧") : element("video");
    if (version.type === "video") {
      frame.controls = true;
      frame.playsInline = true;
      frame.preload = "auto";
      frame.onloadedmetadata = () => { frame.currentTime = Math.min(issue.time, Math.max(0, frame.duration - 0.01)); };
      frame.src = version.file;
    }
    right.append(frame, element("figcaption", version.type === "image" ? frameLabel + "关键帧" : issue.time + " 秒 · " + frameLabel + "帧"));
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

  function checkPackage(version, shot) {
    open("导出检查包");
    const references = bindings(version.shot).map(({ reference, angle }) => ({ ref: findRef(reference), angle }))
      .filter(({ ref, angle }) => ref?.confirmedAt && ref.images[angle]);
    const target = { project: context().project, shot: version.shot, version: version.id };
    content.append(element("p", shot.title + " · " + version.title));
    content.append(element("p", "浏览器会打包" + (version.type === "video" ? "5 张抽帧及其时间点" : "当前关键帧") +
      "、已绑定的角色参考和设定。导出在本机完成。", "context"));
    const notebook = element("a", "下载 Colab 检查笔记本", "button");
    notebook.href = "/consistency-check.ipynb";
    notebook.download = "consistency-check.ipynb";
    const download = button("下载检查包 JSON", async () => {
      download.disabled = true;
      $("production-close").disabled = true;
      message("正在准备素材…");
      try {
        const frames = await sampledFrames(version);
        const roles = [];
        for (const { ref, angle } of references) {
          const [{ image }] = await sampledFrames({ type: "image", file: ref.images[angle].file });
          roles.push({ id: ref.id, name: ref.name, edition: ref.edition, angle, identity: ref.identity, outfit: ref.outfit, image });
        }
        const packet = { format: packageInputFormat, target, title: version.title, type: version.type, references: roles, frames };
        const url = URL.createObjectURL(new Blob([JSON.stringify(packet)], { type: "application/json" }));
        const link = element("a");
        link.href = url;
        link.download = "检查包-" + version.title.slice(0, 60).replace(/[<>:"/\\|?*]/g, "_") + ".json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message("检查包已下载。用笔记本检查后，在这个版本导入结果。");
      } catch (error) {
        message(error.message || "导出失败，请检查素材能否播放。", true);
      } finally {
        download.disabled = false;
        $("production-close").disabled = false;
      }
    }, "pick");
    download.disabled = !references.length;
    if (!references.length) content.append(element("p", "请先绑定已确认的角色参考。", "context"));
    const actions = element("div", "", "actions");
    actions.append(download, notebook);
    content.append(actions);
  }

  function importColab(version) {
    open("导入 Colab 检查结果");
    const form = element("form", "", "production-form");
    const [fileLabel, file] = field("Colab 导出的 JSON", "input", { type: "file", accept: ".json,application/json", required: true });
    const [sampleLabel, sample] = select("对应的 Colab 样片", [["", "请选择样片"]]);
    sample.required = true;
    const preview = element("p", "", "context");
    const save = element("button", "确认导入", "pick");
    save.type = "submit";
    save.disabled = true;
    let report;
    let packet;
    let samples = new Map();
    const target = "镜头 " + version.shot + " · " + version.title + " · 版本 ID " + version.id;
    content.append(element("p", target, "context"),
      element("p", "检查包报告会自动核对项目、镜头与版本。旧版验收报告需手动选择对应样片。", "context"));
    form.append(fileLabel, sampleLabel, preview, save);
    content.append(form);

    function selected() {
      const row = samples.get(sample.value);
      if (!row) return null;
      const time = version.type === "image" ? 0 : report.source_times_seconds?.[row.sample];
      return { ...row, time };
    }
    sample.onchange = () => {
      const row = selected();
      const validTime = row && Number.isFinite(row.time) && row.time >= 0 && row.time <= 300;
      save.disabled = !validTime;
      message();
      preview.textContent = !row ? "" : !validTime ? "视频样片缺少有效的原视频时间，无法导入。" :
        (row.error !== undefined ? "检查未完成 · " + row.error :
          row.issues.length ? row.issues.length + " 条 AI 提示" : "此样片未发现问题") +
        " · " + (version.type === "image" ? "关键帧" : row.time + " 秒") + " · " + row.model;
    };
    file.onchange = async () => {
      const local = file.files[0];
      report = null;
      packet = null;
      sampleLabel.hidden = false;
      sample.required = true;
      samples = new Map();
      sample.replaceChildren(new Option("请选择样片", ""));
      sample.onchange();
      if (!local) return;
      try {
        if (local.size > 128 * 1024) throw new Error("请选择不超过 128 KB 的检查结果 JSON。");
        const data = JSON.parse((await local.text()).replace(/^\uFEFF/, ""));
        if (file.files[0] !== local) return;
        if (data?.format === packageResultFormat) {
          const { target, findings, times } = data;
          if (target?.project !== context().project || target.shot !== version.shot || target.version !== version.id) {
            throw new Error("此报告不属于当前项目、镜头和素材版本。");
          }
          if (!Array.isArray(findings) || !Array.isArray(times) || times.length !== (version.type === "video" ? 5 : 1) ||
              times.some((time) => !Number.isFinite(time) || time < 0 || time > 300)) {
            throw new Error("检查包报告缺少有效的抽帧或结果。");
          }
          packet = data;
          sampleLabel.hidden = true;
          sample.required = false;
          save.disabled = false;
          preview.textContent = "已匹配此版本 · " + packageSummary(data);
          return;
        }
        const cases = new Map();
        for (const [group, label] of [["development", "调试组"], ["holdout", "验收组"]]) {
          const rows = data?.[group];
          if (!rows || typeof rows !== "object" || Array.isArray(rows)) continue;
          for (const [id, result] of Object.entries(rows)) {
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id) ||
                (!Array.isArray(result?.issues) && typeof result?.error !== "string")) continue;
            cases.set(group + ":" + id, { sample: id, group, label, model: result.reported_model ?? data.model,
              runAt: data.run_at_utc, issues: result.issues, error: result.error });
          }
        }
        if (!cases.size || typeof data.model !== "string" || !Number.isFinite(Date.parse(data.run_at_utc))) {
          throw new Error("找不到 Colab 报告的模型、运行时间或样片记录。");
        }
        report = data;
        samples = cases;
        for (const [key, row] of cases) sample.add(new Option(row.sample + " · " + row.label, key));
      } catch (error) {
        if (file.files[0] === local) message(error instanceof SyntaxError ? "无法读取 JSON，请选择 Colab 导出的检查结果。" : error.message, true);
      }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const row = selected();
      if (save.disabled || (!row && !packet)) return;
      save.disabled = true;
      file.disabled = true;
      sample.disabled = true;
      $("production-close").disabled = true;
      try {
        if (version.type === "video") {
          const video = element("video");
          video.preload = "metadata";
          await waitFor(video, "loadedmetadata", () => { video.src = version.file; });
          const inRange = packet ? packet.times.every((time) => time <= video.duration + 0.005) : row.time < video.duration;
          if (!Number.isFinite(video.duration) || !inRange) {
            throw new Error("问题帧时间超出此视频时长，请核对样片与素材版本。");
          }
        }
        if (packet) {
          await run({ kind: "importPackageCheck", shot: version.shot, version: version.id, report: packet },
            null, "/api/production", () => dialog.close());
        } else {
          const { label, ...data } = row;
          await run({ kind: "importColabCheck", shot: version.shot, version: version.id, ...data },
            null, "/api/production", () => dialog.close());
        }
      } catch (error) {
        message(error.message, true);
      } finally {
        file.disabled = false;
        sample.disabled = false;
        save.disabled = false;
        $("production-close").disabled = false;
      }
    };
  }

  function lockedFrame(shot) {
    const version = findVersion(config().shots[shot.id]?.keyframe);
    return version?.shot === shot.id && version.type === "image" && version.status === "approved" ? version : null;
  }

  function boardReferences(shot) {
    const row = shot.storyboard;
    const group = element("div", "", "board-references");
    const roles = bindings(shot.id).map(({ reference, angle }) => ({ ref: findRef(reference), angle }))
      .filter(({ ref }) => ref?.confirmedAt);
    for (const { ref, angle } of roles) {
      const figure = element("figure");
      figure.append(image(ref.images[angle].file, ref.name + "参考图"),
        element("figcaption", ref.name + " · 第 " + ref.edition + " 版 · " + angles[angle]));
      group.append(figure);
    }
    const scene = sceneFor(shot.id);
    if (scene) {
      const figure = element("figure");
      figure.append(image(scene.image.file, scene.name + "场景参考"),
        element("figcaption", scene.name + " · 第 " + scene.edition + " 版"));
      group.append(figure);
    }
    const missing = row ? castNames(row.characters).filter((name) =>
      !roles.some(({ ref }) => ref.name.normalize("NFKC").toLowerCase() === name.normalize("NFKC").toLowerCase())) : [];
    const summary = [
      row && !roles.length && !castNames(row.characters).length ? "空镜 · 无出场角色" : "",
      missing.length ? "未绑定角色 · " + missing.join("、") : "",
      !row && !roles.length ? "未绑定角色参考" : "",
      !scene ? "未绑定场景参考" : "",
    ].filter(Boolean);
    const section = element("section", "", "board-card-section");
    section.append(element("h4", "已绑定参考"));
    if (group.childElementCount) section.append(group);
    if (summary.length) section.append(element("p", summary.join("　"), "context"));
    return section;
  }

  function packageSummary({ times, findings }) {
    const problems = findings.filter((row) => row?.outcome === "problem").length;
    const pending = findings.filter((row) => row?.outcome === "unclear").length;
    const result = [problems && problems + " 条疑似偏差", pending && pending + " 条无法判断"].filter(Boolean);
    return "抽检 " + times.length + " 帧 · " + (result.length ? result.join(" · ") : "未见明显偏差");
  }

  function packageFinding(version, finding, container) {
    const pending = finding.outcome === "unclear";
    const time = version.type === "video" ? finding.time + " 秒" : "关键帧";
    const role = findRef(finding.reference)?.name ?? "角色";
    container.append(button(role + " · " + time + " · " + finding.feature + " · " +
      (pending ? "无法判断" : "疑似偏差") + "（检查包）", () => compare(version, finding, pending)),
      element("p", finding.note, "context"));
    return container;
  }

  function unclearLabel(version, finding) {
    const location = version.type === "video" ? finding.time + " 秒" : "关键帧";
    return (findRef(finding.reference)?.name ?? "角色") + " · " + location + " · " + finding.feature + " · AI 无法判断";
  }

  function boardFindings(shot, versions) {
    const section = element("section", "", "board-card-section");
    const findings = element("ul", "", "board-findings");
    for (const version of new Set(versions.filter(Boolean))) {
      const location = (time) => version.type === "video" ? " · " + time + " 秒" : "";
      for (const check of version.qualityChecks ?? []) {
        if (check.outcome === "pass") continue;
        const item = element("li");
        item.append(button(qualityCategories[check.category] + " · " + qualityOutcomes[check.outcome] + location(check.time),
          () => qualityDetail(version, check, shot)), element("p", check.note, "context"));
        findings.append(item);
      }
      for (const issue of version.issues ?? []) {
        const item = element("li");
        item.append(button((findRef(issue.reference)?.name ?? "角色") + " · " + issue.feature + location(issue.time),
          () => compare(version, issue)), element("p", issue.note, "context"));
        findings.append(item);
      }
      for (const finding of version.packageCheck?.findings ?? []) {
        findings.append(packageFinding(version, finding, element("li")));
      }
      for (const finding of version.visionUnclear ?? []) {
        const item = element("li");
        item.append(button(unclearLabel(version, finding), () => compare(version, finding, true)),
          element("p", finding.note, "context"));
        findings.append(item);
      }
    }
    section.append(element("h4", findings.childElementCount ? "问题与待复核提示 · " + findings.childElementCount : "问题与待复核提示"));
    section.append(findings.childElementCount ? findings : element("p", "当前素材暂无问题记录", "context"));
    return section;
  }

  function showVisualBoard() {
    open("可视化分镜板", true);
    const { clips, state } = context();
    if (!clips.length) {
      content.append(element("p", "项目还没有镜头。新增镜头或在「故事与分镜」应用已确认的分镜后，即可在这里查看。", "context"));
      return;
    }
    const grid = element("div", "", "visual-board-grid");
    let start = 0;
    for (const [index, shot] of clips.entries()) {
      const frame = lockedFrame(shot);
      const selected = findVersion(state.selected[shot.id]);
      const versions = state.versions.filter(({ shot: id }) => id === shot.id);
      const latest = versions.findLast(({ status }) => status === "pending");
      const still = frame ?? (selected?.type === "image" ? selected : null);
      const card = element("article", "", "visual-board-card");
      const row = shot.storyboard;
      const number = String(index + 1).padStart(2, "0");
      const time = String(Math.floor(start / 60)).padStart(2, "0") + ":" + String(start % 60).padStart(2, "0");
      start += shot.duration;
      card.append(element("p", "镜头 " + number + " · " + time + " · " + shot.duration + " 秒", "board-time"),
        element("h3", shot.title));
      const figure = element("figure", "", "board-media");
      if (still) figure.append(image(still.file, still.title));
      else if (selected?.type === "video") {
        const video = reviewMedia(selected);
        video.preload = selected.poster ? "none" : "metadata";
        if (selected.poster) video.poster = selected.poster;
        video.setAttribute("aria-label", "已选视频预览");
        figure.append(video);
      } else figure.append(element("div", "暂无画面", "board-placeholder"));
      figure.append(element("figcaption", frame ? "已确认关键帧 · " + frame.title : selected ? "已选素材 · 关键帧未确认" : "关键帧未确认"));
      card.append(figure);
      if (row) {
        card.append(element("p", [row.scene, row.framing].filter(Boolean).join(" · "), "context"));
        if (row.action !== shot.title) card.append(element("p", row.action, "board-action"));
        if (row.dialogue) card.append(element("p", "对白 · " + row.dialogue, "board-action"));
        if (row.costume) card.append(element("p", "服装 · " + row.costume, "context"));
      } else if (shot.context) card.append(element("p", shot.context, "board-action"));
      card.append(boardReferences(shot), boardFindings(shot, [frame, selected, latest]));
      const actions = element("div", "", "actions board-actions");
      const candidates = versions.filter(({ type, status }) => type === "image" && status === "pending").length;
      actions.append(button("查看审核", () => { dialog.close(); jumpToShot(shot.id); }),
        button("关键帧版本" + (candidates ? "（" + candidates + " 待审）" : ""), () => showBoardFrames(shot), "pick"));
      card.append(actions);
      grid.append(card);
    }
    content.append(grid);
  }

  function showBoardFrames(shot) {
    open("关键帧版本 · " + shot.title);
    const frame = lockedFrame(shot);
    const refresh = () => showBoardFrames(shot);
    const actions = element("div", "", "actions");
    actions.append(button("返回分镜板", showVisualBoard));
    if (writable()) {
      actions.append(button("导入关键帧候选", () => attachment({ shot, type: "image", afterImport: refresh }), "pick"),
        button("生成关键帧", () => preparation(shot, "image")));
      if (frame) actions.append(button("用当前关键帧生成视频", () => preparation(shot, "video")));
    }
    content.append(actions);
    const images = context().state.versions.filter(({ shot: id, type }) => id === shot.id && type === "image").reverse();
    if (!images.length) content.append(element("p", "此镜头还没有关键帧候选。", "context"));
    const status = { pending: "待审", approved: "可确认", rejected: "已退回" };
    const grid = element("div", "", "visual-board-grid");
    for (const version of images) {
      const current = frame?.id === version.id;
      const card = element("article", "", "visual-board-card");
      const figure = element("figure", "", "board-media");
      figure.append(image(version.file, version.title),
        element("figcaption", current ? "当前关键帧" : status[version.status]));
      card.append(element("h3", version.title), figure);
      const prior = findVersion(version.replaces);
      if (prior) card.append(element("p", "替换自 · " + prior.title, "context"));
      if (writable() && version.status === "pending") {
        card.append(button("通过初审", () =>
          run({ kind: "review", version: version.id, status: "approved", note: version.note ?? "" }, null, "/api/review", refresh)));
      } else if (writable() && version.status === "approved" && !current) {
        card.append(button("确认为关键帧", () =>
          run({ kind: "lockFrame", shot: shot.id, version: version.id }, null, "/api/production", refresh), "pick"));
      }
      grid.append(card);
    }
    content.append(grid);
  }

  function renderShot(shot, ready) {
    $("visual-board").hidden = !ready;
    $("project-references").hidden = !ready;
    $("project-scenes").hidden = !ready;
    $("project-settings").hidden = !ready;
    $("shot-production").hidden = !shot;
    if (!shot) return;
    const line = $("shot-production-summary");
    const names = bindings(shot.id).map(({ reference, angle }) => {
      const ref = findRef(reference);
      return ref?.name + " 第 " + ref?.edition + " 版（" + angles[angle] + "）";
    }).join("、");
    const keyframe = findVersion(config().shots[shot.id]?.keyframe);
    const scene = sceneFor(shot.id);
    line.textContent = "场景参考 · " + (scene ? scene.name + " 第 " + scene.edition + " 版" : "未绑定") + "　角色参考 · " + (names || "未绑定") + "　关键帧 · " + (keyframe?.status === "approved" ? keyframe.title : "未确认");
    const items = [button("查看生成任务", () => showJobs(shot))];
    if (writable()) items.unshift(button("绑定角色与场景", () => assign(shot)),
      button("生成关键帧", () => preparation(shot, "image")), button("生成视频", () => preparation(shot, "video")));
    $("shot-production-actions").replaceChildren(...items);
    const pending = config().jobs.filter((job) => job.shot === shot.id && ["queued", "running", "unknown", "submitting"].includes(job.status));
    if (pending.length) line.textContent += "　任务 · " + jobLabels[pending.at(-1).status];
  }

  function versionTools(version, shot) {
    const section = element("div", "", "version-production");
    const actions = element("div", "", "actions");
    const scene = scenes().find(({ id }) => id === version.scene);
    if (scene) section.append(element("p", "生成用场景 · " + scene.name + " 第 " + scene.edition + " 版", "context"));
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
      actions.append(button("复核镜头质量", () => qualityForm(version)));
      if (bindings(shot.id).length) {
        actions.append(button("标记问题", () => issueForm(version)));
        actions.append(button("导出检查包", () => checkPackage(version, shot)));
        if (context().capabilities.vision) actions.append(button("一致性检查", () => inspect(version)));
      }
      actions.append(button("导入 Colab 检查结果", () => importColab(version)));
      if (version.status === "rejected") actions.append(button("发起返工", () => preparation(shot, version.type, version), "pick"));
    }
    section.append(actions);
    if (version.checkedAt) {
      const flagged = (version.issues ?? []).some(({ source }) => source === "vision");
      const pending = version.visionUnclear?.length ?? 0;
      const result = flagged ? "发现疑似偏差，请复核下方提示。" : "已核对的可见特征未发现明显偏差。";
      const summary = !flagged && pending ? "" : result;
      section.append(element("p", "AI 已抽检 " + version.checkedFrames + " 帧。" + summary +
        (pending ? "有 " + pending + " 条无法判断，请人工复核。" : ""), "context"));
    }
    if (version.colabCheck) {
      const check = version.colabCheck;
      const flagged = (version.issues ?? []).some(({ source }) => source === "colab");
      const status = check.status === "failed" ? "检查未完成 · " + check.error + (flagged ? "。下方仍显示此前成功导入的提示。" : "") :
        flagged ? "请复核下方 AI 提示。" : "此样片未发现问题。";
      section.append(element("p", "Colab · " + check.sample + " · " + check.model + " · " + status, "context"));
    }
    for (const issue of version.issues ?? []) {
      const ref = findRef(issue.reference);
      const label = (ref?.name ?? "角色") + " · " + (version.type === "video" ? issue.time + " 秒" : "关键帧") +
        " · " + issue.feature +
        (issue.source === "colab" ? " · AI 提示（Colab）" : issue.source === "vision" ? " · AI 提示" : " · 人工");
      const details = element("div", "", "issue-summary");
      details.append(button(label, () => compare(version, issue)), element("p", issue.note, "context"));
      section.append(details);
    }
    for (const finding of version.visionUnclear ?? []) {
      const details = element("div", "", "issue-summary");
      details.append(button(unclearLabel(version, finding), () => compare(version, finding, true)), element("p", finding.note, "context"));
      section.append(details);
    }
    if (version.packageCheck) {
      const check = version.packageCheck;
      section.append(element("p", "Colab 检查包 · " + check.model + " · " + packageSummary(check), "context"));
      for (const finding of check.findings) {
        section.append(packageFinding(version, finding, element("div", "", "issue-summary")));
      }
    }
    const checklist = version.repairPlan ?? version.repairOrigin;
    if (checklist?.checks.length) {
      const list = element("ul", "", "repair-summary");
      for (const item of checklist.checks) {
        const time = version.type === "video" ? item.time + " 秒 · " : "";
        list.append(element("li", time + qualityCategories[item.category] + " · " + item.fix));
      }
      section.append(element("p", version.repairPlan ? "返工清单" : "沿用原版返工清单", "context"), list);
    }
    for (const check of version.qualityChecks ?? []) {
      const location = version.type === "video" ? check.time + " 秒" : "关键帧";
      const details = element("div", "", "issue-summary");
      details.append(button(qualityCategories[check.category] + " · " + qualityOutcomes[check.outcome] + " · " + location,
        () => qualityDetail(version, check, shot)), element("p", check.note, "context"));
      section.append(details);
    }
    return section;
  }
  $("visual-board").onclick = showVisualBoard;
  $("project-references").onclick = showReferences;
  $("project-scenes").onclick = showScenes;
  $("project-settings").onclick = showSettings;
  $("production-close").onclick = () => { if (!working) dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (working || $("production-close").disabled) event.preventDefault(); });
  dialog.addEventListener("close", () => { content.replaceChildren(); message(); });
  return { renderShot, versionTools };
}
