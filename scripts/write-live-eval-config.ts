#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import yaml from "js-yaml"
import type { EvalGitHubAppIdentity } from "./live-eval-github-apps.js"
import { resolveRequiredEvalGithubAppsFromEnv } from "./live-eval-github-apps.js"

type Args = {
  outputPath: string
  repoFullName: string
}

type ResolvedEvalGithubApps = {
  codex: EvalGitHubAppIdentity
  opencode: EvalGitHubAppIdentity
}

type LiveEvalConfigModels = {
  codexModel: string
  opencodeModel?: string
}

const DEFAULT_LIVE_EVAL_OPENCODE_MODEL = "opencode/minimax-m2.5-free"

function parseArgs(argv: string[]): Args {
  const args: Args = {
    outputPath: "",
    repoFullName: process.env.CODEBRIDGE_EVAL_REPO ?? "dzianisv/codebridge-test"
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === "--output" && next) {
      args.outputPath = next
      index += 1
    } else if (arg === "--repo" && next) {
      args.repoFullName = next
      index += 1
    }
  }

  if (!args.outputPath) {
    throw new Error("Missing --output")
  }

  return args
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function buildLiveEvalConfig(input: {
  args: Args
  apps: ResolvedEvalGithubApps
  opencodeBaseUrl: string
  models: LiveEvalConfigModels
}) {
  const { args, apps, opencodeBaseUrl, models } = input
  const opencodeModel = models.opencodeModel ?? DEFAULT_LIVE_EVAL_OPENCODE_MODEL
  const opencodeOverride = {
    backend: "opencode",
    agent: "build",
    model: opencodeModel,
    branchPrefix: "opencodeapp"
  }

  return {
    secrets: {
      githubApps: {
        codex: {
          appId: apps.codex.appId,
          privateKey: apps.codex.privateKey,
          commandPrefixes: [apps.codex.slug]
        },
        opencode: {
          appId: apps.opencode.appId,
          privateKey: apps.opencode.privateKey,
          commandPrefixes: [apps.opencode.slug]
        }
      }
    },
    integrations: {
      opencode: {
        baseUrl: opencodeBaseUrl,
        enabled: true,
        timeoutMs: 300000,
        pollIntervalMs: 2000
      }
    },
    tenants: [
      {
        id: "local",
        name: "Local",
        github: {
          apps: [
            {
              appKey: "codex",
              installationId: apps.codex.installationId,
              repoAllowlist: [args.repoFullName],
              commandPrefixes: [apps.codex.slug]
            },
            {
              appKey: "opencode",
              installationId: apps.opencode.installationId,
              repoAllowlist: [args.repoFullName],
              commandPrefixes: [apps.opencode.slug]
            }
          ]
        },
        repos: [
          {
            fullName: args.repoFullName,
            backend: "codex",
            model: models.codexModel,
            baseBranch: "main",
            branchPrefix: "codexapp",
            githubApps: {
              codex: {
                model: models.codexModel
              },
              opencode: opencodeOverride
            }
          }
        ],
        defaultRepo: args.repoFullName
      }
    ]
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apps = await resolveRequiredEvalGithubAppsFromEnv()
  const opencodeBaseUrl = optionalEnv("CODEBRIDGE_EVAL_OPENCODE_BASE_URL") ?? "http://127.0.0.1:4096"
  const opencodeModel = optionalEnv("CODEBRIDGE_EVAL_OPENCODE_MODEL") ?? DEFAULT_LIVE_EVAL_OPENCODE_MODEL
  const codexModel = optionalEnv("CODEBRIDGE_EVAL_CODEX_MODEL") ?? "gpt-5.2-codex"
  const config = buildLiveEvalConfig({
    args,
    apps,
    opencodeBaseUrl,
    models: {
      codexModel,
      opencodeModel
    }
  })

  mkdirSync(path.dirname(args.outputPath), { recursive: true })
  writeFileSync(args.outputPath, yaml.dump(config, { noRefs: true }), "utf8")
  console.log(args.outputPath)
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false

if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
