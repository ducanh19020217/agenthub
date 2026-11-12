export interface RunnableCapacityEntry {
  profileName: string;
  engine: 'agy' | 'codex';
  family: string;
  model: string;
}

export interface QuotaCapacitySnapshot {
  runnable: RunnableCapacityEntry[];
  nextResetAt: number | null;
  nextReset?: { profileName: string; model: string; at: number };
}

/**
 * Human-readable summary for quota notifications. The source of truth stays
 * in the runnable entries, so callers cannot accidentally describe a family
 * as a system-wide outage while another engine/model is available.
 */
export function formatRunnableCapacity(snapshot: QuotaCapacitySnapshot): string {
  const groups = new Map<string, Set<string>>();
  for (const entry of snapshot.runnable) {
    const label = entry.family === 'codex' ? 'Codex'
      : entry.family === 'gpt' ? 'GPT'
      : entry.family.charAt(0).toUpperCase() + entry.family.slice(1);
    const profiles = groups.get(label) || new Set<string>();
    profiles.add(entry.profileName);
    groups.set(label, profiles);
  }
  return [...groups.entries()].map(([label, profiles]) => {
    const names = [...profiles].sort();
    if (names.length === 1) return `${label} (${names[0]})`;
    return `${label} (${names.length} tài khoản)`;
  }).join(', ');
}
