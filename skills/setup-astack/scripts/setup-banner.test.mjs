import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASTACK_ASCII_LOGO,
  formatDoctorReport,
  formatSetupBanner,
  inspectWorkspace,
  runWorkspaceDoctor,
} from "./setup-banner.mjs";
import { scaffoldRepoPolicies } from "./init-repo-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bannerScript = path.join(here, "setup-banner.mjs");
const initPolicyScript = path.join(here, "init-repo-policy.mjs");

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
    assert.match(rendered, /safety hooks  : opt-in \(0\/2 enabled; passive 0\/0, blocking 0\/2\)/);
    assert.match(rendered, /repo policies : defaults \(unconfigured\)/);
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
    assert.match(rendered, /safety hooks  : opt-in \(1\/2 enabled; passive 0\/0, blocking 1\/2\)/);
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
    assert.equal(parsed.hooks.total, 9);
    assert.equal(parsed.hookBreakdown.passiveTotal, 3);
    assert.equal(parsed.hookBreakdown.passiveEnabled, 3);
    assert.equal(parsed.hookBreakdown.blockingTotal, 6);
    assert.equal(parsed.hookBreakdown.blockingEnabled, 0);
    assert.equal(parsed.policies.boundaries, false);

    const liveStatus = inspectWorkspace({ cwd: path.resolve(here, "../../..") });
    assert.equal(liveStatus.policies.boundaries, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runWorkspaceDoctor and setup-banner --doctor report workspace diagnostics", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-doctor-"));
  try {
    const workspaceDir = path.join(tmp, "doc-app");
    const homeDir = path.join(tmp, "home");
    const pluginRoot = path.join(tmp, "plugin");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    writeFile(
      path.join(pluginRoot, "hooks.json"),
      JSON.stringify({ "astack-irreversible-guard": { enabled: true } }),
    );
    writeFile(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "---\nname: verify-app\ndescription: app\n---\n");

    const report = runWorkspaceDoctor({
      cwd: workspaceDir,
      homeDir,
      pluginRoot,
    });
    assert.equal(report.ok, true);
    const rendered = formatDoctorReport(report);
    assert.match(rendered, /> \/setup-astack --doctor/);
    assert.match(rendered, /\[PASS\] safety-hooks: passive 0\/0 enabled, blocking 1\/1 opt-in \(1\/1 total\)/);

    writeFile(path.join(pluginRoot, "hooks.json"), "{broken");
    const brokenHooks = runWorkspaceDoctor({ cwd: workspaceDir, homeDir, pluginRoot });
    assert.equal(brokenHooks.ok, false);
    assert.ok(brokenHooks.checks.some((c) => c.id === "safety-hooks" && c.status === "warn"));

    const cliOut = execFileSync(process.execPath, [bannerScript, "--doctor", "--json", "--cwd", workspaceDir], {
      encoding: "utf8",
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });
    const parsed = JSON.parse(cliOut);
    assert.equal(parsed.workspace, "doc-app");
    assert.ok(Array.isArray(parsed.checks));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scaffoldRepoPolicies creates defaults idempotently and supports --dry-run and --force", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-init-policy-"));
  try {
    const dry = scaffoldRepoPolicies({ cwd: tmp, dryRun: true });
    assert.equal(dry.created.length, 4);
    assert.equal(fs.existsSync(path.join(tmp, ".agents", "risk-policy.json")), false);

    const first = scaffoldRepoPolicies({ cwd: tmp });
    assert.deepEqual(first.created, [".agents/risk-policy.json", ".agents/boundaries.json", "REVIEW.md", "GLOSSARY.md"]);
    assert.deepEqual(first.skipped, []);

    fs.writeFileSync(path.join(tmp, "REVIEW.md"), "# Custom\n", "utf8");
    const second = scaffoldRepoPolicies({ cwd: tmp });
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.length, 4);
    assert.equal(fs.readFileSync(path.join(tmp, "REVIEW.md"), "utf8"), "# Custom\n");

    const forced = scaffoldRepoPolicies({ cwd: tmp, targets: ["review-md"], force: true });
    assert.deepEqual(forced.overwritten, ["REVIEW.md"]);
    assert.match(fs.readFileSync(path.join(tmp, "REVIEW.md"), "utf8"), /Repository Review Rules/);

    const cliDir = path.join(tmp, "cli-init");
    const dryCli = JSON.parse(
      execFileSync(process.execPath, [initPolicyScript, "--cwd", cliDir, "--dry-run", "--json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(dryCli.dryRun, true);
    assert.equal(dryCli.created.length, 4);
    assert.equal(fs.existsSync(path.join(cliDir, ".agents", "risk-policy.json")), false);

    const selectiveCli = JSON.parse(
      execFileSync(process.execPath, [initPolicyScript, "--cwd", cliDir, "--targets", "risk-policy,review-md", "--json"], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(selectiveCli.created, [".agents/risk-policy.json", "REVIEW.md"]);
    assert.equal(fs.existsSync(path.join(cliDir, "GLOSSARY.md")), false);

    const rerunCli = JSON.parse(
      execFileSync(process.execPath, [initPolicyScript, "--cwd", cliDir, "--json"], { encoding: "utf8" }),
    );
    assert.deepEqual(rerunCli.created, [".agents/boundaries.json", "GLOSSARY.md"]);
    assert.deepEqual(rerunCli.skipped, [".agents/risk-policy.json", "REVIEW.md"]);

    const forceCli = JSON.parse(
      execFileSync(process.execPath, [initPolicyScript, "--cwd", cliDir, "--force", "--targets", "review-md", "--json"], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(forceCli.overwritten, ["REVIEW.md"]);

    const prTplCli = JSON.parse(
      execFileSync(process.execPath, [initPolicyScript, "--cwd", cliDir, "--targets", "pr-template", "--json"], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(prTplCli.created, [".github/PULL_REQUEST_TEMPLATE.md"]);
    const prTplRerun = JSON.parse(
      execFileSync(process.execPath, [initPolicyScript, "--cwd", cliDir, "--targets", "pr-template", "--json"], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(prTplRerun.skipped, [".github/PULL_REQUEST_TEMPLATE.md"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
