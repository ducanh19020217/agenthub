export interface SplitPart {
  index: number;
  title: string;
  project: string;
  level: 'easy' | 'hard';
  dependsOn: number[];
  description: string;
}

export interface SplitPlan {
  parts: SplitPart[];
  source: 'done' | 'blocked';
}

export interface SplitPlanResult {
  plan?: SplitPlan;
  errors: string[];
}

const PART_RE = /^###\s+(\d+)\.(?:\s*(.*))?$/;

function field(lines: string[], name: string): string | undefined {
  const line = lines.find((item) => new RegExp(`^-\\s*${name}:`, 'i').test(item.trim()));
  return line?.replace(new RegExp(`^-\\s*${name}:`, 'i'), '').trim();
}

/** Parse the worker-facing ## Chia việc section without throwing on bad reports. */
export function parseSplitPlan(
  report: string | null | undefined,
  maxParts = 5,
  defaultProject = 'primary',
  sourceKind: 'done' | 'blocked' = 'done',
): SplitPlanResult {
  if (!report) return { errors: ['Thiếu báo cáo để đọc ## Chia việc'] };
  const heading = /^##\s+Chia việc\s*$/im.exec(report);
  if (!heading) return { errors: ['Thiếu mục ## Chia việc'] };
  const section = report.slice(heading.index + heading[0].length).split(/^##\s/m)[0];
  const lines = section.split(/\r?\n/);
  const starts = lines.map((line, index) => ({ line, index })).filter(({ line }) => PART_RE.test(line.trim()));
  if (starts.length < 1) return { errors: ['## Chia việc phải có ít nhất 1 việc con'] };
  if (starts.length > maxParts) return { errors: [`Kế hoạch có ${starts.length} phần; hãy gộp lại tối đa ${maxParts} phần`] };
  const errors: string[] = [];
  const parts: SplitPart[] = [];
  for (let i = 0; i < starts.length; i++) {
    const current = starts[i];
    const next = starts[i + 1]?.index ?? lines.length;
    const match = PART_RE.exec(current.line.trim());
    if (!match) continue;
    const body = lines.slice(current.index + 1, next);
    const index = Number(match[1]);
    const title = (match[2] || '').trim();
    const project = field(body, 'project') || defaultProject;
    const rawLevel = (field(body, 'level') || 'easy').toLowerCase();
    const level = rawLevel === 'hard' ? 'hard' : 'easy';
    const rawDeps = field(body, 'phụ thuộc') || field(body, 'depends on') || '';
    const dependsOn = rawDeps && !/^[-–—]?\s*(không|none|0)\s*$/i.test(rawDeps)
      ? rawDeps.split(/[,\s]+/).map(Number).filter((item) => Number.isInteger(item) && item > 0)
      : [];
    const description = body
      .filter((line) => !/^\s*-\s*(project|level|phụ thuộc|depends on):/i.test(line))
      .join('\n').trim();
    if (!title) errors.push(`Việc ${index} thiếu tiêu đề`);
    if (index !== i + 1) errors.push(`Số thứ tự việc con phải liên tục, gặp ${index} ở vị trí ${i + 1}`);
    if (!description) errors.push(`Việc ${index} thiếu mô tả`);
    parts.push({ index, title, project, level, dependsOn, description });
  }
  const known = new Set(parts.map((part) => part.index));
  for (const part of parts) for (const dep of part.dependsOn) if (!known.has(dep)) errors.push(`Việc ${part.index} phụ thuộc vào số không tồn tại: ${dep}`);
  return errors.length ? { errors } : { plan: { parts, source: sourceKind }, errors: [] };
}

export function splitSection(report: string | null | undefined): string | null {
  if (!report) return null;
  const match = /^##\s+Chia việc\s*$/im.exec(report);
  if (!match) return null;
  const afterHeader = report.slice(match.index + match[0].length);
  const nextHeading = afterHeader.search(/^##\s/m);
  const sectionContent = nextHeading === -1 ? afterHeader : afterHeader.slice(0, nextHeading);
  return (match[0] + sectionContent).trim();
}
