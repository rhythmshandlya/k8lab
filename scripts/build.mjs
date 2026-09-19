import process from "node:process";

import { runNext } from "./run-next.mjs";
import { migrateProductionBuild } from "./production-migrations.mjs";

try {
  await migrateProductionBuild(process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
runNext("build", process.argv.slice(2));
