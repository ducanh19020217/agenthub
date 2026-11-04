export type ReviewRoundProject = {
  review?: string | null;
};

export type ReviewRoundConfig = {
  reviewer?: {
    maxChangesRequested?: number;
  };
};

export function reviewMaxRoundsFor(
  project: ReviewRoundProject | undefined,
  config: ReviewRoundConfig,
): number {
  if (project?.review) {
    try {
      const value = JSON.parse(project.review) as { maxRounds?: unknown };
      if (typeof value.maxRounds === 'number' && value.maxRounds > 0) return value.maxRounds;
    } catch {
      // Invalid project settings use the documented default.
    }
    return 2;
  }
  return config.reviewer?.maxChangesRequested || 2;
}
