#!/usr/bin/env node
import { explore } from "./engine.js";
import { createBulbamAdapter } from "./bulbam-adapter.js";

const mode = process.argv[2] ?? "signed-in";
const adapter = await createBulbamAdapter({ mode });
try {
  const report = await explore(adapter, { maxDepth: 6, maxStates: 65, maxActions: 250 });
  process.stdout.write(JSON.stringify({ scenario: mode, ...report }));
} finally {
  adapter.close();
}
