import assert from "node:assert/strict";
import test from "node:test";
import { moviePlan } from "../client/movie.js";

test("plans the current shot order and duration using only approved selections", () => {
  const clips = [
    { id: "two", title: "Shot 2", duration: 5 },
    { id: "one", title: "Shot 1", duration: 4 },
    { id: "three", title: "Shot 3", duration: 2 },
    { id: "four", title: "Shot 4", duration: 6 },
  ];
  const picked = { id: "v2", shot: "two", status: "approved" };
  const plan = moviePlan(clips, [
    picked, { id: "v1", shot: "one", status: "rejected" },
  ], { two: "v2", one: "v1", three: "v2" });
  assert.equal(plan.duration, 17);
  assert.deepEqual(plan.shots.map(({ id, start }) => [id, start]), [
    ["two", 0], ["one", 5], ["three", 9], ["four", 11],
  ]);
  assert.deepEqual(plan.missing.map(({ id, index }) => [id, index]), [["one", 1], ["three", 2], ["four", 3]]);
  assert.equal(plan.shots[0].version, picked);
  assert.deepEqual(moviePlan([], [], {}), { shots: [], duration: 0, missing: [] });
});
