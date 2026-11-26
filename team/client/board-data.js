export function castNames(value = "") {
  return value.split(/[、，,；;／/]/).map((name) => name.trim())
    .filter((name) => name && !/^(无|无人|空镜|无人物|无角色)$/.test(name));
}

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

const sentenceBoundary = /(?<=[。！？!?；;])(?=[^”’」』》])/u;

function splitAction(text, limit) {
  const sentences = text.split(sentenceBoundary).map((line) => line.trim()).filter(Boolean);
  const pieces = [];
  for (const sentence of sentences) {
    const characters = Array.from(sentence);
    for (let offset = 0; offset < characters.length; offset += limit) {
      pieces.push(characters.slice(offset, offset + limit).join(""));
    }
  }
  return pieces;
}

export function draftScript(story) {
  if (!story?.trim()) throw new Error("请先保存故事原文。");
  if (story.length > storyLimit) throw new Error("请缩短故事原文后再生成草稿。");
  const scenes = [];
  let scene = "";
  let characters = "";
  const add = (action, dialogue, beat) => {
    if (!action && !dialogue) return;
    const parts = splitAction(action, 430);
    const chunks = [];
    for (const part of parts) {
      if (chunks.length && chunks.at(-1).length + part.length + 1 <= 900) chunks[chunks.length - 1] += " " + part;
      else chunks.push(part);
    }
    for (const [i, chunk] of (chunks.length ? chunks : [""]).entries()) {
      const ending = splitAction(chunk, 180).at(-1) ?? "";
      scenes.push({ scene, characters, action: chunk, dialogue: i === 0 ? dialogue : "", beat: beat || ending });
    }
  };
  for (const paragraph of story.trim().split(/\r?\n\s*\r?\n/)) {
    let action = [];
    let dialogue = [];
    let beat = "";
    const flush = () => {
      add(action.join(" "), dialogue.join("\n"), beat);
      action = [];
      dialogue = [];
      beat = "";
    };
    for (const line of paragraph.trim().split(/\r?\n/)) {
      const field = line.trim().match(/^(场景|出场角色|角色|动作|对白|剧情推进)\s*[：:]\s*(.*)$/u);
      if (!field) {
        if (line.trim()) action.push(line.trim());
        continue;
      }
      const [, key, value] = field;
      if (key === "场景") {
        flush();
        scene = value;
        characters = "";
      } else if (key === "角色" || key === "出场角色") characters = value;
      else if (key === "对白") dialogue.push(value);
      else if (key === "剧情推进") beat = value;
      else action.push(value);
    }
    flush();
  }
  if (!scenes.length) throw new Error("请在故事里加入具体动作或情节。");
  return normalizeScript(scenes);
}

export function draftBoardOptions({ count, seconds } = {}) {
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > boardLimit)) {
    throw new Error("目标镜头数应为 1–" + boardLimit + " 的整数。");
  }
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 300 * boardLimit)) {
    throw new Error("目标总时长超出范围。");
  }
  return { count, seconds: seconds ?? 60 };
}

export function draftBoard(scenes, options) {
  const source = normalizeScript(scenes, true);
  const { count, seconds } = draftBoardOptions(options);
  const groups = source.map((scene) => ({ scene, actions: splitAction(scene.action, 280) }));
  const totalBeats = groups.reduce((total, { actions }) => total + actions.length, 0);
  const target = count ?? Math.min(12, Math.max(source.length, totalBeats));
  const sizes = groups.map(() => 1);
  for (let total = source.length; total < target; total++) {
    const canSplit = groups.map(({ actions }, index) => actions.length - sizes[index]);
    const next = canSplit.indexOf(Math.max(...canSplit));
    if (canSplit[next] <= 0) break;
    sizes[next]++;
  }
  const rows = [];
  for (const [index, { scene, actions }] of groups.entries()) {
    const size = sizes[index];
    const environment = !castNames(scene.characters).length;
    for (let i = 0; i < size; i++) {
      const first = Math.floor(i * actions.length / size);
      const after = Math.floor((i + 1) * actions.length / size);
      let block = "";
      for (const action of actions.slice(first, after)) {
        if (block.length + action.length + 1 > 600) {
          append(block);
          block = "";
        }
        block += (block ? " " : "") + action;
      }
      if (block) append(block);
      function append(action) {
        const firstInScene = rows.length === 0 || rows.at(-1).index !== index;
        const dialogue = firstInScene ? scene.dialogue : "";
        if (dialogue.length > 300) throw new Error("第 " + (index + 1) + " 场对白超过单镜头 300 字，请先在剧本中拆分该场对白。");
        rows.push({ index, scene: scene.scene, characters: scene.characters, action, dialogue,
          number: String(rows.length + 1).padStart(2, "0"),
          framing: firstInScene ? "交代场景 · 全景或中景" : environment ? "环境细节 · 近景" : "动作推进 · 中景",
        });
      }
    }
  }
  if (seconds < rows.length || seconds > rows.length * 300 || rows.length > boardLimit) {
    throw new Error("按现在的剧情可拆成 " + rows.length + " 镜，请调整目标总时长或缩短剧本。");
  }
  const durations = rows.map((_, index) => Math.floor((index + 1) * seconds / rows.length) - Math.floor(index * seconds / rows.length));
  return normalizeBoard(rows.map((row, index) => ({ ...row, duration: String(durations[index]) })));
}

