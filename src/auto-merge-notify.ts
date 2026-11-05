export type AutoMergeSkipReason =
  | 'checks_failed'
  | 'checks_missing'
  | 'escalated'
  | 'chain_incomplete'
  | 'merge_failed'
  | 'auto_merge_disabled';

export function firstCheckError(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((item) => /error|fail(?:ed|ure)?|exception|fatal|assert|npm err|✗/i.test(item)) || lines[0];
  if (!line) return undefined;
  return line
    .replace(/(bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b((?:token|secret|password|passwd|api[_-]?key))\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:gh[pousr]|sk|xox[baprs])-[-\w]+/g, '[redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[redacted]')
    .slice(0, 200);
}

export function autoMergeReasonLabel(reason: unknown): string {
  switch (reason) {
    case 'checks_failed': return 'checks failed';
    case 'checks_missing': return 'checks missing';
    case 'escalated': return 'review escalated';
    case 'chain_incomplete': return 'review chain incomplete';
    case 'merge_failed': return 'merge failed';
    case 'auto_merge_disabled': return 'auto-merge disabled';
    default: return 'unknown reason';
  }
}
