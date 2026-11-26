import assert from "node:assert/strict";
import test from "node:test";
import { boardSample, clipFromBoardRow, normalizeBoard, parseBoard, parseScript, normalizeScript, scriptPrompt, storyboardPrompt, draftScript, draftBoard, settingDraft, normalizeSettings, locationDescription } from "../client/board-data.js";

test("parses spreadsheet paste and quoted CSV, preserving optional fields and row order", () => {
  const sample = parseBoard(boardSample);
  assert.deepEqual(sample.map(({ number }) => number), ["01", "02", "03", "04"]);
  const csv = '\uFEFF镜头编号,出场角色,场景,景别与角度,动作,目标时长（秒）,对白\r\n' +
    'A1,许棠,雨棚,近景,"转身,看向道路",４秒,"等一等\r\n我去拿伞"\r\n';
  const [row] = normalizeBoard(parseBoard(csv), true);
  assert.equal(row.action, "转身,看向道路");
  assert.equal(row.dialogue, "等一等\n我去拿伞");
  assert.equal(row.duration, 4);
  assert.equal(row.costume, "");
  assert.match(clipFromBoardRow(row, "id").context, /沿用已确认角色参考的服装/);
  assert.throws(() => parseBoard(csv.replace("出场角色,", "")), /表头缺少：出场角色/);
  assert.throws(() => parseBoard(csv.replace('道路"', '道路')), /引号/);
});

test("accepts unfinished drafts but rejects incomplete, duplicate or invalid confirmed rows", () => {
  assert.equal(normalizeBoard([{ number: " 01 " }])[0].number, "01");
  assert.throws(() => normalizeBoard([{ number: "01" }], true), /出场角色/);
  const row = parseBoard(boardSample)[0];
  assert.throws(() => normalizeBoard([row, { ...row, number: "１" }], true), /重复/);
  assert.throws(() => normalizeBoard([{ ...row, duration: "3.5" }], true), /整数/);
  assert.throws(() => normalizeBoard([{ ...row, duration: "301" }], true), /整数/);
});


test("builds both AI prompts with compatible headers and accepts pasted script output", () => {
  const story = "下雨了。许棠和林澈一起等车。";
  const header = "场景\t出场角色\t动作\t对白\t剧情推进";
  const scene = "雨夜公交站棚\t许棠、林澈\t许棠整理绿伞，林澈望向车道。\t\t两人从各自等车到并肩共伞。";
  assert.ok(scriptPrompt(story).includes(header));
  assert.ok(scriptPrompt(story).includes(story));
  const scenes = parseScript(["```tsv", header, scene, "```"].join("\n"));
  assert.equal(scenes[0].dialogue, "");
  assert.equal(normalizeScript(scenes, true)[0].beat, "两人从各自等车到并肩共伞。");
  assert.throws(() => normalizeScript([{ ...scenes[0], beat: "" }], true), /剧情推进/);
  const prompt = storyboardPrompt(scenes, { count: 4, seconds: 17 });
  assert.match(prompt, /正好 4 个镜头，总时长 17 秒/);
  assert.ok(prompt.includes(boardSample.split("\n")[0]));
  assert.ok(prompt.includes(scenes[0].action));
});

test("organizes source paragraphs without inventing unknown cast or locations", () => {
  const basic = draftScript("她推开铁门。\n\n走廊的灯灭了。");
  assert.deepEqual(basic.map(({ scene, characters, action }) => [scene, characters, action]), [
    ["", "", "她推开铁门。"], ["", "", "走廊的灯灭了。"],
  ]);
  const scripted = draftScript("场景：车站\n角色：小满\n动作：小满抬头。车灯亮起。\n对白：小满：车来了。\n剧情推进：结束等待。");
  assert.deepEqual(normalizeScript(scripted, true)[0], {
    scene: "车站", characters: "小满", action: "小满抬头。 车灯亮起。", dialogue: "小满：车来了。", beat: "结束等待。",
  });
});

test("splits confirmed action, preserves scene order and allocates requested total without duplicating dialogue", () => {
  const script = draftScript("场景：雨棚\n角色：林澈\n动作：林澈抬头。两束车灯亮起。\n对白：林澈：车到了。\n\n场景：路沿\n角色：无人\n公交进站。");
  const rows = normalizeBoard(draftBoard(script, { count: 6, seconds: 61 }), true);
  assert.deepEqual(rows.map(({ scene }) => scene), ["雨棚", "雨棚", "路沿"]);
  assert.deepEqual(rows.map(({ dialogue }) => dialogue), ["林澈：车到了。", "", ""]);
  assert.equal(rows.reduce((sum, row) => sum + row.duration, 0), 61);
  assert.throws(() => draftBoard(script, { seconds: 1 }), /调整目标总时长/);
});

test("seeds settings from confirmed evidence and retains creator edits across script updates", () => {
  const first = { scene: "旧站台", characters: "小满、林澈", action: "小满穿着米白雨衣。棚顶亮着暖黄色长灯。", beat: "等车" };
  const second = { scene: "旧站台", characters: "小满", action: "桌上放着一封旧信。", beat: "发现信" };
  const empty = { scene: "雨夜道路", characters: "无人", action: "雨水落在路沿。", beat: "夜雨" };
  const references = [
    { name: "林澈", confirmedAt: "old", edition: 1, identity: "左眉浅疤", outfit: "深蓝雨衣" },
    { name: "林澈", edition: 2, identity: "未确认特征", outfit: "灰衬衫" },
  ];
  const original = settingDraft([first, second, empty], { references });
  assert.deepEqual(original.characters.map(({ name, outfit }) => [name, outfit]), [["小满", "穿着米白雨衣"], ["林澈", "深蓝雨衣"]]);
  assert.equal(original.characters[0].identity, "");
  assert.equal(original.characters[0].source.length, 2);
  assert.equal(original.locations[0].lighting, "棚顶亮着暖黄色长灯");
  assert.match(locationDescription(original.locations[0]), /桌上放着一封旧信/);
  const saved = normalizeSettings(original, original);
  saved.characters[0].outfit = "米白连帽雨衣";
  const revised = settingDraft([{ ...second, action: "小满穿着黑色雨衣。" }, empty], { previous: saved });
  assert.deepEqual(revised.characters.map(({ name, outfit }) => [name, outfit]), [["小满", "米白连帽雨衣"]]);
  assert.throws(() => normalizeSettings(original, revised), /设定条目/);
  assert.equal(saved.characters[0].source, undefined);
});
