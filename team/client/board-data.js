export const boardColumns = [
  { key: "number", title: "镜头编号", limit: 24 },
  { key: "characters", title: "出场角色", limit: 120 },
  { key: "scene", title: "场景", limit: 120 },
  { key: "framing", title: "景别与角度", limit: 120 },
  { key: "action", title: "动作", limit: 600 },
  { key: "duration", title: "目标时长", limit: 12 },
  { key: "dialogue", title: "对白", limit: 300, optional: true },
  { key: "costume", title: "服装版本", limit: 120, optional: true },
];
export const boardLimit = 60;
export const storyLimit = 20000;

export function normalizeBoard(input, confirm = false) {
  if (!Array.isArray(input) || input.length > boardLimit) throw new Error("每张分镜表最多 " + boardLimit + " 行。");
  if (confirm && !input.length) throw new Error("请至少填写一个镜头。");
  const numbers = new Set();
  return input.map((row, index) => {
    const line = "分镜第 " + (index + 1) + " 行";
    const clean = normalizeTextRow(row, boardColumns, line, confirm);
    if (!confirm) return clean;
    const numberKey = clean.number.normalize("NFKC").toLowerCase().replace(/^0+(?=\d+$)/, "");
    if (numbers.has(numberKey)) throw new Error(line + "的镜头编号「" + clean.number + "」重复。");
    numbers.add(numberKey);
    const seconds = clean.duration.normalize("NFKC").replace(/\s*秒$/, "");
    if (!/^\d+$/.test(seconds) || Number(seconds) < 1 || Number(seconds) > 300) {
      throw new Error(line + "的目标时长须为 1–300 秒的整数。");
    }
    clean.duration = Number(seconds);
    return clean;
  });
}

const headerKeys = new Map(boardColumns.map(({ key, title }) => [title, key]));
headerKeys.set("目标时长（秒）", "duration");
headerKeys.set("目标时长(秒)", "duration");
headerKeys.set("景别和角度", "framing");

function readDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    closedQuote = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closedQuote = true; }
    } else if (char === delimiter) endCell();
    else if (char === "\n") endRow();
    else if (closedQuote) {
      if (char !== " ") throw new Error("带引号的单元格后应接分隔符或换行。");
    } else if (char === '"' && !cell) quoted = true;
    else cell += char;
  }
  if (quoted) throw new Error("有一个带引号的单元格没有闭合。");
  endRow();
  return rows;
}

function normalizeTextRow(row, columns, line, confirm) {
  const clean = {};
  for (const { key, title, limit, optional } of columns) {
    const supplied = row?.[key];
    const value = key === "duration" && typeof supplied === "number" ? String(supplied) : supplied;
    if (value != null && typeof value !== "string") throw new Error(line + "的「" + title + "」格式无效。");
    clean[key] = (value ?? "").trim();
    if (clean[key].length > limit) throw new Error(line + "的「" + title + "」最多 " + limit + " 个字符。");
    if (confirm && !optional && !clean[key]) throw new Error(line + "缺少「" + title + "」。");
  }
  return clean;
}

function parseDelimitedTable(input, columns, headers, label) {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const text = normalized.match(/^\s*```(?:tsv|csv|text)?[ \t]*\n([\s\S]+?)\n```\s*$/i)?.[1] ?? normalized;
  if (!text.trim()) throw new Error("请粘贴带表头的" + label + "。");
  const firstLine = text.split("\n").find((line) => line.trim());
  const separator = firstLine.includes("\t") ? "\t" : ",";
  const [header, ...rows] = readDelimited(text, separator);
  if (!header || !rows.length) throw new Error("表头下至少需要一行" + label + "。");
  const names = header.map((value) => value.trim());
  const keys = names.map((name) => headers.get(name));
  if (keys.some((key, i) => names[i] && !key)) throw new Error("表头包含无法识别的列，请核对字段名称。");
  const known = keys.filter(Boolean);
  if (new Set(known).size !== known.length) throw new Error("表格有重复的列。");
  const missing = columns.filter(({ key, optional }) => !optional && !keys.includes(key));
  if (missing.length) throw new Error("表头缺少：" + missing.map(({ title }) => title).join("、") + "。");
  return rows.map((cells, index) => {
    if (cells.some((value, i) => !keys[i] && value.trim())) throw new Error(label + "第 " + (index + 1) + " 行有未对应表头的内容。");
    return Object.fromEntries(keys.flatMap((key, i) => key ? [[key, cells[i] ?? ""]] : []));
  });
}

