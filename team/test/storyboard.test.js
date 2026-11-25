import assert from "node:assert/strict";
import test from "node:test";
import { boardSample, clipFromBoardRow, normalizeBoard, parseBoard } from "../client/board-data.js";

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
