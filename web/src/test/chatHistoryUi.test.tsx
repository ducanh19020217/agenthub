import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatPage } from '../pages/ChatPage';
import { MessageList } from '../components/chat/MessageList';
import { MessageItem } from '../components/chat/MessageItem';
import { SessionList } from '../components/chat/SessionList';
import { ContextMeter } from '../components/chat/ContextMeter';
import { ToolStep } from '../components/chat/ToolStep';
import * as chatApi from '../api/chat';
import * as sse from '../api/sse';
import { ChatMessage, ChatSession } from '../types/api';

describe('c-chat-history-ui Tests', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. MessageList - Tải dần (pagination với before=) và Virtualization', () => {
    it('hiển thị nút / indicator đang tải tin nhắn cũ khi isLoadingMore = true', () => {
      const mockSession: ChatSession = {
        id: 's1',
        title: 'Session 1',
        mode: 'safe',
        busy: false,
        updatedAt: new Date().toISOString(),
      };
      const messages: ChatMessage[] = [
        { id: 'm1', role: 'user', content: 'Tin 1', createdAt: new Date().toISOString() },
        { id: 'm2', role: 'assistant', content: 'Trả lời 1', createdAt: new Date().toISOString() },
      ];

      render(
        <MessageList
          messages={messages}
          activeSession={mockSession}
          hasMore={true}
          isLoadingMore={true}
          onLoadMore={vi.fn()}
        />,
      );

      expect(screen.getByTestId('loading-older-messages')).toBeInTheDocument();
      expect(screen.getByText(/Đang tải thêm tin nhắn cũ…/i)).toBeInTheDocument();
    });

    it('gọi onLoadMore khi cuộn lên gần đầu và hasMore = true', () => {
      const mockSession: ChatSession = {
        id: 's1',
        title: 'Session 1',
        mode: 'safe',
        busy: false,
        updatedAt: new Date().toISOString(),
      };
      const messages: ChatMessage[] = [
        { id: 'm1', role: 'user', content: 'Tin 1', createdAt: new Date().toISOString() },
        { id: 'm2', role: 'assistant', content: 'Trả lời 1', createdAt: new Date().toISOString() },
      ];
      const onLoadMoreMock = vi.fn();

      render(
        <MessageList
          messages={messages}
          activeSession={mockSession}
          hasMore={true}
          isLoadingMore={false}
          onLoadMore={onLoadMoreMock}
        />,
      );

      const container = screen.getByTestId('message-list-container');
      Object.defineProperty(container, 'scrollTop', { value: 10, writable: true });
      Object.defineProperty(container, 'scrollHeight', { value: 500, writable: true });
      Object.defineProperty(container, 'clientHeight', { value: 200, writable: true });

      fireEvent.scroll(container);
      expect(onLoadMoreMock).toHaveBeenCalledTimes(1);
    });

    it('không gọi onLoadMore nếu hasMore = false hoặc đang isLoadingMore', () => {
      const mockSession: ChatSession = {
        id: 's1',
        title: 'Session 1',
        mode: 'safe',
        busy: false,
        updatedAt: new Date().toISOString(),
      };
      const messages: ChatMessage[] = [
        { id: 'm1', role: 'user', content: 'Tin 1', createdAt: new Date().toISOString() },
      ];
      const onLoadMoreMock = vi.fn();

      const { rerender } = render(
        <MessageList
          messages={messages}
          activeSession={mockSession}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={onLoadMoreMock}
        />,
      );

      const container = screen.getByTestId('message-list-container');
      Object.defineProperty(container, 'scrollTop', { value: 5, writable: true });
      fireEvent.scroll(container);
      expect(onLoadMoreMock).not.toHaveBeenCalled();

      // Khi isLoadingMore = true cũng không gọi tiếp
      rerender(
        <MessageList
          messages={messages}
          activeSession={mockSession}
          hasMore={true}
          isLoadingMore={true}
          onLoadMore={onLoadMoreMock}
        />,
      );
      fireEvent.scroll(container);
      expect(onLoadMoreMock).not.toHaveBeenCalled();
    });

    it('hiển thị tin system ("Đã nén ngữ cảnh") trong MessageItem', () => {
      const systemMsg: ChatMessage = {
        id: 'sys-1',
        role: 'system',
        content: 'Đã nén ngữ cảnh',
        createdAt: new Date().toISOString(),
      };
      render(<MessageItem message={systemMsg} />);
      const el = screen.getByTestId('system-message');
      expect(el).toBeInTheDocument();
      expect(el).toHaveTextContent('Đã nén ngữ cảnh');
    });

    it('MessageItem không hiển thị chuỗi ISO thô trong nội dung hiển thị', () => {
      const msg: ChatMessage = {
        id: 'msg-time-check',
        role: 'assistant',
        content: 'Nội dung phản hồi hoàn chỉnh.',
        createdAt: '2026-10-20T10:00:00.000Z',
      };
      const { container } = render(<MessageItem message={msg} />);
      const isoRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
      expect(container.textContent).not.toMatch(isoRegex);
    });
  });

  describe('2. ToolStep - Gộp bước công cụ và hiển thị bước thời gian thực', () => {
    it('gộp 4 công cụ thành một dòng "4 bước đã làm", bấm mở rộng xem chi tiết', () => {
      const tools: ChatMessage[] = [
        { id: 't1', role: 'tool', content: 'Step 1', meta: { name: 'Read', summary: 'Đọc file' }, createdAt: new Date().toISOString() },
        { id: 't2', role: 'tool', content: 'Step 2', meta: { name: 'Edit', summary: 'Sửa code' }, createdAt: new Date().toISOString() },
        { id: 't3', role: 'tool', content: 'Step 3', meta: { name: 'Test', summary: 'Chạy test' }, createdAt: new Date().toISOString() },
        { id: 't4', role: 'tool', content: 'Step 4', meta: { name: 'Git', summary: 'Commit' }, createdAt: new Date().toISOString() },
      ];

      render(<ToolStep messages={tools} isRunning={false} />);

      const button = screen.getByRole('button', { name: /4 bước/i });
      expect(button).toBeInTheDocument();
      expect(screen.queryByText('Đọc file')).not.toBeInTheDocument();

      fireEvent.click(button);
      expect(screen.getByText(/- Đọc file/i)).toBeInTheDocument();
      expect(screen.getByText(/- Sửa code/i)).toBeInTheDocument();
      expect(screen.getByText(/- Chạy test/i)).toBeInTheDocument();
      expect(screen.getByText(/- Commit/i)).toBeInTheDocument();
    });

    it('khi đang chạy (isRunning=true) và chưa mở rộng, hiện bước mới nhất theo thời gian thực', () => {
      const tools: ChatMessage[] = [
        { id: 't1', role: 'tool', content: 'Step 1', meta: { name: 'Read', summary: 'Đọc file' }, createdAt: new Date().toISOString() },
        { id: 't2', role: 'tool', content: 'Step 2', meta: { name: 'RunningStep', summary: 'Đang chạy kiểm thử' }, createdAt: new Date().toISOString() },
      ];

      render(<ToolStep messages={tools} isRunning={true} />);

      expect(screen.getByText(/- Đang chạy kiểm thử/i)).toBeInTheDocument();
      expect(screen.queryByText(/- Đọc file/i)).not.toBeInTheDocument();
    });
  });

  describe('3. SessionList - Thao tác tìm kiếm, ghim, đổi tên, lưu trữ, xoá xác nhận, xuất Markdown', () => {
    const mockSessions: ChatSession[] = [
      { id: 's1', title: 'Phiên A Alpha', mode: 'safe', busy: false, pinned: 0, archived: 0, updatedAt: '2026-10-20T10:00:00Z' },
      { id: 's2', title: 'Phiên B Beta', mode: 'full', busy: false, pinned: 1, archived: 0, updatedAt: '2026-10-20T09:00:00Z' },
      { id: 's3', title: 'Phiên C Lưu trữ', mode: 'safe', busy: false, pinned: 0, archived: 1, updatedAt: '2026-10-20T08:00:00Z' },
    ];

    it('tìm kiếm lọc đúng phiên theo tiêu đề', () => {
      render(
        <SessionList
          sessions={mockSessions}
          activeSessionId="s1"
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={vi.fn()}
        />,
      );

      expect(screen.getByText('Phiên A Alpha')).toBeInTheDocument();
      expect(screen.getByText('Phiên B Beta')).toBeInTheDocument();

      const searchInput = screen.getByPlaceholderText(/Tìm kiếm phiên chat/i);
      fireEvent.change(searchInput, { target: { value: 'Alpha' } });

      expect(screen.getByText('Phiên A Alpha')).toBeInTheDocument();
      expect(screen.queryByText('Phiên B Beta')).not.toBeInTheDocument();
    });

    it('ghim: đưa phiên được ghim lên đầu và gọi onPinSession khi click ghim', () => {
      const onPinMock = vi.fn();
      render(
        <SessionList
          sessions={mockSessions}
          activeSessionId="s1"
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onPinSession={onPinMock}
        />,
      );

      const pinButtons = screen.getAllByRole('button', { name: /Ghim phiên|Bỏ ghim phiên/i });
      expect(pinButtons.length).toBeGreaterThan(0);

      fireEvent.click(pinButtons[0]);
      expect(onPinMock).toHaveBeenCalled();
    });

    it('đổi tên: hiển thị input đổi tên và lưu khi submit', () => {
      const onRenameMock = vi.fn();
      render(
        <SessionList
          sessions={mockSessions}
          activeSessionId="s1"
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onRenameSession={onRenameMock}
        />,
      );

      const renameBtns = screen.getAllByRole('button', { name: /Đổi tên phiên/i });
      fireEvent.click(renameBtns[0]);

      const editInput = screen.getByLabelText(/Tên mới của phiên/i);
      expect(editInput).toBeInTheDocument();

      fireEvent.change(editInput, { target: { value: 'Tên mới sửa' } });
      const saveBtn = screen.getByRole('button', { name: /Lưu tên/i });
      fireEvent.click(saveBtn);

      expect(onRenameMock).toHaveBeenCalledWith('s2', 'Tên mới sửa');
    });

    it('lưu trữ: chuyển giữa tab Hoạt động và Lưu trữ', () => {
      const onArchiveMock = vi.fn();
      render(
        <SessionList
          sessions={mockSessions}
          activeSessionId="s1"
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onArchiveSession={onArchiveMock}
        />,
      );

      expect(screen.getByText('Phiên A Alpha')).toBeInTheDocument();
      expect(screen.queryByText('Phiên C Lưu trữ')).not.toBeInTheDocument();

      const archiveTab = screen.getByRole('button', { name: 'Lưu trữ' });
      fireEvent.click(archiveTab);

      expect(screen.getByText('Phiên C Lưu trữ')).toBeInTheDocument();
      expect(screen.queryByText('Phiên A Alpha')).not.toBeInTheDocument();
    });

    it('xóa có xác nhận: mở modal xác nhận, hủy không xóa, bấm xác nhận mới xóa', () => {
      const onDeleteMock = vi.fn();
      render(
        <SessionList
          sessions={mockSessions}
          activeSessionId="s1"
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={onDeleteMock}
        />,
      );

      const deleteBtns = screen.getAllByRole('button', { name: /Xóa phiên/i });
      fireEvent.click(deleteBtns[0]);

      // Hiện dialog xác nhận
      expect(screen.getByRole('dialog', { name: /Xác nhận xóa phiên/i })).toBeInTheDocument();
      expect(screen.getByText(/Bạn có chắc chắn muốn xóa phiên/i)).toBeInTheDocument();

      // Bấm Hủy
      const cancelBtn = screen.getByRole('button', { name: 'Hủy' });
      fireEvent.click(cancelBtn);
      expect(screen.queryByRole('dialog', { name: /Xác nhận xóa phiên/i })).not.toBeInTheDocument();
      expect(onDeleteMock).not.toHaveBeenCalled();

      // Bấm Xóa lại và Xác nhận xóa
      fireEvent.click(deleteBtns[0]);
      const confirmBtn = screen.getByTestId('confirm-delete-button');
      fireEvent.click(confirmBtn);
      expect(onDeleteMock).toHaveBeenCalledWith('s2');
    });

    it('xuất Markdown: gọi onExportSession khi bấm nút xuất', () => {
      const onExportMock = vi.fn();
      render(
        <SessionList
          sessions={mockSessions}
          activeSessionId="s1"
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onExportSession={onExportMock}
        />,
      );

      const exportBtns = screen.getAllByRole('button', { name: /Xuất Markdown/i });
      expect(exportBtns.length).toBeGreaterThan(0);
      fireEvent.click(exportBtns[0]);
      expect(onExportMock).toHaveBeenCalled();
    });

    it('SessionList hiển thị thời gian định dạng, không có chuỗi ISO thô và có title ISO đầy đủ', () => {
      const { container } = render(
        <SessionList
          sessions={mockSessions}
          activeSessionId="s1"
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={vi.fn()}
        />,
      );

      // Nội dung hiển thị không được chứa chuỗi ISO thô
      const isoRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
      expect(container.textContent).not.toMatch(isoRegex);

      // Tooltip title chứa chuỗi ISO đầy đủ
      const titleSpans = container.querySelectorAll('span[title]');
      const titles = Array.from(titleSpans).map((el) => el.getAttribute('title'));
      expect(titles).toContain('2026-10-20T10:00:00.000Z');
      expect(titles).toContain('2026-10-20T09:00:00.000Z');
    });
  });

  describe('4. ContextMeter - Ngưỡng cảnh báo và Nén ngữ cảnh', () => {
    it('hiển thị % và tổng token khi ngữ cảnh dưới 80%, ẩn nút Nén', () => {
      const session: ChatSession = {
        id: 's-tok',
        title: 'Token Session',
        mode: 'safe',
        busy: false,
        updatedAt: new Date().toISOString(),
        contextTokens: 50000,
        inputTokens: 30000,
        outputTokens: 20000,
      };

      render(<ContextMeter session={session} hasCompactApi={true} />);

      // 50,000 / 200,000 = 25%
      expect(screen.getByText(/25%/)).toBeInTheDocument();
      expect(screen.getByText(/50.000 \/ 200k/i)).toBeInTheDocument();
      expect(screen.getAllByText(/50.000/).length).toBeGreaterThanOrEqual(1);
      // Dưới 80% thì không hiện cảnh báo hay nút Nén
      expect(screen.queryByTestId('compact-button')).not.toBeInTheDocument();
    });

    it('khi ngữ cảnh > 80%: hiện cảnh báo; nếu có API compact thì hiện nút Nén, không có thì ẩn', () => {
      const highSession: ChatSession = {
        id: 's-high',
        title: 'High Context Session',
        mode: 'safe',
        busy: false,
        updatedAt: new Date().toISOString(),
        contextTokens: 170000, // 85%
        inputTokens: 100000,
        outputTokens: 70000,
      };

      const { rerender } = render(
        <ContextMeter session={highSession} hasCompactApi={false} />,
      );

      // 170,000 / 200,000 = 85%
      expect(screen.getByText(/85%/)).toBeInTheDocument();
      expect(screen.getByText(/Ngữ cảnh vượt quá 80%, nên nén phiên/i)).toBeInTheDocument();
      // Chưa có API compact -> ẩn nút
      expect(screen.queryByTestId('compact-button')).not.toBeInTheDocument();

      // Khi có compact API -> hiện nút
      const onCompactMock = vi.fn();
      rerender(
        <ContextMeter
          session={highSession}
          hasCompactApi={true}
          onCompact={onCompactMock}
        />,
      );

      const compactBtn = screen.getByTestId('compact-button');
      expect(compactBtn).toBeInTheDocument();
      fireEvent.click(compactBtn);
      expect(onCompactMock).toHaveBeenCalledTimes(1);
    });

    it('khi ngữ cảnh > 80%: hiện nút Mở phiên mới kèm tóm tắt nếu có onForkSummary', () => {
      const highSession: ChatSession = {
        id: 's-high-fork',
        title: 'High Context Session',
        mode: 'safe',
        busy: false,
        updatedAt: new Date().toISOString(),
        contextTokens: 180000,
        inputTokens: 100000,
        outputTokens: 80000,
      };

      const onForkSummaryMock = vi.fn();
      render(
        <ContextMeter
          session={highSession}
          onForkSummary={onForkSummaryMock}
        />,
      );

      const forkBtn = screen.getByTestId('fork-summary-button');
      expect(forkBtn).toBeInTheDocument();
      fireEvent.click(forkBtn);
      expect(onForkSummaryMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. Trạng thái phiên (idle/running/waiting_permission/error) và nút Dừng / Thử lại', () => {
    it('hiển thị trạng thái running và nút Dừng trong thanh tiêu đề', async () => {
      const runningSession: ChatSession = {
        id: 's-run',
        title: 'Session Đang chạy',
        mode: 'safe',
        busy: true,
        state: 'running',
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue([runningSession]);
      vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue(Object.assign([], { hasMore: false }));
      const stopSpy = vi.spyOn(chatApi, 'stopChatSession').mockResolvedValue({ ok: true });

      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/chat/s-run']}>
            <Routes>
              <Route path="/chat/:sessionId" element={<ChatPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(await screen.findByTestId('session-state-running')).toBeInTheDocument();
      const stopBtn = screen.getByTestId('header-stop-button');
      expect(stopBtn).toBeInTheDocument();

      fireEvent.click(stopBtn);
      await waitFor(() => {
        expect(stopSpy).toHaveBeenCalledWith('s-run');
      });
    });

    it('hiển thị trạng thái error và nút Thử lại trong thanh tiêu đề', async () => {
      const errorSession: ChatSession = {
        id: 's-err',
        title: 'Session Lỗi',
        mode: 'safe',
        busy: false,
        state: 'error',
        updatedAt: new Date().toISOString(),
      };

      const messages: ChatMessage[] = [
        { id: 'u1', role: 'user', content: 'Lệnh cần thử lại', createdAt: new Date().toISOString() },
        { id: 'e1', role: 'error', content: 'Lỗi mạng xảy ra', createdAt: new Date().toISOString() },
      ];

      vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue([errorSession]);
      vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue(Object.assign([...messages], { hasMore: false }));
      const sendSpy = vi.spyOn(chatApi, 'sendChatMessage').mockResolvedValue({
        userMessageId: 'u2',
        assistantMessageId: 'a2',
      });

      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/chat/s-err']}>
            <Routes>
              <Route path="/chat/:sessionId" element={<ChatPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(await screen.findByTestId('session-state-error')).toBeInTheDocument();
      expect(await screen.findByText('Lệnh cần thử lại')).toBeInTheDocument();
      const retryBtn = screen.getByTestId('header-retry-button');
      expect(retryBtn).toBeInTheDocument();

      fireEvent.click(retryBtn);
      await waitFor(() => {
        expect(sendSpy).toHaveBeenCalledWith('s-err', 'Lệnh cần thử lại');
      });
    });

    it('nhấn Enter trên nút Từ chối không bị dialog đổi thành Cho phép', async () => {
      const session: ChatSession = {
        id: 's-permission', title: 'Permission', mode: 'safe', busy: true,
        state: 'waiting_permission', updatedAt: new Date().toISOString(),
      };
      vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue([session]);
      vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue(Object.assign([], { hasMore: false }));
      vi.spyOn(chatApi, 'getChatPermissions').mockResolvedValue([{
        id: 'permission-1', sessionId: session.id, toolName: 'Bash', input: { command: 'echo hi' },
        status: 'pending', createdAt: new Date().toISOString(),
      }]);
      const decideSpy = vi.spyOn(chatApi, 'decideChatPermission').mockResolvedValue({ ok: true });

      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/chat/s-permission']}>
            <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      const deny = await screen.findByRole('button', { name: 'Từ chối' });
      fireEvent.keyDown(deny, { key: 'Enter', code: 'Enter' });
      await userEvent.setup().click(deny);
      expect(decideSpy).toHaveBeenCalledWith('permission-1', 'deny');
      expect(decideSpy).not.toHaveBeenCalledWith('permission-1', 'allow');
    });
  });
});
