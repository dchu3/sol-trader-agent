import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setVerbose } from "./logger.js";

/** Prompt for input (always visible, even for secret fields). */
async function question(rl: readline.Interface, prompt: string): Promise<string> {
  return rl.question(prompt);
}

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

/** Validate a field value. Returns an error message or null if valid. */
function validateField(key: string, value: string): string | null {
  if (value === "") return null; // Empty is handled by required check elsewhere

  switch (key) {
    case "REMOTE_MCP_URL": {
      try {
        const url = new URL(value);
        if (url.protocol === "https:") return null;
        if (
          url.protocol === "http:" &&
          (url.hostname === "localhost" ||
            url.hostname === "127.0.0.1" ||
            url.hostname === "[::1]")
        ) {
          return null;
        }
        return "Must use https:// (http:// only allowed for localhost/127.0.0.1/[::1])";
      } catch {
        return "Must be a valid URL";
      }
    }
    case "TELEGRAM_CHAT_ID": {
      const num = Number(value);
      if (!Number.isInteger(num) || num === 0) {
        return "Must be a valid non-zero integer";
      }
      return null;
    }
    case "VERBOSE":
      if (!["true", "false", "1", "0"].includes(value)) {
        return "Must be true, false, 1, or 0";
      }
      return null;
    default:
      return null;
  }
}

/** Mask a secret value for display, showing first 4 and last 4 chars. */
function maskValue(value: string): string {
  if (value.length <= 10) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** Find the .env file path (project root). */
function findEnvPath(): string {
  // Walk up from dist/ to find the project root containing package.json
  let dir = path.dirname(fileURLToPath(import.meta.url));
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

/** Strip matching surrounding quotes (single or double) to match dotenv's parsing. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
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
        const value = stripQuotes(raw.slice(eqIdx + 1).trim());
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

/** Quote a value for .env if it contains characters that dotenv would misinterpret. */
function quoteEnvValue(value: string): string {
  if (value.includes("#") || value.includes("'") || value.includes('"') || value.includes("`")) {
    // Use double quotes; escape any embedded double quotes and backslashes
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
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
      const quoted = quoteEnvValue(newValue);
      return { ...line, raw: `${line.key}=${quoted}`, value: newValue };
    }
    return line;
  });

  // Append any new keys not already in the file
  for (const [key, value] of values) {
    if (!writtenKeys.has(key) && value !== "") {
      const quoted = quoteEnvValue(value);
      updatedLines.push({ type: "blank", raw: "" });
      updatedLines.push({ type: "assignment", raw: `${key}=${quoted}`, key, value });
    }
  }

  const output = updatedLines.map((l) => l.raw).join("\n");
  const content = output.endsWith("\n") ? output : output + "\n";

  // Atomic write: temp file + rename to prevent data loss on interruption
  const tmpPath = `${envPath}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Some platforms/filesystems (e.g. Windows) don't support POSIX chmod; ignore.
  }
  fs.renameSync(tmpPath, envPath);
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
      choice = await rl.question("  Select setting number (0 to finish):");
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

      const prompt = v.secret
        ? `  New value (Enter to keep, "clear" to remove):`
        : `  New value (Enter to keep, "clear" to remove):`;

      let newValue: string;
      try {
        newValue = await question(rl, prompt);
      } catch {
        break;
      }

      const trimmed = newValue.trim();
      if (trimmed === "") {
        // Keep existing value
        continue;
      }

      // Check "clear" sentinel on raw input before prefix-stripping
      if (trimmed.toLowerCase() === "clear") {
        if (v.required) {
          console.log(`  ⚠️  ${v.key} is required and cannot be cleared.`);
          continue;
        }
        updatedValues.set(v.key, "");
        changed = true;
        console.log(`  ✓ ${v.key} cleared`);
      } else {
        // Auto-strip key prefix when user pastes KEY=VALUE or KEY:VALUE
        const prefixPattern = new RegExp(`^${v.key}[=:]\\s*`);
        const stripped = trimmed.replace(prefixPattern, "");

        if (stripped === "") {
          // Pasted KEY= or KEY: with empty value — treat as clear
          if (v.required) {
            console.log(`  ⚠️  ${v.key} is required and cannot be cleared.`);
            continue;
          }
          updatedValues.set(v.key, "");
          changed = true;
          console.log(`  ✓ ${v.key} cleared`);
          continue;
        }
        const error = validateField(v.key, stripped);
        if (error) {
          console.log(`  ❌ Invalid: ${error}`);
          continue;
        }
        updatedValues.set(v.key, stripped);
        changed = true;
        console.log(`  ✓ ${v.key} updated`);
      }
    }
  }

  if (changed) {
    // Verify required fields are present before saving
    const missingRequired = ENV_VARS.filter(
      (v) => v.required && !(updatedValues.get(v.key) ?? ""),
    );
    if (missingRequired.length > 0) {
      console.log("\n  ❌ Cannot save — the following required fields are missing:");
      for (const v of missingRequired) {
        console.log(`     • ${v.label} (${v.key})`);
      }
      console.log("  Please set them before saving.\n");
      return false;
    }

    writeEnvFile(envPath, updatedValues);
    console.log(`\n  ✅ Changes saved to ${envPath}`);

    // Warn if Telegram bot is enabled without chat ID restriction
    const botToken = updatedValues.get("TELEGRAM_BOT_TOKEN") ?? "";
    const chatId = updatedValues.get("TELEGRAM_CHAT_ID") ?? "";
    if (botToken && !chatId) {
      console.log("  ⚠️  TELEGRAM_BOT_TOKEN is set without TELEGRAM_CHAT_ID — the bot will accept messages from ANY user.");
      console.log("     Strongly recommended: set TELEGRAM_CHAT_ID to restrict access.");
    }

    // Apply VERBOSE live if it changed
    const newVerbose = updatedValues.get("VERBOSE");
    if (newVerbose !== currentValues.get("VERBOSE")) {
      const verboseEnabled = newVerbose === "true" || newVerbose === "1";
      setVerbose(verboseEnabled);
      console.log(`  ✓ Verbose logging ${verboseEnabled ? "enabled" : "disabled"} (applied immediately)`);
    }
  } else {
    console.log("\n  No changes made.");
  }

  console.log("");
  return changed;
}
