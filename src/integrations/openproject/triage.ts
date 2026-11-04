export const TRIAGE_CONCLUSIONS = ['lỗi', 'không phải lỗi', 'thiếu thông tin', 'yêu cầu tính năng', 'việc thủ công'] as const;
export const TRIAGE_SIZES = ['nhỏ', 'vừa', 'lớn (cần chia)'] as const;

export type TriageConclusion = typeof TRIAGE_CONCLUSIONS[number];
export type TriageSize = typeof TRIAGE_SIZES[number];

export interface TriageAnalysis {
  conclusion: TriageConclusion;
  size: TriageSize;
  repo: string[];
  summary: string;
  evidence: string;
  cause: string;
  proposal: string;
  risks: string;
  questions: string;
  manualAssessment?: string;
  serverChecklist?: string;
  draftReply?: string;
  manualAlongside?: string;
  perRepo?: string;
}

function section(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^#{2,3}\s/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim();
}

export function parseTriageAnalysis(report: string): { analysis?: TriageAnalysis; errors: string[] } {
  const errors: string[] = [];
  const conclusion = (report.match(/^Kết luận:\s*(.+)$/im)?.[1] || '').trim().toLowerCase() as TriageConclusion;
  const size = (report.match(/^Độ lớn:\s*(.+)$/im)?.[1] || '').trim().toLowerCase() as TriageSize;
  const repo = (report.match(/^Repo:\s*(.+)$/im)?.[1] || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!TRIAGE_CONCLUSIONS.includes(conclusion)) errors.push('Kết luận thiếu hoặc không hợp lệ');
  if (!TRIAGE_SIZES.includes(size)) errors.push('Độ lớn thiếu hoặc không hợp lệ');
  if (repo.length === 0) errors.push('Repo thiếu hoặc rỗng');
  const fields: Array<[keyof TriageAnalysis, string]> = [
    ['summary', '### Tóm tắt yêu cầu'], ['evidence', '### Bằng chứng'], ['cause', '### Nguyên nhân dự kiến'],
    ['proposal', '### Hướng sửa đề xuất (và phương án nếu có nhiều)'], ['risks', '### Rủi ro / ảnh hưởng'],
    ['questions', '### Câu hỏi cho tester (nếu thiếu thông tin)'],
  ];
  const values = Object.fromEntries(fields.map(([key, heading]) => [key, section(report, heading)])) as Partial<TriageAnalysis>;
  for (const [key] of fields) if (!values[key]) errors.push(`${key} thiếu hoặc rỗng`);
  if (errors.length > 0) return { errors };
  return {
    errors,
    analysis: {
      conclusion, size, repo, summary: values.summary!, evidence: values.evidence!, cause: values.cause!,
      proposal: values.proposal!, risks: values.risks!, questions: values.questions!,
      manualAssessment: section(report, '### Nhận định ban đầu') || undefined,
      serverChecklist: section(report, '### Checklist kiểm tra trên server') || undefined,
      draftReply: section(report, '### Nháp tin nhắn/trả lời') || undefined,
      manualAlongside: section(report, '### Việc thủ công kèm theo') || undefined,
      perRepo: section(report, '### Phần việc theo repo') || undefined,
    },
  };
}

export function isTriageTaskSlug(slug: string): boolean {
  return /-triage(?:-r\d+)?$/.test(slug);
}

export function shouldAutoDispatch(analysis: TriageAnalysis): boolean {
  return analysis.conclusion === 'lỗi' && (analysis.size === 'nhỏ' || analysis.size === 'vừa');
}

export function analysisMarkdown(analysis: TriageAnalysis): string {
  return [
    `Kết luận: ${analysis.conclusion}`,
    `Độ lớn: ${analysis.size}`,
    `Repo: ${analysis.repo.join(', ')}`,
    '', '### Tóm tắt yêu cầu', analysis.summary,
    '', '### Bằng chứng', analysis.evidence,
    '', '### Nguyên nhân dự kiến', analysis.cause,
    '', '### Hướng sửa đề xuất (và phương án nếu có nhiều)', analysis.proposal,
    '', '### Rủi ro / ảnh hưởng', analysis.risks,
    '', '### Câu hỏi cho tester (nếu thiếu thông tin)', analysis.questions,
    ...(analysis.perRepo ? ['', '### Phần việc theo repo', analysis.perRepo] : []),
    ...(analysis.manualAssessment ? ['', '### Nhận định ban đầu', analysis.manualAssessment] : []),
    ...(analysis.serverChecklist ? ['', '### Checklist kiểm tra trên server', analysis.serverChecklist] : []),
    ...(analysis.draftReply ? ['', '### Nháp tin nhắn/trả lời', analysis.draftReply] : []),
    ...(analysis.manualAlongside ? ['', '### Việc thủ công kèm theo', analysis.manualAlongside] : []),
  ].join('\n');
}
