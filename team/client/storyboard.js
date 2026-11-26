import {
  boardColumns, boardLimit, boardSample, storyLimit, normalizeBoard, parseBoard,
  scriptColumns, scriptLimit, normalizeScript, parseScript, scriptPrompt, storyboardPrompt, draftScript, draftBoard,
} from "./board-data.js";

export function setupStoryboard({ $, element, button, context, commit, modelDraft, jumpToShot }) {
  const dialog = $("storyboard-dialog");
  const message = $("storyboard-message");
  const story = $("story-text");
  const paste = $("board-paste");
  const table = $("board-rows");
  const actions = $("board-actions");
  let rows = [];
  let scenes = [];
  let scriptDirty = false;
  let saving = false;
  const writeable = () => context().role !== "viewer";
  const viewOnly = () => !writeable() || Boolean(context().state.storyboard?.confirmedAt);

  function feedback(text = "", error = false) {
    message.textContent = text;
    message.classList.toggle("error", error);
    message.hidden = !text;
  }
  function selectPanel(target) {
    for (const name of ["story", "script", "board"]) {
      $(name + "-panel").hidden = name !== target;
      $(name + "-tab").setAttribute("aria-pressed", String(name === target));
    }
    $("prompt-preview").hidden = true;
    for (const target of ["script", "board"]) clearReplacement(target);
    feedback();
  }
  function emptyRow(columns) {
    return Object.fromEntries(columns.map(({ key }) => [key, ""]));
  }

  function renderBoard() {
    const board = context().state.storyboard;
    const confirmed = Boolean(board?.confirmedAt);
    const locked = viewOnly();
    const existing = context().clips.length;
    for (const mode of ["local", "model"]) $("draft-board-" + mode).disabled = locked || !context().state.script?.confirmed?.scenes.length;
    $("draft-board-local").hidden = locked;
    $("draft-board-model").hidden = locked || !context().capabilities.textDraft;
    $("board-import").hidden = locked;
    actions.hidden = locked;
    $("board-metadata").textContent = confirmed
      ? "已确认 · 已创建 " + board.shotIds.length + " 个镜头"
      : locked ? (rows.length + " 行分镜草稿")
        : "确认后按表格顺序" + (existing ? "追加到已有的 " + existing + " 个镜头之后。" : "创建镜头。");
    $("board-empty").hidden = Boolean(rows.length);
    $("board-table-wrap").hidden = !rows.length;
    $("board-add-row").disabled = rows.length >= boardLimit;
    $("board-confirm").disabled = !rows.length;
    renderTable("board", boardColumns, rows, "行", locked, renderBoard, confirmed ? (index) => {
      dialog.close();
      jumpToShot(board.shotIds[index]);
    } : null);
  }

  function renderScript() {
    const script = context().state.script;
    const confirmed = script?.confirmed;
    let status = "待整理";
    if (scriptDirty) status = "有未保存的修改";
    else if (script?.draft) status = "已保存草稿";
    else if (confirmed) status = "已确认 · " + confirmed.scenes.length + " 场戏";
    if (confirmed && (scriptDirty || script?.draft)) status += " · 分镜提示词仍使用上次确认稿";
    $("script-metadata").textContent = status;
    const hasStory = Boolean(context().state.story?.text?.trim());
    $("copy-script-prompt").disabled = !hasStory;
    $("script-prompt-hint").textContent = hasStory
      ? "规则起稿按原文段落整理。原文没有明确标注的场景和角色，请在表格补齐。"
      : "请先在「故事原文」中保存故事。";
    for (const mode of ["local", "model"]) $("draft-script-" + mode).disabled = !hasStory || !writeable();
    $("draft-script-local").hidden = !writeable();
    $("draft-script-model").hidden = !writeable() || !context().capabilities.textDraft;
    $("copy-board-prompt").disabled = !confirmed?.scenes.length;
    $("board-prompt-hint").textContent = confirmed
      ? "从最近确认的剧本起草分镜，目标总时长默认 60 秒。"
      : "先确认剧本，再生成分镜草稿。";
    $("script-import").hidden = !writeable();
    $("script-actions").hidden = !writeable();
    $("script-table-wrap").hidden = !scenes.length;
    $("script-empty").hidden = Boolean(scenes.length);
    $("script-add-row").disabled = scenes.length >= scriptLimit;
    $("script-confirm").disabled = !scenes.length;
    renderTable("script", scriptColumns, scenes, "场", !writeable(), editScriptRows);
  }

  function editScriptRows() {
    scriptDirty = true;
    renderScript();
  }

  function renderTable(name, columns, entries, unit, locked, redraw, openShot) {
    const title = ({ title, key, optional }) =>
      title + (key === "duration" ? "（秒）" : "") + (optional ? "（选填）" : "");
    const showControls = Boolean(openShot) || !locked;
    const heads = [element("th", unit), ...columns.map((column) => element("th", title(column)))];
    if (showControls) heads.push(element("th", "操作"));
    $(name + "-head").replaceChildren(...heads);
    $(name + "-rows").replaceChildren(...entries.map((row, index) => {
      const tr = element("tr");
      const indexCell = element("th", String(index + 1));
      indexCell.scope = "row";
      tr.append(indexCell);
      for (const { key, title: label, limit } of columns) {
        const td = element("td");
        if (locked) td.textContent = row[key] || "—";
        else {
          const input = element(["action", "dialogue", "beat"].includes(key) ? "textarea" : "input");
          input.setAttribute("aria-label", "第 " + (index + 1) + " " + unit + " " + label);
          input.maxLength = limit;
          input.value = row[key] ?? "";
          if (key === "duration") input.inputMode = "numeric";
          input.oninput = () => {
            row[key] = input.value;
            if (name === "script" && !scriptDirty) {
              scriptDirty = true;
              const confirmed = context().state.script?.confirmed;
              $("script-metadata").textContent = "有未保存的修改" +
                (confirmed ? " · 分镜提示词仍使用上次确认稿" : "");
            }
          };
          td.append(input);
        }
        tr.append(td);
      }
      if (showControls) {
        const td = element("td");
        if (openShot) td.append(button("打开镜头", () => openShot(index)));
        else td.append(rowActions(entries, index, unit, redraw));
        tr.append(td);
      }
      return tr;
    }));
  }

  function rowActions(entries, index, unit, redraw) {
    const group = element("div", "", "board-row-actions");
    const move = (direction) => {
      if (saving) return;
      [entries[index], entries[index + direction]] = [entries[index + direction], entries[index]];
      redraw();
    };
    const up = button("上移", () => move(-1));
    up.disabled = index === 0;
    const down = button("下移", () => move(1));
    down.disabled = index >= entries.length - 1;
    const remove = button("移除", () => {
      if (saving) return;
      entries.splice(index, 1);
      redraw();
    });
    for (const [node, label] of [[up, "上移"], [down, "下移"], [remove, "移除"]]) {
      node.setAttribute("aria-label", label + "第 " + (index + 1) + " " + unit);
      group.append(node);
    }
    return group;
  }

  async function copyPrompt(text) {
    const preview = $("prompt-preview");
    const input = $("prompt-text");
    input.value = text;
    preview.hidden = false;
    try {
      await navigator.clipboard.writeText(text);
      feedback("提示词已复制，可粘贴到你使用的 AI 工具。");
    } catch {
      input.focus();
      input.select();
      feedback("提示词已选中，可手动复制。");
    }
  }

  function promptNumber(id) {
    const input = $(id);
    if (!input.value) return undefined;
    if (!input.reportValidity()) throw new Error("请填写有效的镜头数和总时长。");
    return Number(input.value);
  }

  function clearReplacement(kind) {
    const box = $(kind + "-draft-confirm");
    box.hidden = true;
    box.replaceChildren();
  }

  function boardOptions() {
    return { count: promptNumber("prompt-shot-count"), seconds: promptNumber("prompt-seconds") };
  }

  function applyDraft(kind, result, model, options) {
    clearReplacement(kind);
    const source = model ? "文字模型" : "规则";
    if (kind === "script") {
      scenes = result;
      editScriptRows();
      const missing = scenes.filter(({ scene, characters }) => !scene || !characters).length;
      feedback(source + "已起草 " + scenes.length + " 场。"
        + (missing ? "有 " + missing + " 场需补齐场景或角色。" : "") + "可以修改后保存或确认。");
    } else {
      rows = result;
      renderBoard();
      const total = rows.reduce((sum, row) => sum + Number(row.duration), 0);
      feedback(source + "已起草 " + rows.length + " 镜，共 " + total + " 秒。"
        + (options.count && options.count !== rows.length ? "按现有动作分为 " + rows.length + " 镜，可手动增减。" : "")
        + "可以修改后保存或确认建镜。");
    }
  }

  function requestDraft(kind, model) {
    if (saving || !writeable() || (kind === "board" && viewOnly())) return;
    const existing = kind === "script" ? scenes.length : rows.length;
    clearReplacement(kind);
    if (!existing && !model) {
      generateDraft(kind, model);
      return;
    }
    const box = $(kind + "-draft-confirm");
    const details = [
      existing && "起稿成功后会替换当前编辑表格，确认前仍可编辑。",
      model && "会把本步骤的已保存原文或已确认剧本发送给文字服务。",
    ].filter(Boolean).join(" ");
    box.append(element("p", details, "context"), button("继续起稿", () => generateDraft(kind, model)),
      button("取消", () => clearReplacement(kind)));
    box.hidden = false;
  }

  async function generateDraft(kind, model) {
    if (saving || !writeable() || (kind === "board" && viewOnly())) return;
    try {
      const options = kind === "board" ? boardOptions() : undefined;
      clearReplacement(kind);
      if (!model) {
        const { story, script } = context().state;
        const result = kind === "script" ? draftScript(story?.text) : draftBoard(script?.confirmed?.scenes, options);
        applyDraft(kind, result, false, options);
        return;
      }
      saving = true;
      dialog.setAttribute("aria-busy", "true");
      $(kind + "-panel").inert = true;
      feedback("文字模型正在起草…");
      const data = await modelDraft(kind, options);
      applyDraft(kind, data.rows, true, options);
    } catch (error) {
      feedback(error.message, true);
    } finally {
      saving = false;
      $(kind + "-panel").inert = false;
      dialog.removeAttribute("aria-busy");
    }
  }

  function open() {
    story.value = context().state.story?.text ?? "";
    story.readOnly = !writeable();
    $("story-save").hidden = !writeable();
    rows = structuredClone(context().state.storyboard?.rows ?? []);
    const script = context().state.script;
    scriptDirty = false;
    scenes = structuredClone((writeable() ? (script?.draft ?? script?.confirmed) : (script?.confirmed ?? script?.draft))?.scenes ?? []);
    paste.value = "";
    $("script-paste").value = "";
    $("prompt-shot-count").value = "";
    $("prompt-seconds").value = "";
    renderScript();
    renderBoard();
    selectPanel("story");
    dialog.showModal();
  }

  async function persist(kind, data, success) {
    if (!writeable() || saving) return;
    for (const target of ["script", "board"]) clearReplacement(target);
    saving = true;
    dialog.setAttribute("aria-busy", "true");
    // Freeze field edits while the revision used for this save is in flight.
    for (const panel of ["story", "script", "board"]) $(panel + "-panel").inert = true;
    feedback("正在保存…");
    try {
      if (await commit({ kind, ...data }, null, "/api/storyboard", feedback)) {
        const { storyboard, script } = context().state;
        if (kind === "draft" || kind === "confirm") rows = structuredClone(storyboard.rows);
        if (kind === "saveScript" || kind === "confirmScript") {
          scenes = structuredClone((script.draft ?? script.confirmed).scenes);
          scriptDirty = false;
        }
        renderScript();
        renderBoard();
        feedback(success);
      } else {
        if (context().state.storyboard?.confirmedAt) rows = structuredClone(context().state.storyboard.rows);
        renderScript();
        renderBoard();
      }
    } finally {
      saving = false;
      dialog.removeAttribute("aria-busy");
      for (const panel of ["story", "script", "board"]) $(panel + "-panel").inert = false;
    }
  }

  $("story-text").maxLength = storyLimit;
  $("open-storyboard").onclick = open;
  $("close-storyboard").onclick = () => { if (!saving) dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  $("story-tab").onclick = () => { if (!saving) selectPanel("story"); };
  $("script-tab").onclick = () => { if (!saving) selectPanel("script"); };
  $("board-tab").onclick = () => { if (!saving) selectPanel("board"); };
  $("story-save").onclick = () => persist("story", { story: story.value }, "故事原文已保存。");
  for (const kind of ["script", "board"]) {
    $("draft-" + kind + "-local").onclick = () => requestDraft(kind, false);
    $("draft-" + kind + "-model").onclick = () => requestDraft(kind, true);
  }
  $("copy-script-prompt").onclick = () => {
    try { copyPrompt(scriptPrompt(context().state.story?.text)); }
    catch (error) { feedback(error.message, true); }
  };
  $("copy-board-prompt").onclick = () => {
    try {
      copyPrompt(storyboardPrompt(context().state.script?.confirmed?.scenes, {
        count: promptNumber("prompt-shot-count"), seconds: promptNumber("prompt-seconds"),
      }));
    } catch (error) {
      feedback(error.message, true);
    }
  };
  $("close-prompt-preview").onclick = () => { $("prompt-preview").hidden = true; };
  $("parse-script").onclick = () => {
    if (!writeable() || saving) return;
    try {
      scenes = parseScript($("script-paste").value);
      editScriptRows();
      feedback("已解析 " + scenes.length + " 场戏，可以继续编辑。");
    } catch (error) {
      feedback(error.message, true);
    }
  };
  $("script-add-row").onclick = () => {
    if (!writeable() || saving || scenes.length >= scriptLimit) return;
    scenes.push(emptyRow(scriptColumns));
    editScriptRows();
    $("script-rows").lastElementChild.querySelector("input")?.focus();
  };
  $("script-save").onclick = () => persist("saveScript", { scenes }, "剧本草稿已保存。");
  $("script-confirm").onclick = () => {
    try {
      normalizeScript(scenes, true);
      persist("confirmScript", { scenes }, "剧本已确认，可以到分镜表起草分镜。");
    } catch (error) {
      feedback(error.message, true);
    }
  };
  $("load-board-sample").onclick = () => {
    paste.value = boardSample;
    paste.focus();
  };
  $("parse-board").onclick = () => {
    if (saving || viewOnly()) return;
    try {
      rows = parseBoard(paste.value);
      feedback("已解析 " + rows.length + " 行。检查后可保存草稿或确认建镜。");
      renderBoard();
    } catch (error) {
      feedback(error.message, true);
    }
  };
  $("board-add-row").onclick = () => {
    if (saving || viewOnly() || rows.length >= boardLimit) return;
    rows.push(emptyRow(boardColumns));
    renderBoard();
    table.lastElementChild.querySelector("input")?.focus();
  };
  $("board-save").onclick = () => persist("draft", { rows }, "分镜草稿已保存。");
  $("board-confirm").onclick = () => {
    if (saving || viewOnly()) return;
    try {
      normalizeBoard(rows, true);
      persist("confirm", { rows }, "已按分镜表顺序创建 " + rows.length + " 个镜头。");
    } catch (error) {
      feedback(error.message, true);
    }
  };
}
