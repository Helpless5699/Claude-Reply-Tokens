import * as path from "node:path";

export function normalizeFsPath(inputPath: string): string {
  const resolved = path.resolve(inputPath).replace(/[\\/]+/g, "/");
  const normalized = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isSameOrSubPath(basePath: string, candidatePath: string): boolean {
  const normalizedBase = normalizeFsPath(basePath);
  const normalizedCandidate = normalizeFsPath(candidatePath);
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(`${normalizedBase}/`)
  );
}

export function workspaceMatchesCwd(workspacePath: string, sessionCwd: string): boolean {
  return (
    isSameOrSubPath(workspacePath, sessionCwd) ||
    isSameOrSubPath(sessionCwd, workspacePath)
  );
}

export function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${formatCompactNumber(value / 1_000_000)}M`;
  }

  if (value >= 1_000) {
    return `${formatCompactNumber(value / 1_000)}k`;
  }

  return `${Math.round(value)}`;
}

function formatCompactNumber(value: number): string {
  if (value >= 100) {
    return value.toFixed(0);
  }

  if (value >= 10) {
    return value.toFixed(1).replace(/\.0$/, "");
  }

  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatExactTokens(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(Math.round(value));
}

export function formatLocalDateTime(timestamp: string, locale?: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

export function debounce<T extends (...args: never[]) => void>(
  callback: T,
  delayMs: number
): (...args: Parameters<T>) => void {
  let timeoutHandle: NodeJS.Timeout | undefined;

  return (...args: Parameters<T>) => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    timeoutHandle = setTimeout(() => {
      timeoutHandle = undefined;
      callback(...args);
    }, delayMs);
  };
}
