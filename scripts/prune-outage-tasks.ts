// Remove the tasks that failed because the platform's own provider key was invalid.
//
//   npx tsx scripts/prune-outage-tasks.ts              # dry run, prints what it would remove
//   npx tsx scripts/prune-outage-tasks.ts --apply      # actually removes it
//
// The reasoning, and the guards that keep this narrow, are in src/lib/pruneOutageTasks.ts.

import { getDb } from "../src/lib/db";
import { pruneOutageTasks } from "../src/lib/pruneOutageTasks";

const apply = process.argv.includes("--apply");
const r = pruneOutageTasks(getDb(), { apply });

console.log(`tasks in the ledger      : ${r.tasksTotal.toLocaleString()}`);
console.log(`  of which failed        : ${r.failedTotal.toLocaleString()}`);
console.log(`failed on the key outage : ${r.inScope.toLocaleString()}`);
console.log(`  between                : ${r.firstAt ?? "-"} and ${r.lastAt ?? "-"}`);
console.log(`failures left afterwards : ${r.failedAfter.toLocaleString()}`);
if (r.sample.length) {
  console.log("\nsample:");
  for (const s of r.sample) console.log(`  ${s.at}  ${s.from} -> ${s.to}`);
}
if (r.inScope === 0) console.log("\nnothing to do.");
else if (!r.applied) console.log("\ndry run. Nothing was changed. Pass --apply to remove them.");
else console.log(`\nremoved ${r.removedTasks.toLocaleString()} tasks and ${r.removedRelated.toLocaleString()} related rows.`);