export const settingFields = {
  characters: [
    { key: "identity", title: "外观与身份特征", limit: 600 },
    { key: "outfit", title: "服装设定", limit: 300 },
  ],
  locations: [
    { key: "layout", title: "空间布局", limit: 300 },
    { key: "lighting", title: "光线与色调", limit: 200 },
    { key: "props", title: "固定道具与环境细节", limit: 250 },
  ],
};

const settingName = (name) => name.trim().normalize("NFKC").toLowerCase();

function explicitSetting(group, name, key, sources) {
  const snippets = sources.flatMap(({ action }) => action.split(/[。！？；;，,\n]/u).map((part) => part.trim()));
  if (group === "characters") {
    const words = key === "outfit" ? ["身穿", "穿着"] : ["留着", "戴着", "佩戴", "有一处"];
    for (const part of snippets) {
      const detail = part.startsWith(name) ? part.slice(name.length).trim() : "";
      if (detail.length <= 90 && words.some((word) => detail.startsWith(word))) return detail;
    }
    return "";
  }
  const starters = {
    layout: /^(?:场景布局|空间布局|入口|走廊|站台边缘|站棚内)[：:]?/u,
    lighting: /^(?:光线|灯光|色调|棚顶亮着|室内亮着|窗外透进)[：:]?/u,
    props: /^(?:固定道具|墙边摆着|桌上放着|角落摆着)[：:]?/u,
  };
  return snippets.find((part) => part.length <= 120 && starters[key].test(part)) ?? "";
}

export function settingDraft(scenes, { previous, references = [], locations = [] } = {}) {
  const confirmed = normalizeScript(scenes, true);
  const entries = { characters: new Map(), locations: new Map() };
  const add = (category, name, scene, index) => {
    const key = settingName(name);
    const group = entries[category];
    if (!group.has(key)) {
      const existing = previous?.[category]?.find((row) => settingName(row.name) === key);
      const library = (category === "characters" ? references : locations)
        .filter((ref) => ref.confirmedAt && settingName(ref.name) === key)
        .sort((a, b) => b.edition - a.edition)[0];
      const known = category === "characters"
        ? { identity: library?.identity, outfit: library?.outfit }
        : { layout: library?.description?.slice(0, 300) };
      const fields = Object.fromEntries(settingFields[category].map(({ key: field }) =>
        [field, existing?.[field] ?? known[field] ?? null]));
      group.set(key, { name, ...fields, source: [] });
    }
    const item = group.get(key);
    if (item.source.some((source) => source.index === index)) return;
    item.source.push({ index, scene: scene.scene, action: scene.action });
  };
  for (const [index, scene] of confirmed.entries()) {
    add("locations", scene.scene, scene, index);
    for (const name of castNames(scene.characters)) add("characters", name, scene, index);
  }
  return Object.fromEntries(Object.entries(entries).map(([group, byName]) => [group, [...byName.values()].map((item) => {
    for (const { key } of settingFields[group]) item[key] ??= explicitSetting(group, item.name, key, item.source);
    return item;
  })]));
}

export function normalizeSettings(input, source) {
  return Object.fromEntries(Object.entries(settingFields).map(([group, fields]) => {
    const rows = input?.[group];
    if (!Array.isArray(rows) || rows.length !== source[group].length) throw new Error("设定条目须与已确认剧本一致。");
    const byName = new Map(rows.map((row) => [row?.name, row]));
    return [group, source[group].map(({ name }) => {
      if (!byName.has(name)) throw new Error("设定条目须与已确认剧本一致。");
      return { name, ...normalizeTextRow(byName.get(name), fields.map((field) => ({ ...field, optional: true })), name, true) };
    })];
  }));
}

export function locationDescription(location) {
  return settingFields.locations.filter(({ key }) => location[key]?.trim())
    .map(({ key, title }) => title + "：" + location[key].trim()).join("\n");
}

export const qualityCategories = {
  identity: "角色一致性", action: "动作", props: "道具", occlusion: "遮挡", continuity: "场景与衔接", other: "其他",
};
export const qualityOutcomes = { pass: "未见异常", problem: "发现问题", unclear: "无法判断" };

export function repairFindings(version) {
  if (!version) return [];
  const checks = version.repairPlan?.checks ?? (version.qualityChecks ?? []).filter(({ outcome }) => outcome === "problem");
  return [...(version.issues ?? []), ...checks].map((item) => {
    const time = version.type === "video" && Number.isFinite(item.time) ? item.time + " 秒：" : "";
    return time + (qualityCategories[item.category] ?? item.feature) + " · " + item.note +
      (item.fix ? "。修改要求：" + item.fix : "");
  });
}