export function parseBoard(input) {
  return normalizeBoard(parseDelimitedTable(input, boardColumns, headerKeys, "分镜"));
}

export const scriptColumns = [
  { key: "scene", title: "场景", limit: 120 },
  { key: "characters", title: "出场角色", limit: 120 },
  { key: "action", title: "动作", limit: 900 },
  { key: "dialogue", title: "对白", limit: 600, optional: true },
  { key: "beat", title: "剧情推进", limit: 400 },
];
export const scriptLimit = 30;
const scriptHeaders = new Map(scriptColumns.map(({ key, title }) => [title, key]));

export function normalizeScript(input, confirm = false) {
  if (!Array.isArray(input) || input.length > scriptLimit) throw new Error("每份剧本最多 " + scriptLimit + " 场。");
  if (confirm && !input.length) throw new Error("请至少填写一场戏。");
  return input.map((row, index) => normalizeTextRow(row, scriptColumns, "剧本第 " + (index + 1) + " 场", confirm));
}

export function parseScript(input) {
  return normalizeScript(parseDelimitedTable(input, scriptColumns, scriptHeaders, "剧本"));
}

export function scriptPrompt(story) {
  if (!story?.trim()) throw new Error("请先保存故事原文。");
  return [
    "把下面的故事改编成短篇竖屏漫剧剧本。按场景组织，每场一行。保留原著角色、主要事件和先后关系。",
    "动作写成观众能看到的行为。对白写成「角色名：台词」，原文不需要对白时留空。剧情推进写出这场戏发生的变化。",
    "只输出制表符分隔的 TSV 表格，实际用 Tab 分列，每行保持五列。保留以下首行，单元格内用空格代替换行，不加 Markdown 表格或说明。",
    scriptColumns.map(({ title }) => title).join("\t"),
    "<故事原文>\n" + story + "\n</故事原文>",
  ].join("\n\n");
}

export function storyboardPrompt(scenes, { count, seconds } = {}) {
  if (!scenes?.length) throw new Error("请先确认剧本。");
  const script = scenes.map((scene, index) => "第 " + (index + 1) + " 场\n" +
    scriptColumns.map(({ key, title }) => title + "：" + (scene[key] || "无")).join("\n")).join("\n\n");
  const target = [count && "正好 " + count + " 个镜头", seconds && "总时长 " + seconds + " 秒"].filter(Boolean).join("，");
  return [
    "把这份已确认的剧本拆成 9:16 竖屏漫剧分镜。每镜头一行，按播放顺序排列。" +
      (target ? "目标为" + target + "。" : ""),
    "保留角色名称、场景和事件顺序。镜头编号唯一，空镜在出场角色填「无人」。动作写成可拍摄的画面，避免擅自修改角色服装和标志性细节。左右指角色本人。目标时长填 1–300 的整数秒。对白和服装版本可为空。",
    "只输出制表符分隔的 TSV 表格。实际用 Tab 分列，每行保持八列。保留以下首行，单元格内用空格代替换行，不加 Markdown 表格或说明。",
    boardColumns.map(({ title }) => title).join("\t"),
    "<已确认剧本>\n" + script + "\n</已确认剧本>",
  ].join("\n\n");
}

export function clipFromBoardRow(row, id) {
  const action = row.action.replace(/\s+/g, " ");
  const title = action.slice(0, 100);
  const context = [
    "分镜编号 · " + row.number,
    "场景 · " + row.scene,
    "角色 · " + row.characters,
    "景别与角度 · " + row.framing,
    "动作 · " + row.action,
    row.dialogue && "对白 · " + row.dialogue,
    "服装 · " + (row.costume || "沿用已确认角色参考的服装"),
  ].filter(Boolean).join("\n");
  return { id, title, context, duration: row.duration, storyboard: row };
}

export const boardSample = [
  boardColumns.map(({ title }) => title),
  ["01", "许棠、林澈", "雨夜公交站棚", "双人中景，平视", "两人在站棚下等车，交代站位和雨夜环境。", "4", "", ""],
  ["02", "林澈", "雨夜公交站棚", "正面近景", "林澈望向道路，露出本人左眉尾的浅疤。", "4", "", ""],
  ["03", "许棠", "雨夜公交站棚", "右侧面近景", "许棠低头看手中的折叠伞，露出本人右侧的黄色发夹。", "4", "", "米白连帽雨衣"],
  ["04", "许棠、林澈", "雨夜公交站棚", "双人中景，平视", "许棠在身前撑开绿伞，伞沿短暂遮挡两人，随后两人共伞。", "5", "", ""],
].map((row) => row.join("\t")).join("\n");
