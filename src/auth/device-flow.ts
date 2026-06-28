import chalk from "chalk";
import open from "open";
import ora from "ora";
import { z } from "zod";

import { readPackageInfo } from "../package.js";
import { writeConfig } from "./config.js";
import {
  computeHostnameHash,
  computeMachineId,
  detectOs,
} from "./machine.js";

const startResponseSchema = z.object({
  deviceCode: z.string(),
  expiresIn: z.number().int().positive(),
  interval: z.number().positive(),
  userCode: z.string(),
  verificationUri: z.string().url(),
  verificationUriComplete: z.string().url(),
});

const pollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("slow_down") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("approved"),
    token: z.string().regex(/^cu_live_[a-f0-9]{48}$/),
    userId: z.string(),
    username: z.string().nullable(),
  }),
]);

const packageInfo = readPackageInfo(import.meta.url);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDeviceFlow(apiBase: string): Promise<string> {
  const startResponse = await fetch(`${apiBase}/api/cli/auth/start`, {
    body: JSON.stringify({
      cliVersion: packageInfo.version,
      hostnameHash: computeHostnameHash(),
      machineId: computeMachineId(),
      os: detectOs(),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!startResponse.ok) {
    throw new Error(`device auth start failed: ${startResponse.status}`);
  }

  const start = startResponseSchema.parse(await startResponse.json());

  console.log("");
  console.log(chalk.bold("authorize this device:"));
  console.log(`  ${chalk.hex("#d97757")(start.verificationUriComplete)}`);
  console.log("");
  console.log(
    `${chalk.gray("if the browser does not open, enter code")} ${chalk.bold(
      start.userCode,
    )} ${chalk.gray("at")} ${start.verificationUri}`,
  );
  console.log("");

  await open(start.verificationUriComplete).catch(() => undefined);

  const spinner = ora("waiting for browser approval...").start();
  let intervalMs = Math.max(1000, start.interval * 1000);
  const expiresAt = Date.now() + start.expiresIn * 1000;

  while (Date.now() < expiresAt) {
    await sleep(intervalMs);

    const pollResponse = await fetch(`${apiBase}/api/cli/auth/poll`, {
      body: JSON.stringify({ deviceCode: start.deviceCode }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const parsed = pollResponseSchema.safeParse(
      await pollResponse.json().catch(() => ({})),
    );

    if (!parsed.success) {
      spinner.fail("unexpected server response");
      throw new Error("bad poll response");
    }

    if (parsed.data.status === "pending") {
      continue;
    }

    if (parsed.data.status === "slow_down") {
      intervalMs = Math.min(intervalMs * 2, 30_000);
      continue;
    }

    if (parsed.data.status === "denied") {
      spinner.fail("denied in the browser");
      throw new Error("device authorization denied");
    }

    if (parsed.data.status === "expired") {
      spinner.fail("approval code expired");
      throw new Error("device authorization expired");
    }

    spinner.succeed(
      `authorized as ${chalk.hex("#d97757")(
        parsed.data.username ?? parsed.data.userId,
      )}`,
    );
    await writeConfig({ apiBase, token: parsed.data.token });
    return parsed.data.token;
  }

  spinner.fail("approval timed out");
  throw new Error("device authorization timed out");
}
