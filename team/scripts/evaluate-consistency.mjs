import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("用法：node scripts/evaluate-consistency.mjs <视觉检查结果.json>");
  process.exit(1);
}
const labels = JSON.parse(await readFile(new URL("../test/fixtures/consistency-labels.json", import.meta.url), "utf8"));
const data = JSON.parse(await readFile(path, "utf8"));
const entries = Array.isArray(data) ? data : data.shots.flatMap(({ versions }) => versions);
const results = new Map(entries.map((entry) => [entry.id, entry]));
const report = {};
for (const split of ["development", "holdout"]) {
  const count = { abnormal: 0, normal: 0, missed: 0, falseAlarms: 0, unchecked: [] };
  for (const truth of labels.filter((label) => label.split === split)) {
    const result = results.get(truth.version);
    if (!result?.checkedAt || !Array.isArray(result.issues)) {
      count.unchecked.push(truth.version);
      continue;
    }
    const flagged = result.issues.some((issue) => issue.source === "vision");
    if (truth.abnormal) {
      count.abnormal++;
      if (!flagged) count.missed++;
    } else {
      count.normal++;
      if (flagged) count.falseAlarms++;
    }
  }
  report[split] = { ...count, missRate: count.abnormal ? count.missed / count.abnormal : null,
    falseAlarmRate: count.normal ? count.falseAlarms / count.normal : null };
}
console.log(JSON.stringify(report, null, 2));
