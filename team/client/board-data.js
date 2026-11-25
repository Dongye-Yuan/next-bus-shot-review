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
    const clean = {};
    for (const { key, title, limit, optional } of boardColumns) {
      const supplied = row?.[key];
      const value = key === "duration" && typeof supplied === "number" ? String(supplied) : supplied;
      if (value != null && typeof value !== "string") throw new Error(line + "的「" + title + "」格式无效。");
      clean[key] = (value ?? "").trim();
      if (clean[key].length > limit) throw new Error(line + "的「" + title + "」最多 " + limit + " 个字符。");
      if (confirm && !optional && !clean[key]) throw new Error(line + "缺少「" + title + "」。");
    }
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

export function parseBoard(input) {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new Error("请粘贴包含表头和分镜的表格。");
  const firstLine = text.split("\n").find((line) => line.trim());
  const separator = firstLine.includes("\t") ? "\t" : ",";
  const [header, ...rows] = readDelimited(text, separator);
  if (!header || !rows.length) throw new Error("表头下至少需要一行分镜。");
  const names = header.map((value) => value.trim());
  const keys = names.map((name) => headerKeys.get(name));
  if (keys.some((key, i) => names[i] && !key)) throw new Error("表头包含无法识别的列。请按四镜头样表填写。");
  if (new Set(keys.filter(Boolean)).size !== keys.filter(Boolean).length) throw new Error("分镜表里有重复的列。");
  const missing = boardColumns.filter(({ key, optional }) => !optional && !keys.includes(key));
  if (missing.length) throw new Error("表头缺少：" + missing.map(({ title }) => title).join("、") + "。");
  return normalizeBoard(rows.map((cells, index) => {
    if (cells.some((value, i) => !keys[i] && value.trim())) throw new Error("分镜第 " + (index + 1) + " 行有未对应表头的内容。");
    return Object.fromEntries(keys.flatMap((key, i) => key ? [[key, cells[i] ?? ""]] : []));
  }));
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
