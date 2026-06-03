/**
 * Deployment tools — array export with two related tools in one file.
 *
 * Demonstrates the array export pattern and child_process usage.
 * Adjust DEPLOY_SCRIPT and ROLLBACK_SCRIPT to your project's scripts.
 * Copy to: ~/.lm-studio-toolbox/plugins/deploy_tools.js
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const DEPLOY_SCRIPT   = "./scripts/deploy.sh";
const ROLLBACK_SCRIPT = "./scripts/rollback.sh";

module.exports = function ({ z }) {
  const envParam = {
    env: z.enum(["staging", "production"]).describe("Target deployment environment"),
  };

  return [
    {
      name: "deploy_app",
      description: "Deploy the current build to the specified environment. Runs the project deploy script.",
      parameters: envParam,
      implementation: async ({ env }) => {
        try {
          const { stdout, stderr } = await execFileAsync("bash", [DEPLOY_SCRIPT, env], { timeout: 120_000 });
          return { success: true, env, output: stdout.trim(), warnings: stderr.trim() || undefined };
        } catch (e) {
          return { success: false, env, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: "rollback_deploy",
      description: "Roll back the last deployment for the specified environment.",
      parameters: envParam,
      implementation: async ({ env }) => {
        try {
          const { stdout, stderr } = await execFileAsync("bash", [ROLLBACK_SCRIPT, env], { timeout: 120_000 });
          return { success: true, env, output: stdout.trim(), warnings: stderr.trim() || undefined };
        } catch (e) {
          return { success: false, env, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
};
