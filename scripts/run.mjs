import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
const runtimeArgs = process.argv.includes("--watch") ? ["--watch"] : [];

if (existsSync(envFile)) runtimeArgs.push(`--env-file=${envFile}`);

const runtime = process.versions.bun ? "Bun" : "Node.js";
console.info(`[launcher] ${runtime}${runtimeArgs.includes("--watch") ? " (watch)" : ""}`);

const child = spawn(process.execPath, [...runtimeArgs, entry], {
  cwd: root,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error("[launcher]", error);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
