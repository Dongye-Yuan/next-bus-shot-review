import { boardColumns, boardLimit, boardSample, storyLimit, normalizeBoard, parseBoard } from "./board-data.js";

export function setupStoryboard({ $, element, button, context, commit, jumpToShot }) {
  const dialog = $("storyboard-dialog");
  const message = $("storyboard-message");
  const story = $("story-text");
  const paste = $("board-paste");
  const table = $("board-rows");
  const actions = $("board-actions");
  let rows = [];
  let saving = false;
  const writeable = () => context().role !== "viewer";
  const viewOnly = () => !writeable() || Boolean(context().state.storyboard?.confirmedAt);

  function feedback(text = "", error = false) {
    message.textContent = text;
    message.classList.toggle("error", error);
    message.hidden = !text;
  }
  function selectPanel(target) {
    const showStory = target === "story";
    $("story-panel").hidden = !showStory;
    $("board-panel").hidden = showStory;
    $("story-tab").setAttribute("aria-pressed", String(showStory));
    $("board-tab").setAttribute("aria-pressed", String(!showStory));
    feedback();
  }
  function emptyRow() {
    return Object.fromEntries(boardColumns.map(({ key }) => [key, ""]));
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
    $("board-head").replaceChildren(element("th", "行"),
      ...boardColumns.map(({ title, key, optional }) => element("th", title + (key === "duration" ? "（秒）" : "") + (optional ? "（选填）" : ""))),
      element("th", "操作"));
    table.replaceChildren(...rows.map((row, index) => {
      const tr = element("tr");
      const indexCell = element("th", String(index + 1));
      indexCell.scope = "row";
      tr.append(indexCell);
      for (const { key, title, limit } of boardColumns) {
        const td = element("td");
        if (locked) {
          td.textContent = row[key] || "—";
        } else {
          const input = element(key === "action" || key === "dialogue" ? "textarea" : "input");
          input.setAttribute("aria-label", "第 " + (index + 1) + " 行 " + title);
          input.maxLength = limit;
          input.value = row[key] ?? "";
          input.className = "board-cell-" + key;
          if (key === "duration") input.inputMode = "numeric";
          input.oninput = () => { row[key] = input.value; };
          td.append(input);
        }
        tr.append(td);
      }
      const controls = element("td");
      if (confirmed) {
        controls.append(button("打开镜头", () => {
          dialog.close();
          jumpToShot(board.shotIds[index]);
        }));
      } else if (!locked) {
        const group = element("div", "", "board-row-actions");
        const move = (direction) => {
          if (saving) return;
          [rows[index], rows[index + direction]] = [rows[index + direction], rows[index]];
          renderBoard();
        };
        const up = button("上移", () => move(-1));
        up.disabled = index === 0;
        up.setAttribute("aria-label", "上移第 " + (index + 1) + " 行");
        const down = button("下移", () => move(1));
        down.disabled = index >= rows.length - 1;
        down.setAttribute("aria-label", "下移第 " + (index + 1) + " 行");
        const remove = button("移除", () => {
          if (saving) return;
          rows.splice(index, 1);
          renderBoard();
        });
        remove.setAttribute("aria-label", "移除第 " + (index + 1) + " 行");
        group.append(up, down, remove);
        controls.append(group);
      }
      tr.append(controls);
      return tr;
    }));
  }

  function open() {
    story.value = context().state.story?.text ?? "";
    story.readOnly = !writeable();
    $("story-save").hidden = !writeable();
    rows = structuredClone(context().state.storyboard?.rows ?? []);
    paste.value = "";
    renderBoard();
    selectPanel("story");
    dialog.showModal();
  }

  async function persist(kind, data, success) {
    if (!writeable() || saving) return;
    saving = true;
    dialog.setAttribute("aria-busy", "true");
    // Freeze field edits while the revision used for this save is in flight.
    $("story-panel").inert = true;
    $("board-panel").inert = true;
    feedback("正在保存…");
    try {
      if (await commit({ kind, ...data }, null, "/api/storyboard", feedback)) {
        if (kind !== "story") rows = structuredClone(context().state.storyboard.rows);
        renderBoard();
        feedback(success);
      } else if (context().state.storyboard?.confirmedAt) {
        rows = structuredClone(context().state.storyboard.rows);
        renderBoard();
      }
    } finally {
      saving = false;
      dialog.removeAttribute("aria-busy");
      $("story-panel").inert = false;
      $("board-panel").inert = false;
    }
  }

  $("story-text").maxLength = storyLimit;
  $("open-storyboard").onclick = open;
  $("close-storyboard").onclick = () => { if (!saving) dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  $("story-tab").onclick = () => { if (!saving) selectPanel("story"); };
  $("board-tab").onclick = () => { if (!saving) selectPanel("board"); };
  $("story-save").onclick = () => persist("story", { story: story.value }, "故事原文已保存。");
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
    rows.push(emptyRow());
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
