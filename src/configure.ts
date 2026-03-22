import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { setVerbose, isVerbose } from "./logger.js";

/** Env variable definition for the configure menu. */
interface EnvVar {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
}

const ENV_VARS: EnvVar[] = [
  { key: "GEMINI_API_KEY", label: "Gemini API key", required: true, secret: true },
  { key: "REMOTE_MCP_URL", label: "Remote MCP server URL", required: true, secret: false },
  { key: "SOLANA_PRIVATE_KEY", label: "Solana wallet private key", required: true, secret: true },
  { key: "GEMINI_MODEL", label: "Gemini model", required: false, secret: false },
  { key: "SOLANA_RPC_URL", label: "Solana RPC URL", required: false, secret: false },
  { key: "DEX_TRADER_MCP_PATH", label: "dex-trader-mcp path", required: false, secret: false },
  { key: "JUPITER_API_BASE", label: "Jupiter API base URL", required: false, secret: false },
  { key: "JUPITER_API_KEY", label: "Jupiter API key", required: false, secret: true },
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", required: false, secret: true },
  { key: "TELEGRAM_CHAT_ID", label: "Telegram chat ID", required: false, secret: false },
  { key: "VERBOSE", label: "Verbose/debug logging", required: false, secret: false },
];

/** Mask a secret value for display, showing first 4 and last 4 chars. */
function maskValue(value: string): string {
  if (value.length <= 10) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** Find the .env file path (project root). */
function findEnvPath(): string {
  // Walk up from dist/ to find the project root with .env or .env.example
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return path.join(dir, ".env");
    }
    dir = path.dirname(dir);
  }
  // Fallback: current working directory
  return path.join(process.cwd(), ".env");
}

/** Parse a .env file into an ordered list of lines (preserving structure). */
interface EnvLine {
  type: "assignment" | "comment" | "blank";
  raw: string;
  key?: string;
  value?: string;
}

function parseEnvFile(content: string): EnvLine[] {
  const lines: EnvLine[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      lines.push({ type: "blank", raw });
    } else if (trimmed.startsWith("#")) {
      lines.push({ type: "comment", raw });
    } else {
      const eqIdx = raw.indexOf("=");
      if (eqIdx !== -1) {
        const key = raw.slice(0, eqIdx).trim();
        const value = raw.slice(eqIdx + 1).trim();
        lines.push({ type: "assignment", raw, key, value });
      } else {
        lines.push({ type: "comment", raw });
      }
    }
  }
  return lines;
}

/** Read current .env values as a key-value map. */
function readCurrentValues(envPath: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!fs.existsSync(envPath)) return values;

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of parseEnvFile(content)) {
    if (line.type === "assignment" && line.key) {
      values.set(line.key, line.value ?? "");
    }
  }
  return values;
}

/** Write a key-value map back to .env, preserving existing structure where possible. */
function writeEnvFile(envPath: string, values: Map<string, string>): void {
  const existingContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const lines = existingContent ? parseEnvFile(existingContent) : [];
  const writtenKeys = new Set<string>();

  // Update existing lines in place
  const updatedLines = lines.map((line) => {
    if (line.type === "assignment" && line.key && values.has(line.key)) {
      writtenKeys.add(line.key);
      const newValue = values.get(line.key)!;
      if (newValue === "") {
        // Comment out removed values
        return { ...line, raw: `# ${line.key}=` };
      }
      return { ...line, raw: `${line.key}=${newValue}`, value: newValue };
    }
    return line;
  });

  // Append any new keys not already in the file
  for (const [key, value] of values) {
    if (!writtenKeys.has(key) && value !== "") {
      updatedLines.push({ type: "blank", raw: "" });
      updatedLines.push({ type: "assignment", raw: `${key}=${value}`, key, value });
    }
  }

  const output = updatedLines.map((l) => l.raw).join("\n");
  // Ensure file ends with a newline
  fs.writeFileSync(envPath, output.endsWith("\n") ? output : output + "\n", "utf-8");
}

