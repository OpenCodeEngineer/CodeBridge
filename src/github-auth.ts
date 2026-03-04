import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"

export type InstallationClient = {
  octokit: Octokit
  token: string
}

export async function createInstallationClient(params: {
  appId: number
  privateKey: string
  installationId: number
}): Promise<InstallationClient> {
  const app = new App({
    appId: params.appId,
    privateKey: params.privateKey
  })
  const auth = await app.octokit.auth({ type: "installation", installationId: params.installationId }) as { token: string }
  const token = auth.token
  const octokit = new Octokit({ auth: token })
  return { octokit, token }
}

export function formatPrivateKey(input: string): string {
  if (input.includes("BEGIN RSA PRIVATE KEY") || input.includes("BEGIN PRIVATE KEY")) {
    return input.replace(/\\n/g, "\n")
  }
  const decoded = Buffer.from(input, "base64").toString("utf8")
  if (decoded.includes("BEGIN RSA PRIVATE KEY") || decoded.includes("BEGIN PRIVATE KEY")) {
    return decoded
  }
  return input.replace(/\\n/g, "\n")
}
