import {
  boardColumns, boardLimit, boardSample, storyLimit, normalizeBoard, parseBoard,
  scriptColumns, scriptLimit, normalizeScript, parseScript, scriptPrompt, storyboardPrompt,
} from "./board-data.js";

export function setupStoryboard({ $, element, button, context, commit, jumpToShot }) {
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
    $("script-prompt-hint").hidden = hasStory;
    $("copy-board-prompt").disabled = !confirmed?.scenes.length;
    $("board-prompt-hint").textContent = confirmed
      ? "分镜提示词使用最近确认的剧本。"
      : "确认剧本后即可复制分镜提示词。";
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
      persist("confirmScript", { scenes }, "剧本已确认，可以到分镜表生成分镜提示词。");
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
