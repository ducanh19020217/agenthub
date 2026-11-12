import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkerProgressPanel } from '../components/WorkerProgressPanel';
import { LocaleProvider } from '../context/LocaleContext';

describe('WorkerProgressPanel', () => {
  type WorkerProgressProp = React.ComponentProps<typeof WorkerProgressPanel>['currentRun'];

  const baseRun: NonNullable<WorkerProgressProp> = {
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    activitySource: 'conversation',
    newCommitCount: null,
    lastCommitAt: null,
    changedFileCount: null,
  };

  function renderPanel(currentRun: WorkerProgressProp, logEmpty = true) {
    return render(
      <LocaleProvider initialLocale="vi">
        <WorkerProgressPanel currentRun={currentRun} logEmpty={logEmpty} />
      </LocaleProvider>,
    );
  }

  it('1. Hiển thị thông tin tiến độ worker khi log trống', () => {
    renderPanel(baseRun, true);

    const panel = screen.getByTestId('worker-progress-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.getByText(/Bắt đầu 5 phút trước/i)).toBeInTheDocument();
    expect(screen.getByText(/cập nhật lúc/i)).toBeInTheDocument();
    expect(screen.getByText(/conversation/i)).toBeInTheDocument();
  });

  it('2. Hiển thị số commit mới, thời điểm commit cuối và số file thay đổi', () => {
    const runWithData = {
      ...baseRun,
      newCommitCount: 2,
      lastCommitAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      changedFileCount: 4,
    };
    renderPanel(runWithData, true);

    expect(screen.getByText(/2 commit/i)).toBeInTheDocument();
    expect(screen.getByText(/commit cuối 3 phút trước/i)).toBeInTheDocument();
    expect(screen.getByText(/4 file đang thay đổi/i)).toBeInTheDocument();
  });

  it('3. Ẩn khi log không trống và không có dữ liệu commit/file bổ sung', () => {
    const { container } = renderPanel(baseRun, false);
    expect(container.firstChild).toBeNull();
  });

  it('4. Vẫn hiển thị khi log có dữ liệu nếu có commit hoặc file thay đổi', () => {
    const runWithCommits = {
      ...baseRun,
      newCommitCount: 1,
    };
    renderPanel(runWithCommits, false);
    expect(screen.getByTestId('worker-progress-panel')).toBeInTheDocument();
    expect(screen.getByText(/1 commit/i)).toBeInTheDocument();
  });

  it('5. Ẩn hoàn toàn khi currentRun là null hoặc undefined', () => {
    const { container: c1 } = renderPanel(null, true);
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = renderPanel(undefined, true);
    expect(c2.firstChild).toBeNull();
  });
});
