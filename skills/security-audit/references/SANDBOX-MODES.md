# Execution Sandbox Modes for `/security-audit`

`/security-audit` enforces Cloudflare's 4-part execution isolation contract before running any target-controlled build, test, parser fixture, browser check, or local server:

1. Zero outbound external network (isolated loopback only when local client/server checks require it).
2. Empty allowlisted environment without host credentials, tokens, or ambient variables.
3. Read-only target source and toolchain, with target writes strictly limited to the assigned `scratch/` directory.
4. Explicit low CPU, memory, process, output-size, and wall-clock limits, followed by parent-side race-safe artifact promotion.

Run the empirical sandbox probe before any dynamic local verification:

```bash
node skills/security-audit/scripts/sandbox-runner.mjs --probe --json
```

## 3-Tier Adaptive Isolation Model

| Tier | Backing | When Selected | Execution Scope |
|---|---|---|---|
| **Tier 1 (Default)** | Antigravity Native Terminal Sandbox + `sandbox-runner.mjs` | Probe confirms outbound network is blocked and `~/.ssh` is hidden/inaccessible, on Linux namespaces, macOS `sandbox-exec`, or Windows 11 24H2+ (build `>= 26100`) AppContainer. | Permitted for bounded unit checks, parser fixtures, and read-only target audits from an external output workspace (`read_file(<target-repo>)` + `write_file(<output-dir>/agents/<id>/scratch/)`). Never run untrusted repository install scripts (`postinstall`, Makefiles) inside an in-repo read-write session. |
| **Tier 2 (Opt-In Heavy)** | OpenSandbox (`osb` CLI or `opensandbox-mcp`, Docker locally or Kubernetes + Firecracker/gVisor/Kata) | `OPENSANDBOX_MCP`, `OPENSANDBOX_DOMAIN`, or `~/.opensandbox.toml` with `osb` is active. | Required for untrusted target builds, native/binary fuzzers, multi-service loopback stacks, or when host files outside the workspace must remain completely unmounted. |
| **Tier 0 (Fallback)** | Static source inspection only | Empirical probe fails (`Turbo` / `Request Review` presets, legacy Windows, restricted Linux containers lacking unprivileged user namespaces) and Tier 2 is unavailable. | Executes **zero** target-controlled code. Retain dynamic leads as `needs_validation` with exact local or owner-observed resolution steps. |

## Enabling Tier 1 (Antigravity Native Terminal Sandbox)

- **Antigravity App:** Set the permission preset to **Default** or **Auto** (`v2.26.0+` on Windows 11 24H2+ Aug 2026 update+, `v2.23.0+` on macOS/Linux). For Business/Enterprise accounts using legacy presets, enable **Enable Sandbox Mode (Preview)** and **Proceed in Sandbox**. Keep target domains out of `read_url` allowlists so sandboxed commands retain zero outbound network.
- **Antigravity CLI:** Run `agy --sandbox` or `agy --mode=auto`, or configure `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "enableTerminalSandbox": true,
  "toolPermission": "proceed-in-sandbox"
}
```

Do not assume flags guarantee sandboxing: older Windows builds and containers that block unprivileged user namespaces silently fall back to unsandboxed review mode (`Tier 0`), which `sandbox-runner.mjs --probe` catches empirically.

## Enabling Tier 2 (Opt-In OpenSandbox)

For hostile codebases or full build isolation without touching the host workspace:

1. Start a local Docker OpenSandbox server (`uvx opensandbox-server init-config ~/.sandbox.toml --example docker && uvx opensandbox-server`) and configure `osb` or `opensandbox-mcp`.
2. **Pin container images by immutable SHA-256 digest** rather than floating tags (covering tracked signing/provenance gaps such as `opensandbox-group/OpenSandbox#2463`):

```bash
osb sandbox create --image "python@sha256:<digest>" --timeout 15m -o json
```

3. Destroy every sandbox (`sandbox.destroy()` / `osb sandbox delete <id>`) on completion or failure, and promote only predeclared non-secret output files via `sandbox-runner.mjs --promote`.