/**
 * Run the interactive /configure menu.
 * Returns true if any changes were saved.
 */
export async function runConfigure(rl: readline.Interface): Promise<boolean> {
  const envPath = findEnvPath();
  const currentValues = readCurrentValues(envPath);

  console.log("\n  ┌─────────────────────────────────────┐");
  console.log("  │       ⚙️  Configure Settings         │");
  console.log("  └─────────────────────────────────────┘\n");

  // Display current settings
  for (let i = 0; i < ENV_VARS.length; i++) {
    const v = ENV_VARS[i];
    const current = currentValues.get(v.key) ?? "";
    const display = current
      ? v.secret
        ? maskValue(current)
        : current
      : "(not set)";
    const tag = v.required ? " [required]" : "";
    console.log(`  ${String(i + 1).padStart(2)}. ${v.label}${tag}`);
    console.log(`      ${v.key} = ${display}`);
  }

  console.log(`\n  ${String(ENV_VARS.length + 1).padStart(2)}. Edit all settings`);
  console.log(`   0. Done (save & exit)\n`);

  let changed = false;
  const updatedValues = new Map(currentValues);

  while (true) {
    let choice: string;
    try {
      choice = await rl.question("  Select setting number (0 to finish): ");
    } catch {
      break;
    }

    const num = parseInt(choice.trim(), 10);
    if (isNaN(num) || num < 0 || num > ENV_VARS.length + 1) {
      console.log("  Invalid selection. Try again.");
      continue;
    }

    if (num === 0) break;

    // "Edit all" option
    const varsToEdit = num === ENV_VARS.length + 1 ? ENV_VARS : [ENV_VARS[num - 1]];

    for (const v of varsToEdit) {
      const current = updatedValues.get(v.key) ?? "";
      const displayCurrent = current
        ? v.secret
          ? maskValue(current)
          : current
        : "(not set)";

      console.log(`\n  ${v.label} (${v.key})`);
      console.log(`  Current: ${displayCurrent}`);

      let newValue: string;
      try {
        newValue = await rl.question(`  New value (Enter to keep, "clear" to remove): `);
      } catch {
        break;
      }

      const trimmed = newValue.trim();
      if (trimmed === "") {
        // Keep existing value
        continue;
      }

      if (trimmed.toLowerCase() === "clear") {
        if (v.required) {
          console.log(`  ⚠️  ${v.key} is required and cannot be cleared.`);
          continue;
        }
        updatedValues.set(v.key, "");
        changed = true;
        console.log(`  ✓ ${v.key} cleared`);
      } else {
        updatedValues.set(v.key, trimmed);
        changed = true;
        console.log(`  ✓ ${v.key} updated`);
      }
    }
  }

  if (changed) {
    writeEnvFile(envPath, updatedValues);
    console.log(`\n  ✅ Changes saved to ${envPath}`);

    // Apply VERBOSE live if it changed
    const newVerbose = updatedValues.get("VERBOSE");
    if (newVerbose !== currentValues.get("VERBOSE")) {
      const verboseEnabled = newVerbose === "true" || newVerbose === "1";
      setVerbose(verboseEnabled);
      console.log(`  ✓ Verbose logging ${verboseEnabled ? "enabled" : "disabled"} (applied immediately)`);
    }

    // Check if other settings changed that require restart
    const restartKeys = ENV_VARS.filter((v) => v.key !== "VERBOSE").map((v) => v.key);
    const needsRestart = restartKeys.some(
      (key) => (updatedValues.get(key) ?? "") !== (currentValues.get(key) ?? ""),
    );
    if (needsRestart) {
      console.log("  ⚠️  Some changes require a restart to take effect. Use /quit and restart with npm start.");
    }
  } else {
    console.log("\n  No changes made.");
  }

  console.log("");
  return changed;
}
