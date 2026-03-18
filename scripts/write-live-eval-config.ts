#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import yaml from "js-yaml"
import { resolveRequiredEvalGithubAppsFromEnv } from "./live-eval-github-apps.js"

type Args = {
  outputPath: string
  repoPath: string
  repoFullName: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    outputPath: "",
    repoPath: "",
    repoFullName: process.env.CODEBRIDGE_EVAL_REPO ?? "dzianisv/codebridge-test"
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === "--output" && next) {
      args.outputPath = next
      index += 1
    } else if (arg === "--repo-path" && next) {
      args.repoPath = next
      index += 1
    } else if (arg === "--repo" && next) {
      args.repoFullName = next
      index += 1
    }
  }

  if (!args.outputPath) {
    throw new Error("Missing --output")
  }
  if (!args.repoPath) {
    throw new Error("Missing --repo-path")
  }

  return args
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apps = await resolveRequiredEvalGithubAppsFromEnv()
  const opencodeBaseUrl = optionalEnv("CODEBRIDGE_EVAL_OPENCODE_BASE_URL") ?? "http://127.0.0.1:4096"
  const opencodeModel = optionalEnv("CODEBRIDGE_EVAL_OPENCODE_MODEL") ?? "azure/gpt-4.1"
  const codexModel = optionalEnv("CODEBRIDGE_EVAL_CODEX_MODEL") ?? "gpt-5.2-codex"

  const config = {
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
            path: args.repoPath,
            backend: "codex",
            model: codexModel,
            baseBranch: "main",
            branchPrefix: "codexapp",
            githubApps: {
              codex: {
                model: codexModel
              },
              opencode: {
                backend: "opencode",
                agent: "build",
                model: opencodeModel,
                branchPrefix: "opencodeapp"
              }
            }
          }
        ],
        defaultRepo: args.repoFullName
      }
    ]
  }

  mkdirSync(path.dirname(args.outputPath), { recursive: true })
  writeFileSync(args.outputPath, yaml.dump(config, { noRefs: true }), "utf8")
  console.log(args.outputPath)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
