#!/usr/bin/env tsx

import { resolveGithubAppIdentity } from "../src/command-prefixes.js"
import { normalizeBotLogins } from "./eval-customer-flow-lib.js"

export type EvalGitHubAppIdentity = {
  key: "codex" | "opencode"
  appId: number
  installationId: number
  privateKey: string
  slug: string
  handle: string
  botLogin: string
}

type MinimalIdentity = Pick<EvalGitHubAppIdentity, "key" | "appId" | "slug" | "botLogin">

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function parseRequiredIntEnv(name: string): number {
  const value = Number.parseInt(requireEnv(name), 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`)
  }
  return value
}

export function assertDistinctEvalGithubApps(input: {
  codex: MinimalIdentity
  opencode: MinimalIdentity
}): void {
  if (input.codex.appId === input.opencode.appId) {
    throw new Error(
      [
        "Hard-gate eval requires distinct GitHub Apps for codex and opencode.",
        `Both app keys resolved to appId=${input.codex.appId}.`
      ].join(" ")
    )
  }

  if (input.codex.slug.toLowerCase() === input.opencode.slug.toLowerCase()) {
    throw new Error(
      [
        "Hard-gate eval requires distinct GitHub App slugs for codex and opencode.",
        `Both app keys resolved to @${input.codex.slug}.`
      ].join(" ")
    )
  }

  if (input.codex.botLogin.toLowerCase() === input.opencode.botLogin.toLowerCase()) {
    throw new Error(
      [
        "Hard-gate eval requires distinct GitHub App bot authors for codex and opencode.",
        `Both app keys resolved to ${input.codex.botLogin}.`
      ].join(" ")
    )
  }
}

export function resolveExpectedHandle(label: string, explicit: string | undefined, resolvedHandle: string): string {
  if (!explicit?.trim()) return resolvedHandle
  const normalizedExplicit = explicit.trim().startsWith("@") ? explicit.trim() : `@${explicit.trim()}`
  if (normalizedExplicit.toLowerCase() !== resolvedHandle.toLowerCase()) {
    throw new Error(
      `${label} handle mismatch: explicit ${normalizedExplicit} does not match real GitHub App handle ${resolvedHandle}`
    )
  }
  return resolvedHandle
}

export function resolveExpectedBotLogin(label: string, explicit: string | undefined, resolvedBotLogin: string): string {
  if (!explicit?.trim()) return resolvedBotLogin
  const allowed = new Set(normalizeBotLogins(explicit))
  if (!allowed.has(resolvedBotLogin.toLowerCase())) {
    throw new Error(
      `${label} bot login mismatch: explicit ${explicit.trim()} does not match real GitHub App bot ${resolvedBotLogin}`
    )
  }
  return resolvedBotLogin
}

async function resolveIdentity(key: "codex" | "opencode", env: {
  appIdName: string
  privateKeyName: string
  installationIdName: string
}): Promise<EvalGitHubAppIdentity> {
  const appId = parseRequiredIntEnv(env.appIdName)
  const privateKey = requireEnv(env.privateKeyName)
  const installationId = parseRequiredIntEnv(env.installationIdName)
  const identity = await resolveGithubAppIdentity({
    githubAppId: appId,
    githubPrivateKey: privateKey
  })

  const slug = identity?.slug?.trim()
  const botLogin = identity?.botLogin?.trim()
  if (!slug || !botLogin) {
    throw new Error(`Failed to resolve GitHub App identity for ${key}`)
  }

  return {
    key,
    appId,
    installationId,
    privateKey,
    slug,
    handle: `@${slug}`,
    botLogin
  }
}

export async function resolveRequiredEvalGithubAppsFromEnv(): Promise<{
  codex: EvalGitHubAppIdentity
  opencode: EvalGitHubAppIdentity
}> {
  const codex = await resolveIdentity("codex", {
    appIdName: "CODEBRIDGE_EVAL_GITHUB_APP_ID",
    privateKeyName: "CODEBRIDGE_EVAL_GITHUB_PRIVATE_KEY",
    installationIdName: "CODEBRIDGE_EVAL_GITHUB_INSTALLATION_ID"
  })
  const opencode = await resolveIdentity("opencode", {
    appIdName: "CODEBRIDGE_EVAL_OPENCODE_GITHUB_APP_ID",
    privateKeyName: "CODEBRIDGE_EVAL_OPENCODE_GITHUB_PRIVATE_KEY",
    installationIdName: "CODEBRIDGE_EVAL_OPENCODE_GITHUB_INSTALLATION_ID"
  })

  assertDistinctEvalGithubApps({ codex, opencode })
  return { codex, opencode }
}
