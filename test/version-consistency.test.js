import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("worker reports the package release version",()=>{
  const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  const app=readFileSync(new URL("../worker/src/app.ts",import.meta.url),"utf8");
  expect(app).toContain(`const VERSION = "${pkg.version}";`);
});
