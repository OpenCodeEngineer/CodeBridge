#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import yaml from "js-yaml"

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

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const codexAppId = Number.parseInt(requireEnv("CODEBRIDGE_EVAL_GITHUB_APP_ID"), 10)
  const codexPrivateKey = requireEnv("CODEBRIDGE_EVAL_GITHUB_PRIVATE_KEY")
  const codexInstallationId = Number.parseInt(requireEnv("CODEBRIDGE_EVAL_GITHUB_INSTALLATION_ID"), 10)
  const opencodeAppId = Number.parseInt(
    optionalEnv("CODEBRIDGE_EVAL_OPENCODE_GITHUB_APP_ID") ?? String(codexAppId),
    10
  )
  const opencodePrivateKey = optionalEnv("CODEBRIDGE_EVAL_OPENCODE_GITHUB_PRIVATE_KEY") ?? codexPrivateKey
  const opencodeInstallationId = Number.parseInt(
    optionalEnv("CODEBRIDGE_EVAL_OPENCODE_GITHUB_INSTALLATION_ID") ?? String(codexInstallationId),
    10
  )
  const codexPrefix = optionalEnv("CODEBRIDGE_EVAL_CODEX_PREFIX") ?? "CodexApp"
  const opencodePrefix = optionalEnv("CODEBRIDGE_EVAL_OPENCODE_PREFIX") ?? "OpenCodeApp"
  const opencodeBaseUrl = optionalEnv("CODEBRIDGE_EVAL_OPENCODE_BASE_URL") ?? "http://127.0.0.1:4096"
  const opencodeModel = optionalEnv("CODEBRIDGE_EVAL_OPENCODE_MODEL") ?? "azure/gpt-4.1"
  const codexModel = optionalEnv("CODEBRIDGE_EVAL_CODEX_MODEL") ?? "gpt-5.2-codex"

  const config = {
    secrets: {
      githubApps: {
        codex: {
          appId: codexAppId,
          privateKey: codexPrivateKey,
          commandPrefixes: [codexPrefix]
        },
        opencode: {
          appId: opencodeAppId,
          privateKey: opencodePrivateKey,
          commandPrefixes: [opencodePrefix]
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
              installationId: codexInstallationId,
              repoAllowlist: [args.repoFullName],
              commandPrefixes: [codexPrefix]
            },
            {
              appKey: "opencode",
              installationId: opencodeInstallationId,
              repoAllowlist: [args.repoFullName],
              commandPrefixes: [opencodePrefix]
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

main()
