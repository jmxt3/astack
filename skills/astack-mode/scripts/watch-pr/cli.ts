import { setTimeout as delay } from "node:timers/promises";
import { parseArgs as nodeParseArgs } from "node:util";
import {
  GhGitHubReader,
  WatcherQueryError,
  discoverStack,
  resolveContext,
} from "./github.ts";
import {
  runQueued,
  runSimple,
  statusQueryVerdict,
  verdictFactory,
  type WatchClock,
} from "./policy.ts";
import { renderJson, renderPretty } from "./render.ts";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";

export interface CliOptions {
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
  readonly mode: T.WatchMode;
  readonly stackPrs: readonly T.PrNumber[];
  readonly statusOnly: boolean;
  readonly pretty: boolean;
  readonly polling: T.PollingOptions;
}

class CliExitError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CliExitError";
    this.exitCode = exitCode;
  }
}

const HELP_TEXT = `Usage: watch-pr [options]

Watch one pull request, a connected stack, or an immutable queued stack.
JSON (NDJSON while polling) is the default; --pretty renders human text.

Options:
  --owner <owner>             GitHub repository owner
  --repo <repo>               GitHub repository name
  --pr <number>               pull request number
  --stack                     watch the connected open stack
  --queued-stack              watch the captured stack until all PRs merge
  --stack-prs <n,...>         frozen bottom-to-top queue (queued mode only)
  --interval <seconds>        poll interval (default: 60)
  --sweep-interval <seconds>  whole-stack sweep interval (default: 300)
  --timeout <seconds>         deadline; 0 disables it (default: 0)
  --max-query-errors <count>  consecutive query-error budget (default: 5)
  --status-only               print one status table and exit 0
  --allow-draft               do not treat a draft as a merge gate
  --pretty                    render human text instead of JSON
  -h, --help                  display help for command
`;

function invalidArg(flag: string, value: string, reason: string): never {
  throw new CliExitError(`error: option '${flag}' argument '${value}' is invalid (${reason})\n`, 64);
}

function positiveNumber(flag: string, value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
    invalidArg(flag, value, "must be greater than zero");
  }
  return parsed;
}

function nonNegativeNumber(flag: string, value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
    invalidArg(flag, value, "must be zero or greater");
  }
  return parsed;
}

function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed <= 0) {
    invalidArg(flag, value, "must be a positive integer");
  }
  return parsed;
}

function prNumber(flag: string, value: string): T.PrNumber {
  try {
    return parsePrNumber(Number(value.replace(/^#/, "")));
  } catch {
    invalidArg(flag, value, "must be a positive integer");
  }
}

function stackPrList(value: string): T.NonEmpty<T.PrNumber> {
  const numbers = value.split(",").map((part) => prNumber("--stack-prs <n,...>", part.trim()));
  if (new Set(numbers).size !== numbers.length) {
    invalidArg("--stack-prs <n,...>", value, "contains a duplicate PR");
  }
  const parsed = nonEmpty(numbers);
  if (parsed === null) {
    invalidArg("--stack-prs <n,...>", value, "cannot be empty");
  }
  return parsed;
}

export function parseArgs(
  argv: readonly string[],
  io: Pick<CliRuntime, "stdout" | "stderr">
): CliOptions {
  let parsed: ReturnType<typeof nodeParseArgs>;
  try {
    parsed = nodeParseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "string" },
        stack: { type: "boolean", default: false },
        "queued-stack": { type: "boolean", default: false },
        "stack-prs": { type: "string" },
        interval: { type: "string", default: "60" },
        "sweep-interval": { type: "string", default: "300" },
        timeout: { type: "string", default: "0" },
        "max-query-errors": { type: "string", default: "5" },
        "status-only": { type: "boolean", default: false },
        "allow-draft": { type: "boolean", default: false },
        pretty: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const formatted = `error: ${message}\n`;
    io.stderr(formatted);
    throw new CliExitError(formatted, 64);
  }

  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help) {
    io.stdout(HELP_TEXT);
    throw new CliExitError("", 0);
  }

  try {
    const isStack = Boolean(values.stack);
    const isQueuedStack = Boolean(values["queued-stack"]);
    if (isStack && isQueuedStack) {
      throw new CliExitError("error: option '--stack' cannot be used with option '--queued-stack'\n", 64);
    }

    const rawStackPrs = values["stack-prs"] as string | undefined;
    const stackPrs = rawStackPrs !== undefined ? stackPrList(rawStackPrs) : undefined;
    if (stackPrs !== undefined && !isQueuedStack) {
      throw new CliExitError("error: --stack-prs requires --queued-stack\n", 64);
    }

    return {
      owner: (values.owner as string | undefined) ?? null,
      repo: (values.repo as string | undefined) ?? null,
      pr: values.pr !== undefined ? prNumber("--pr <number>", String(values.pr)) : null,
      mode: isQueuedStack ? "queued-stack" : isStack ? "stack" : "single",
      stackPrs: stackPrs ?? [],
      statusOnly: Boolean(values["status-only"]),
      pretty: Boolean(values.pretty),
      polling: {
        interval: positiveNumber("--interval <seconds>", String(values.interval)),
        sweepInterval: positiveNumber("--sweep-interval <seconds>", String(values["sweep-interval"])),
        timeout: nonNegativeNumber("--timeout <seconds>", String(values.timeout)),
        maxQueryErrors: positiveInteger("--max-query-errors <count>", String(values["max-query-errors"])),
        allowDraft: Boolean(values["allow-draft"]),
      },
    };
  } catch (error) {
    if (error instanceof CliExitError && error.exitCode !== 0) {
      io.stderr(error.message);
    }
    throw error;
  }
}

export interface CliRuntime {
  readonly reader: T.GitHubReader;
  readonly clock: WatchClock;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

function realRuntime(): CliRuntime {
  return {
    reader: new GhGitHubReader(),
    clock: {
      now: () => performance.now() / 1_000,
      observedAt: () => new Date().toISOString(),
      sleep: async (seconds) => {
        await delay(seconds * 1_000);
      },
    },
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

export async function main(
  argv: readonly string[],
  runtime: CliRuntime = realRuntime()
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv, runtime);
  } catch (error) {
    if (!(error instanceof CliExitError)) throw error;
    return error.exitCode;
  }
  const render = options.pretty ? renderPretty : renderJson;
  const emit = (verdict: T.ProgressVerdict): void =>
    runtime.stdout(render(verdict));
  let contexts: T.NonEmpty<T.PrContext>;
  try {
    const seed = await resolveContext({
      reader: runtime.reader,
      owner: options.owner,
      repo: options.repo,
      pr: options.pr ?? options.stackPrs[0] ?? null,
    });
    contexts =
      nonEmpty(options.stackPrs.map((number) => ({ ...seed, number }))) ??
      (options.mode === "single"
        ? [seed]
        : await discoverStack(runtime.reader, seed));
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;
    const verdict = statusQueryVerdict(
      verdictFactory(runtime.clock, options.mode),
      1,
      error.failure
    );
    runtime.stdout(render(verdict));
    return verdict.exitCode;
  }
  const dependencies = { reader: runtime.reader, clock: runtime.clock, emit };
  const verdict =
    options.mode === "queued-stack" && !options.statusOnly
      ? await runQueued({ dependencies, contexts, options: options.polling })
      : await runSimple({
          dependencies,
          contexts,
          mode: options.mode,
          statusOnly: options.statusOnly,
          options: options.polling,
        });
  runtime.stdout(render(verdict));
  return verdict.exitCode;
}
