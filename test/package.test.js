import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest declares a distinct local bundle", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "dsh-dispatch-gate");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.engines.dsh, "^0.2.1-rc.2");
});

test("declares a web client half for the composer", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.exports["./client"], "./client.js");
  assert.equal(manifest.dsh.client.platform, "web");
  assert.equal(manifest.dsh.client.immediately, true);
  assert.equal(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-api-workspace-files"), false);
  assert.equal(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-commands"), false);
  assert.equal(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-conversation"), true);
  assert.equal(manifest.files.includes("client.js"), true);

  const client = readFileSync(join(root, "client.js"), "utf8");
  assert.match(client, /window\.__ModuleLoader__\.load/);
  assert.match(client, /conversation\.input\.dock/);
  assert.match(client, /remote\.commands/);
  assert.match(client, /\/gate status json/);
  assert.match(client, /\/gate pause/);
  assert.match(client, /\/gate resume/);
  assert.equal(client.includes("PLANNER_SESSION_ID"), false);
  assert.match(client, /commandProject/);
  assert.match(client, /project\.visible/);
  assert.match(client, /selectedProject/);
});

test("uses schemastery APIs available in this DSH runtime", () => {
  const index = readFileSync(join(root, "lib/index.js"), "utf8");
  // Schemastery 3.18.5 object fields are optional by default and expose no
  // `.optional()` method. A schema using it fails before the plugin mounts.
  assert.equal(index.includes(".optional("), false);
  assert.match(index, /check: Check\.required\(\)/);
  assert.match(index, /check: z\.any\(\)/);
});

test("bundle patch inserts the gate row with three jobs", () => {
  const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id: dispatch-gate/);
  assert.match(patch, /name: dsh-dispatch-gate/);
  assert.match(patch, /id: coding-dispatch/);
  assert.match(patch, /id: acceptance-dispatch/);
  assert.match(patch, /id: planner-dispatch/);
  assert.match(patch, /assigned_coding/);
  assert.match(patch, /awaiting_verification/);
  assert.match(patch, /\.venv\/bin\/python/);
  const providerPolicies = patch.match(/retryPolicy:/g) ?? [];
  assert.equal(providerPolicies.length, 2);
  assert.match(patch, /id: llm-deepseek[\s\S]*?maxRetries: 2[\s\S]*?initialDelayMs: 5000/);
  assert.match(patch, /id: llm-deepseek-account[\s\S]*?maxRetries: 2[\s\S]*?maxDelayMs: 60000/);
  assert.match(patch, /retryableCodes: \[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT\]/);
  assert.match(patch, /offlineRecoveryEnabled: true/);
  assert.match(patch, /projects:/);
  assert.match(patch, /coordinatorAgent: planner/);
  assert.match(patch, /workerStateRoles:/);
});

test("uses a sidebar title distinct from the built-in automation label", () => {
  const en = JSON.parse(readFileSync(join(root, "locale/en.json"), "utf8"));
  const zh = JSON.parse(readFileSync(join(root, "locale/zh.json"), "utf8"));
  assert.equal(en.meta.title, "Dispatch Gate");
  assert.equal(zh.meta.title, "调度闸门");
  assert.equal(zh.meta.title.includes("自动化任务"), false);
  assert.equal(en.meta.title.toLowerCase().includes("automation"), false);
});

test("ships runtime, prompts, icon, and docs", () => {
  for (const file of [
    "lib/index.js",
    "lib/runtime.js",
    "lib/manager.js",
    "lib/gate.js",
    "prompts/coding.md",
    "prompts/acceptance.md",
    "prompts/planner.md",
    "locale/en.json",
    "locale/zh.json",
    "icon.svg",
    "README.md",
    "install.sh",
    "uninstall.sh",
  ]) {
    assert.equal(existsSync(join(root, file)), true, `${file} is missing`);
  }
  assert.equal(statSync(join(root, "icon.svg")).size < 256 * 1024, true);
  assert.match(readFileSync(join(root, "prompts/coding.md"), "utf8"), /assigned_coding/);
  assert.match(readFileSync(join(root, "prompts/acceptance.md"), "utf8"), /awaiting_verification/);
  assert.match(readFileSync(join(root, "prompts/planner.md"), "utf8"), /PLAN_NOOP/);
});

test("uses a producer-owned source kind rather than the retired plugin kind", () => {
  const source = readFileSync(join(root, "lib/gate.js"), "utf8") + readFileSync(join(root, "lib/runtime.js"), "utf8");
  assert.match(source, /dispatch-gate/);
  assert.equal(source.includes('kind: "plugin"'), false);
  assert.equal(source.includes("senderSessionId:"), false);
});
