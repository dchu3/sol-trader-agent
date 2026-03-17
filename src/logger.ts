let verbose = false;

export function setVerbose(enabled: boolean): void {
  verbose = enabled;
}

export function isVerbose(): boolean {
  return verbose;
}

/** Redact values of sensitive URL query parameters to avoid leaking API keys. */
const SENSITIVE_PARAM_RE =
  /([?&](?:api[-_]?key|key|token|secret|password|auth)=)([^&\s"'{}[\]]*)/gi;

function maskSecrets(message: string): string {
  return message.replace(SENSITIVE_PARAM_RE, "$1***");
}

/** Write a debug message to stderr (only when verbose mode is on). */
export function debug(message: string): void {
  if (verbose) {
    process.stderr.write(`[DEBUG] ${maskSecrets(message)}\n`);
  }
}
