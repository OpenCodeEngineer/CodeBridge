/**
 * promptfoo custom provider for CodeBridge eval.
 *
 * For each test case the provider:
 *   1. Creates a GitHub issue in the test repo
 *   2. Assigns it to `codexengineer` (triggers the bot via polling)
 *   3. Polls for the bot's reply containing "complete"
 *   4. Fetches any linked PR diff
 *   5. Returns the combined output for promptfoo's assertions to judge
 *
 * Config (passed via provider.config in promptfooconfig.yaml):
 *   repo        – target repo, e.g. "dzianisv/codebridge-test"
 *   botLogin    – bot account, e.g. "codexengineer[bot]"
 *   timeoutSec  – max seconds to wait for reply (default 300)
 *   pollSec     – poll interval (default 10)
 *   closeIssues – close issues after eval (default true)
 *   mentionHandle – fallback mention handle (default "@codexengineer")
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApiProvider, ProviderOptions, ProviderResponse, CallApiContextParams } from "promptfoo";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  GitHub helpers via gh CLI                                          */
/* ------------------------------------------------------------------ */

const gh = async (args: string[]): Promise<string> => {
  const env = { ...process.env } as Record<string, string>;
  delete env.GITHUB_TOKEN; // stale token; gh keyring auth works
  const { stdout } = await execFileAsync("gh", args, {
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type BotComment = {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
};

function isTerminalBotComment(body: string): boolean {
  const firstLine = body.split("\n")[0]?.trim().toLowerCase() ?? "";
  if (/^codex run\s+\S+\s+complete$/.test(firstLine)) return true;

  const statusMatch = body.match(/^\s*status:\s*([a-z-]+)/im);
  if (!statusMatch) return false;
  const status = statusMatch[1].toLowerCase();
  return status === "completed" || status === "failed" || status === "succeeded";
}

async function waitForBotReply(opts: {
  repo: string;
  issueNumber: number;
  botLogin: string;
  timeoutSec: number;
  pollSec: number;
  nudgeAfterSec?: number;
  onNoReplyNudge?: () => Promise<void>;
}): Promise<{ body: string; timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutSec * 1000;
  const startedAt = Date.now();
  const bot = opts.botLogin.toLowerCase();
  const nudgeAfterMs = (opts.nudgeAfterSec ?? 60) * 1000;
  let nudged = false;

  while (Date.now() < deadline) {
    const raw = await gh(["api", `repos/${opts.repo}/issues/${opts.issueNumber}/comments?per_page=100`]);
    const all: BotComment[] = JSON.parse(raw);
    const botComments = all.filter((c) => (c.user?.login ?? "").toLowerCase() === bot);
    const done = botComments.some((c) => isTerminalBotComment(c.body));
    if (done) {
      return { body: botComments.map((c) => c.body).join("\n\n---\n\n"), timedOut: false };
    }

    if (!nudged && botComments.length === 0 && Date.now() - startedAt >= nudgeAfterMs && opts.onNoReplyNudge) {
      try {
        await opts.onNoReplyNudge();
        nudged = true;
      } catch (e) {
        console.warn(`  [eval] nudge failed for #${opts.issueNumber}: ${(e as Error).message}`);
      }
    }

    await sleep(opts.pollSec * 1000);
  }

  // timeout — return partial
  const raw = await gh(["api", `repos/${opts.repo}/issues/${opts.issueNumber}/comments?per_page=100`]);
  const all: BotComment[] = JSON.parse(raw);
  const botComments = all.filter((c) => (c.user?.login ?? "").toLowerCase() === bot);
  if (botComments.length) {
    return { body: botComments.map((c) => c.body).join("\n\n---\n\n"), timedOut: true };
  }
  return { body: "(no reply within timeout)", timedOut: true };
}

async function getPrDiff(repo: string, issueNumber: number): Promise<string | null> {
  try {
    const raw = await gh(["api", `repos/${repo}/issues/${issueNumber}/timeline?per_page=100`]);
    const events: any[] = JSON.parse(raw);
    const prEvent = events.find((e) => e.source?.issue?.pull_request?.html_url);
    if (prEvent?.source?.issue?.number) {
      return await gh(["pr", "diff", String(prEvent.source.issue.number), "--repo", repo]);
    }
  } catch {
    // no PR, that's fine
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

export default class CodeBridgeProvider implements ApiProvider {
  private repo: string;
  private botLogin: string;
  private timeoutSec: number;
  private pollSec: number;
  private closeIssues: boolean;
  private mentionHandle: string;
  private createdIssues: number[] = [];

  constructor(options: ProviderOptions) {
    const cfg = (options.config ?? {}) as Record<string, unknown>;
    this.repo = (cfg.repo as string) ?? "dzianisv/codebridge-test";
    this.botLogin = (cfg.botLogin as string) ?? "codexengineer[bot]";
    this.timeoutSec = (cfg.timeoutSec as number) ?? 300;
    this.pollSec = (cfg.pollSec as number) ?? 10;
    this.closeIssues = (cfg.closeIssues as boolean) ?? (cfg.cleanup as boolean) ?? true;
    const mentionRaw = ((cfg.mentionHandle as string) ?? "@codexengineer").trim();
    this.mentionHandle = mentionRaw.startsWith("@") ? mentionRaw : `@${mentionRaw}`;
  }

  id(): string {
    return "codebridge";
  }

  async callApi(prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const vars = (context?.vars ?? {}) as Record<string, string>;
    const title = vars.title ?? "Eval task";
    const tag = Date.now();

    // 1. Create issue
    const issueUrl = await gh([
      "issue", "create",
      "--repo", this.repo,
      "--title", `[eval] ${title} (${tag})`,
      "--body", prompt,
    ]);
    const issueNumber = Number(issueUrl.match(/\/issues\/(\d+)/)?.[1]);
    if (!issueNumber) {
      return { error: `Failed to parse issue number from: ${issueUrl}` };
    }
    this.createdIssues.push(issueNumber);

    // 2. Assign to codexengineer (trigger path #1)
    let triggerMode: "assignment" | "mention" = "assignment";
    const botLogins = new Set<string>([
      this.botLogin.toLowerCase(),
      this.botLogin.replace(/\[bot\]$/i, "").toLowerCase(),
    ]);
    let assignmentWorked = false;

    try {
      await gh([
        "api", "--method", "POST",
        `repos/${this.repo}/issues/${issueNumber}/assignees`,
        "-f", "assignees[]=codexengineer",
      ]);

      const issueJson = await gh(["api", `repos/${this.repo}/issues/${issueNumber}`]);
      const issue = JSON.parse(issueJson) as { assignees?: Array<{ login?: string }> };
      assignmentWorked = !!issue.assignees?.some((a) => botLogins.has((a.login ?? "").toLowerCase()));
    } catch (e) {
      assignmentWorked = false;
      console.warn(`  [eval] assignment trigger failed for #${issueNumber}: ${(e as Error).message}`);
    }

    // 3. Mention fallback (trigger path #2) when assignment is ineffective
    const mentionBody = `${this.mentionHandle} run ${prompt}`;
    if (!assignmentWorked) {
      triggerMode = "mention";
      await gh([
        "issue", "comment", String(issueNumber),
        "--repo", this.repo,
        "--body", mentionBody,
      ]);
    }

    console.log(`  [eval] Created issue #${issueNumber} (${triggerMode}): ${issueUrl}`);

    // 4. Wait for bot reply
    const reply = await waitForBotReply({
      repo: this.repo,
      issueNumber,
      botLogin: this.botLogin,
      timeoutSec: this.timeoutSec,
      pollSec: this.pollSec,
      nudgeAfterSec: 60,
      onNoReplyNudge: async () => {
        await gh([
          "issue", "comment", String(issueNumber),
          "--repo", this.repo,
          "--body", mentionBody,
        ]);
      },
    });

    // 5. Fetch PR diff if any
    const diff = await getPrDiff(this.repo, issueNumber);

    // 6. Build combined output for the judge
    const parts = [
      `## Bot Response`,
      reply.body,
    ];
    if (diff) {
      parts.push("", `## PR Diff`, "```diff", diff, "```");
    }
    if (reply.timedOut) {
      parts.push("", `**WARNING**: Bot reply timed out after ${this.timeoutSec}s (partial output above)`);
    }

    const output = parts.join("\n");

    // 7. Cleanup
    if (this.closeIssues) {
      try { await gh(["issue", "close", String(issueNumber), "--repo", this.repo]); } catch { /* ok */ }
    }

    return {
      output,
      metadata: {
        issueUrl,
        issueNumber,
        timedOut: reply.timedOut,
        hasPR: !!diff,
        triggerMode,
      },
    };
  }
}
