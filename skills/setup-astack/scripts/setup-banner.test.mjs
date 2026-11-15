import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASTACK_ASCII_LOGO,
  formatSetupBanner,
  inspectWorkspace,
} from "./setup-banner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bannerScript = path.join(here, "setup-banner.mjs");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("inspectWorkspace and formatSetupBanner render defaults for a clean workspace", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-setup-clean-"));
  try {
    const workspaceDir = path.join(tmp, "demo-app");
    const homeDir = path.join(tmp, "home");
    const pluginRoot = path.join(tmp, "plugin");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    writeFile(
      path.join(pluginRoot, "hooks.json"),
      JSON.stringify({
        "astack-irreversible-guard": { enabled: false },
        "astack-verify-reminder": { enabled: false },
      }),
    );

    const status = inspectWorkspace({ cwd: workspaceDir, homeDir, pluginRoot });
    assert.equal(status.workspace, "demo-app");
    assert.deepEqual(status.verifySkills, []);
    assert.deepEqual(status.formalSkills, []);
    assert.deepEqual(status.tlaFiles, []);
    assert.deepEqual(status.hooks, { enabled: 0, total: 2 });
    assert.deepEqual(status.modelRules, []);

    const rendered = formatSetupBanner(status);
    assert.ok(rendered.includes(ASTACK_ASCII_LOGO));
    assert.match(rendered, /> \/setup-astack initiated · workspace: demo-app/);
    assert.match(rendered, /verify skills : none/);
    assert.match(rendered, /formal verify : none/);
    assert.match(rendered, /safety hooks  : opt-in \(0\/2 enabled\)/);
    assert.match(rendered, /model routing : native UI \/ Orchestrator \(zero-config\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("inspectWorkspace and formatSetupBanner report existing verification skills, TLA+ specs, hooks, and model overrides", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-setup-populated-"));
  try {
    const workspaceDir = path.join(tmp, "my-service");
    const homeDir = path.join(tmp, "home");
    const pluginRoot = path.join(tmp, "plugin");
    fs.mkdirSync(homeDir, { recursive: true });

    writeFile(path.join(workspaceDir, ".agents", "skills", "verify-web", "SKILL.md"), "---\nname: verify-web\ndescription: web\n---\n");
    writeFile(path.join(workspaceDir, ".agents", "skills", "verify-auth-formal", "SKILL.md"), "---\nname: verify-auth-formal\ndescription: formal\n---\n");
    writeFile(path.join(workspaceDir, "specs", "Auth.tla"), "---- MODULE Auth ----\n====\n");
    writeFile(path.join(workspaceDir, ".agents", "rules", "astack-models.md"), "---\ntrigger: model_decision\n---\n");
    writeFile(
      path.join(pluginRoot, "hooks.json"),
      JSON.stringify({
        "astack-irreversible-guard": { enabled: true },
        "astack-verify-reminder": { enabled: false },
      }),
    );

    const status = inspectWorkspace({ cwd: workspaceDir, homeDir, pluginRoot });
    assert.deepEqual(status.verifySkills, ["verify-web"]);
    assert.deepEqual(status.formalSkills, ["verify-auth-formal"]);
    assert.deepEqual(status.tlaFiles, ["specs/Auth.tla"]);
    assert.deepEqual(status.hooks, { enabled: 1, total: 2 });
    assert.deepEqual(status.modelRules, [".agents/rules/astack-models.md"]);

    const rendered = formatSetupBanner(status);
    assert.match(rendered, /verify skills : verify-web/);
    assert.match(rendered, /formal verify : verify-auth-formal, 1 \.tla spec\(s\)/);
    assert.match(rendered, /safety hooks  : opt-in \(1\/2 enabled\)/);
    assert.match(rendered, /model routing : custom override \(\.agents\/rules\/astack-models\.md\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setup-banner CLI prints ASCII banner and JSON status for --cwd", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-setup-cli-"));
  try {
    const workspaceDir = path.join(tmp, "cli-target");
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    writeFile(path.join(workspaceDir, ".agents", "skills", "verify-api", "SKILL.md"), "---\nname: verify-api\ndescription: api\n---\n");
    writeFile(path.join(workspaceDir, "Protocol.tla"), "---- MODULE Protocol ----\n====\n");

    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    const textOut = execFileSync(process.execPath, [bannerScript, "--cwd", workspaceDir], {
      encoding: "utf8",
      env,
    });
    assert.ok(textOut.includes(ASTACK_ASCII_LOGO));
    assert.match(textOut, /> \/setup-astack initiated · workspace: cli-target/);
    assert.match(textOut, /verify skills : verify-api/);
    assert.match(textOut, /formal verify : 1 \.tla spec\(s\)/);

    const jsonOut = execFileSync(process.execPath, [bannerScript, "--cwd", workspaceDir, "--json"], {
      encoding: "utf8",
      env,
    });
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.workspace, "cli-target");
    assert.deepEqual(parsed.verifySkills, ["verify-api"]);
    assert.deepEqual(parsed.tlaFiles, ["Protocol.tla"]);
    assert.equal(parsed.hooks.total, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
