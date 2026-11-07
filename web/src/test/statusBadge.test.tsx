import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../components/StatusBadge';
import { LocaleProvider } from '../context/LocaleContext';

describe('StatusBadge Component', () => {
  it('hiển thị đúng nhãn tiếng Việt cho từng trạng thái', () => {
    const { rerender } = render(<StatusBadge status="running" />);
    expect(screen.getByText('Đang chạy')).toBeInTheDocument();

    rerender(<StatusBadge status="checking" />);
    expect(screen.getByText('Đang kiểm tra')).toBeInTheDocument();

    rerender(<StatusBadge status="review" />);
    expect(screen.getByText('Chờ duyệt')).toBeInTheDocument();

    rerender(<StatusBadge status="done" />);
    expect(screen.getByText('Hoàn thành')).toBeInTheDocument();

    rerender(<StatusBadge status="pushed" />);
    expect(screen.getByText('Đã đẩy git')).toBeInTheDocument();

    rerender(<StatusBadge status="waiting_quota" />);
    expect(screen.getByText('Đang chờ')).toBeInTheDocument();

    rerender(<StatusBadge status="blocked" />);
    expect(screen.getByText('Bị chặn')).toBeInTheDocument();

    rerender(<StatusBadge status="failed" />);
    expect(screen.getByText('Lỗi')).toBeInTheDocument();
  });

  it('hiển thị đúng nhãn tiếng Việt và style cho từng waitReason', () => {
    const { rerender } = render(
      <StatusBadge status="waiting_quota" waitReason="disk" diskFreeGB={2.4} diskMinFreeGB={5} />
    );
    expect(screen.getByText('Chờ ổ đĩa (còn 2.4 GB / cần 5 GB)')).toBeInTheDocument();
    const diskBadge = screen.getByTestId('status-badge-waiting_quota');
    expect(diskBadge.getAttribute('data-wait-reason')).toBe('disk');
    expect(diskBadge.style.backgroundColor).toContain('var(--wait-disk-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="disk" />);
    expect(screen.getByText('Chờ ổ đĩa')).toBeInTheDocument();

    rerender(<StatusBadge status="waiting_quota" waitReason="quota" />);
    expect(screen.getByText('Chờ quota model')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-waiting_quota').getAttribute('data-wait-reason')).toBe('quota');
    expect(screen.getByTestId('status-badge-waiting_quota').style.backgroundColor).toContain('var(--wait-quota-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="parallel" />);
    expect(screen.getByText('Chờ slot song song')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-waiting_quota').getAttribute('data-wait-reason')).toBe('parallel');
    expect(screen.getByTestId('status-badge-waiting_quota').style.backgroundColor).toContain('var(--wait-parallel-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="profile_busy" />);
    expect(screen.getByText('Chờ tài khoản rảnh')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-waiting_quota').getAttribute('data-wait-reason')).toBe('profile_busy');
    expect(screen.getByTestId('status-badge-waiting_quota').style.backgroundColor).toContain('var(--wait-profile_busy-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="project_unavailable" />);
    expect(screen.getByText('Dự án không truy cập được (ổ chưa mount?)')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-waiting_quota').getAttribute('data-wait-reason')).toBe('project_unavailable');
    expect(screen.getByTestId('status-badge-waiting_quota').style.backgroundColor).toContain('var(--wait-project_unavailable-bg)');

    rerender(<StatusBadge status="queued" waitReason="parallel" />);
    expect(screen.getByText('Chờ slot song song')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-queued').style.backgroundColor).toContain('var(--wait-parallel-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="no_department_profile" />);
    expect(screen.getByText('Chờ tài khoản được gán cho phòng ban')).toBeInTheDocument();
    const noDeptBadge = screen.getByTestId('status-badge-waiting_quota');
    expect(noDeptBadge.getAttribute('data-wait-reason')).toBe('no_department_profile');
    expect(noDeptBadge.style.backgroundColor).toContain('var(--wait-no_department_profile-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="no_matching_profile" />);
    expect(screen.getByText('Chờ tài khoản/model phù hợp')).toBeInTheDocument();
    const noMatchBadge = screen.getByTestId('status-badge-waiting_quota');
    expect(noMatchBadge.getAttribute('data-wait-reason')).toBe('no_matching_profile');
    expect(noMatchBadge.style.backgroundColor).toContain('var(--wait-no_matching_profile-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="slot" />);
    expect(screen.getByText('Chờ slot chạy')).toBeInTheDocument();
    const slotBadge = screen.getByTestId('status-badge-waiting_quota');
    expect(slotBadge.getAttribute('data-wait-reason')).toBe('slot');
    expect(slotBadge.style.backgroundColor).toContain('var(--wait-slot-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="load" />);
    expect(screen.getByText('Chờ giảm tải máy')).toBeInTheDocument();
    const loadBadge = screen.getByTestId('status-badge-waiting_quota');
    expect(loadBadge.getAttribute('data-wait-reason')).toBe('load');
    expect(loadBadge.style.backgroundColor).toContain('var(--wait-load-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="dependency" />);
    expect(screen.getByText('Chờ task phụ thuộc')).toBeInTheDocument();
    const depBadge = screen.getByTestId('status-badge-waiting_quota');
    expect(depBadge.getAttribute('data-wait-reason')).toBe('dependency');
    expect(depBadge.style.backgroundColor).toContain('var(--wait-dependency-bg)');

    rerender(
      <StatusBadge
        status="waiting_quota"
        waitReason="disk"
        diskLabel="Dữ liệu hub (~/.agenthub)"
        diskFreeGB={0.5}
        diskMinFreeGB={1}
      />
    );
    expect(screen.getByText('Ổ chứa dữ liệu hub (~/.agenthub) sắp đầy (còn 0.5 GB / cần 1 GB)')).toBeInTheDocument();

    rerender(
      <StatusBadge
        status="waiting_quota"
        waitReason="disk"
        blockingDisk={{
          path: '/media/veracrypt8/agenthub-worktrees',
          label: 'Worktrees (/media/veracrypt8/agenthub-worktrees)',
          freeGB: 0.7,
          minFreeGB: 3,
        }}
      />
    );
    expect(screen.getByText('Chờ Worktrees (/media/veracrypt8/agenthub-worktrees) (còn 0.7 GB / cần 3 GB)')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-waiting_quota').getAttribute('title')).toBe('/media/veracrypt8/agenthub-worktrees');

    rerender(
      <StatusBadge
        status="waiting_quota"
        waitReason="disk"
        blockingDisk={{
          path: '/home/user/.agenthub',
          label: 'Ổ chứa dữ liệu hub (~/.agenthub)',
          freeGB: 0.3,
          minFreeGB: 1,
        }}
      />
    );
    expect(screen.getByText('Ổ chứa dữ liệu hub (~/.agenthub) sắp đầy (còn 0.3 GB / cần 1 GB)')).toBeInTheDocument();
  });

  it('hiển thị đúng nhãn tiếng Anh (en) cho các waitReason mới', () => {
    const { rerender } = render(
      <LocaleProvider initialLocale="en">
        <StatusBadge status="waiting_quota" waitReason="no_department_profile" />
      </LocaleProvider>
    );
    expect(screen.getByText('Waiting for an account assigned to this department')).toBeInTheDocument();

    rerender(
      <LocaleProvider initialLocale="en">
        <StatusBadge status="waiting_quota" waitReason="no_matching_profile" />
      </LocaleProvider>
    );
    expect(screen.getByText('Waiting for a matching account/model')).toBeInTheDocument();

    rerender(
      <LocaleProvider initialLocale="en">
        <StatusBadge status="waiting_quota" waitReason="slot" />
      </LocaleProvider>
    );
    expect(screen.getByText('Waiting for slot')).toBeInTheDocument();

    rerender(
      <LocaleProvider initialLocale="en">
        <StatusBadge status="waiting_quota" waitReason="load" />
      </LocaleProvider>
    );
    expect(screen.getByText('Waiting for machine load')).toBeInTheDocument();

    rerender(
      <LocaleProvider initialLocale="en">
        <StatusBadge status="waiting_quota" waitReason="dependency" />
      </LocaleProvider>
    );
    expect(screen.getByText('Waiting for dependency')).toBeInTheDocument();

    rerender(
      <LocaleProvider initialLocale="en">
        <StatusBadge
          status="waiting_quota"
          waitReason="disk"
          diskLabel="Dữ liệu hub (~/.agenthub)"
          diskFreeGB={0.5}
          diskMinFreeGB={1}
        />
      </LocaleProvider>
    );
    expect(screen.getByText('Hub data drive (~/.agenthub) almost full (0.5 GB free / 1 GB needed)')).toBeInTheDocument();
  });
});
