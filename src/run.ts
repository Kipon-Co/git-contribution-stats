import { Logger } from "./logger"
import fs from "fs"
import path from "path"
import dotenv from "dotenv"
import { generateGitHubReport } from "./github-contribution-stats"

dotenv.config()

async function main() {
  const appId = process.env.GITHUB_APP_ID
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH

  if (!appId || !privateKeyPath) {
    console.error("Missing required environment variables GITHUB_APP_ID or GITHUB_PRIVATE_KEY_PATH")
    process.exit(1)
  }

  const privateKey = fs.readFileSync(path.resolve(privateKeyPath), "utf8")

  const result = await generateGitHubReport({
    app_id: parseInt(appId, 10),
    private_key: privateKey,
    days_to_look_back: 7,
    logger: new Logger({ level: "debug", scope: ["Runner"] }),
  })

  console.log("\n--- SUMMARY ---\n")
  console.log(result.summary)

  console.log("\n--- DETAILS ---\n")
  console.dir(result.detailed_results, { depth: null })
}

main().catch(err => {
  console.error("Unhandled error:", err)
})