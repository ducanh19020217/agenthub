import { describe, expect, it } from 'vitest';
import { parseTriageAnalysis, shouldAutoDispatch } from '../src/integrations/openproject/triage.js';

const report = `Kết luận: lỗi
Độ lớn: vừa
Repo: web

### Tóm tắt yêu cầu
Nút không hoạt động.

### Bằng chứng
Đã tái hiện bằng test.

### Nguyên nhân dự kiến
Handler thiếu nhánh.

### Hướng sửa đề xuất (và phương án nếu có nhiều)
Thêm nhánh xử lý.

### Rủi ro / ảnh hưởng
Ảnh hưởng nút liên quan.

### Câu hỏi cho tester (nếu thiếu thông tin)
Không có.
`;

describe('OpenProject triage analysis', () => {
  it('parses the fixed DONE format and recognizes auto-dispatch cases', () => {
    const result = parseTriageAnalysis(report);
    expect(result.errors).toEqual([]);
    expect(result.analysis?.repo).toEqual(['web']);
    expect(shouldAutoDispatch(result.analysis!)).toBe(true);
  });

  it('reports missing fields instead of accepting an incomplete report', () => {
    const result = parseTriageAnalysis('Kết luận: lỗi\nĐộ lớn: vừa\nRepo: web');
    expect(result.analysis).toBeUndefined();
    expect(result.errors).toEqual(expect.arrayContaining(['summary thiếu hoặc rỗng', 'evidence thiếu hoặc rỗng']));
  });

  it('does not auto-dispatch non-bug conclusions', () => {
    const result = parseTriageAnalysis(report.replace('Kết luận: lỗi', 'Kết luận: không phải lỗi'));
    expect(result.analysis).toBeDefined();
    expect(shouldAutoDispatch(result.analysis!)).toBe(false);
  });

  it('rejects unknown conclusion and size values', () => {
    const result = parseTriageAnalysis(report.replace('Kết luận: lỗi', 'Kết luận: maybe').replace('Độ lớn: vừa', 'Độ lớn: khổng lồ'));
    expect(result.analysis).toBeUndefined();
    expect(result.errors).toEqual(expect.arrayContaining(['Kết luận thiếu hoặc không hợp lệ', 'Độ lớn thiếu hoặc không hợp lệ']));
  });
});
