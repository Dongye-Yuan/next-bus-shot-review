import assert from "node:assert/strict";
import test from "node:test";
import { shotPrompt } from "../client/shot-prompt.js";

const shot = { id: "04", title: "开伞与共伞", duration: 5, context: "双人中景，许棠在两人前方撑伞。" };
const references = [{
  angle: "side",
  ref: { name: "许棠", edition: 2, identity: "黄色发夹在本人右侧", outfit: "米白连帽雨衣",
    images: { side: { file: "/reference.png" } } },
}];

test("associates a still repair with the original and the exact character reference", () => {
  const from = { type: "image", title: "旧图", file: "/old.png", note: "左侧面发夹画错" };
  const { text, assets } = shotPrompt({ shot, type: "image", references, from, directive: from.note });
  assert.deepEqual(assets.map(({ file }) => file), ["/old.png", "/reference.png"]);
  assert.match(text, /编辑图 1/);
  assert.match(text, /许棠（第 2 版，侧面参考）/);
  assert.match(text, /黄色发夹在本人右侧/);
  assert.equal(text.match(/左侧面发夹画错/g).length, 1);
});

test("requires an approved frame for the same shot and carries timed issue evidence into video prompts", () => {
  const frame = { shot: "04", type: "image", status: "approved", title: "收伞首帧", file: "/frame.png" };
  const from = { type: "video", note: "开伞位置错误", issues: [{ time: 2.5, feature: "道具", note: "伞从男主后面打开" }] };
  const details = { shot, type: "video", references, from, directive: "伞升至两人头顶" };
  assert.throws(() => shotPrompt(details), /确认关键帧/);
  assert.throws(() => shotPrompt({ ...details, frame: { ...frame, shot: "03" } }), /确认关键帧/);
  const { text, assets } = shotPrompt({ ...details, frame });
  assert.deepEqual(assets.map(({ file }) => file), ["/frame.png", "/reference.png"]);
  assert.equal(assets[1].optional, true);
  assert.match(text, /9:16.*5 秒/);
  assert.match(text, /2.5 秒：道具 · 伞从男主后面打开/);
  assert.match(text, /补充要求：\n伞升至两人头顶/);
});

test("adds the pinned scene as an image input and keeps the video first frame first", () => {
  const scene = { name: "雨夜站棚", edition: 1, description: "暖色灯与积水", image: { file: "/scene.png" } };
  const shot = { id: "empty", title: "车灯", duration: 4 };
  const still = shotPrompt({ type: "image", shot, references: [], scene });
  assert.match(still.text, /暖色灯与积水/);
  assert.deepEqual(still.assets.map(({ file, optional }) => [file, optional]), [["/scene.png", false]]);
  const frame = { type: "image", status: "approved", shot: shot.id, title: "车灯首帧", file: "/frame.png" };
  const video = shotPrompt({ type: "video", shot, references: [], scene, frame });
  assert.deepEqual(video.assets.map(({ file, optional }) => [file, Boolean(optional)]), [["/frame.png", false], ["/scene.png", true]]);
});
