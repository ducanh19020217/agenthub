import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatPage } from '../pages/ChatPage';
import { ToolChipsGroup } from '../components/chat/ToolChipsGroup';
import { NewSessionModal } from '../components/chat/NewSessionModal';
import { ChatInput } from '../components/chat/ChatInput';
import * as chatApi from '../api/chat';
import * as clientApi from '../api/client';
import * as sse from '../api/sse';
import { ChatMessage, ChatSession } from '../types/api';

describe('Chat với Claude Tests', () => {
  let queryClient: QueryClient;
  let sseCallback: ((event: any) => void) | null = null;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    sseCallback = null;
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation((cb: any) => {
      sseCallback = cb;
      return () => {
        sseCallback = null;
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Gửi tin: ô nhập bị khóa, nhận delta thì chữ được cộng dồn, nhận done thì ô nhập mở lại', async () => {
    const mockSessions: ChatSession[] = [
      {
        id: 's1',
        title: 'Session test 1',
        mode: 'safe',
        busy: false,
        updatedAt: new Date().toISOString(),
      },
    ];

    vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue(mockSessions);
    vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue([]);
    vi.spyOn(chatApi, 'sendChatMessage').mockResolvedValue({
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/chat/s1']}>
          <Routes>
            <Route path="/chat/:sessionId" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Chờ textarea xuất hiện
    const textarea = await screen.findByPlaceholderText(/Nhập tin nhắn/i);
    expect(textarea).toBeInTheDocument();
    expect(textarea).not.toBeDisabled();

    // Nhập tin nhắn và gửi
    fireEvent.change(textarea, { target: { value: 'Xin chào Claude' } });
    const sendButton = screen.getByRole('button', { name: /Gửi/i });

    await act(async () => {
      fireEvent.click(sendButton);
    });

    // Ô nhập bị khóa khi gửi tin và đang xử lý
    expect(textarea).toBeDisabled();

    // Nhận delta 1
    act(() => {
      sseCallback?.({
        type: 'chat.delta',
        payload: {
          sessionId: 's1',
          messageId: 'asst-1',
          text: 'Xin chào bạn! ',
        },
      });
    });

    expect(await screen.findByText(/Xin chào bạn!/)).toBeInTheDocument();
    expect(textarea).toBeDisabled();

    // Nhận delta 2 (cộng dồn vào tin nhắn đang trả lời)
    act(() => {
      sseCallback?.({
        type: 'chat.delta',
        payload: {
          sessionId: 's1',
          messageId: 'asst-1',
          text: 'Tôi là Claude Code.',
        },
      });
    });

    expect(
      await screen.findByText(/Xin chào bạn! Tôi là Claude Code\./),
    ).toBeInTheDocument();
    expect(textarea).toBeDisabled();

    // Nhận done: ô nhập mở lại, hiển thị thống kê lượt
    act(() => {
      sseCallback?.({
        type: 'chat.done',
        payload: {
          sessionId: 's1',
          messageId: 'asst-1',
          durationMs: 12300,
          costUsd: 0.04,
          numTurns: 5,
        },
      });
    });

    await waitFor(() => {
      expect(textarea).not.toBeDisabled();
    });

    // Dòng thống kê nhỏ: "12,3 giây · 5 lượt" (gói thuê bao → không hiện $)
    expect(screen.getByText(/12,3 giây · 5 lượt/)).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.04 ·/)).not.toBeInTheDocument();
  });

  it('2. 409 hiện toast "Claude đang trả lời"', async () => {
    const mockSessions: ChatSession[] = [
      {
        id: 's2',
        title: 'Session test 2',
        mode: 'safe',
        busy: false,
        updatedAt: new Date().toISOString(),
      },
    ];

    vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue(mockSessions);
    vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue([]);
    const err409 = new Error('Claude đang trả lời');
    (err409 as any).status = 409;
    vi.spyOn(chatApi, 'sendChatMessage').mockRejectedValue(err409);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/chat/s2']}>
          <Routes>
            <Route path="/chat/:sessionId" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const textarea = await screen.findByPlaceholderText(/Nhập tin nhắn/i);
    fireEvent.change(textarea, { target: { value: 'Tin nhắn khi đang bận' } });
    const sendButton = screen.getByRole('button', { name: /Gửi/i });

    await act(async () => {
      fireEvent.click(sendButton);
    });

    // Hiện toast "Claude đang trả lời"
    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent('Claude đang trả lời');
  });

  it('3. 5 tool liên tiếp hiện 1 khối "5 bước", bấm vào thì hiện cả 5, khi đang chạy hiện bước mới nhất', () => {
    const fiveTools: ChatMessage[] = [
      { id: 't1', role: 'tool', content: 'Tool 1', meta: { name: 'Tool 1', summary: 'Bước 1' }, createdAt: new Date().toISOString() },
      { id: 't2', role: 'tool', content: 'Tool 2', meta: { name: 'Tool 2', summary: 'Bước 2' }, createdAt: new Date().toISOString() },
      { id: 't3', role: 'tool', content: 'Tool 3', meta: { name: 'Tool 3', summary: 'Bước 3' }, createdAt: new Date().toISOString() },
      { id: 't4', role: 'tool', content: 'Tool 4', meta: { name: 'Tool 4', summary: 'Bước 4' }, createdAt: new Date().toISOString() },
      { id: 't5', role: 'tool', content: 'Tool 5', meta: { name: 'Tool 5', summary: 'Bước 5' }, createdAt: new Date().toISOString() },
    ];

    const { rerender } = render(<ToolChipsGroup messages={fiveTools} isRunning={false} />);

    // 5 tool liên tiếp hiện 1 khối "5 bước", mặc định thu gọn
    const blockButton = screen.getByRole('button', { name: /5 bước/i });
    expect(blockButton).toBeInTheDocument();
    expect(blockButton).toHaveTextContent(/⚙ 5 bước đã làm ▸/);
    expect(screen.queryByText(/Bước 1/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bước 5/i)).not.toBeInTheDocument();

    // Bấm vào thì hiện cả 5
    fireEvent.click(blockButton);
    expect(blockButton).toHaveTextContent(/⚙ 5 bước đã làm ▾/);
    expect(screen.getByText(/Bước 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Bước 2/i)).toBeInTheDocument();
    expect(screen.getByText(/Bước 3/i)).toBeInTheDocument();
    expect(screen.getByText(/Bước 4/i)).toBeInTheDocument();
    expect(screen.getByText(/Bước 5/i)).toBeInTheDocument();

    // Thu gọn lại
    fireEvent.click(blockButton);
    expect(blockButton).toHaveTextContent(/⚙ 5 bước đã làm ▸/);

    // Khi đang chạy và thu gọn: khối cuối cùng hiện bước mới nhất
    rerender(<ToolChipsGroup messages={fiveTools} isRunning={true} />);
    expect(screen.getByText(/Bước 5/i)).toBeInTheDocument();
    expect(screen.queryByText(/Bước 1/i)).not.toBeInTheDocument();
  });

  it('tool xen giữa tin nhắn assistant thì tạo thành các khối riêng', async () => {
    const mockSessions: ChatSession[] = [
      { id: 's3', title: 'Session tool blocks', mode: 'safe', busy: false, updatedAt: new Date().toISOString() },
    ];

    const messagesWithAssistantBetween: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Bắt đầu', createdAt: new Date().toISOString() },
      { id: 't1', role: 'tool', content: 'Tool 1', meta: { name: 'Tool 1', summary: 'Bước 1' }, createdAt: new Date().toISOString() },
      { id: 't2', role: 'tool', content: 'Tool 2', meta: { name: 'Tool 2', summary: 'Bước 2' }, createdAt: new Date().toISOString() },
      { id: 'a1', role: 'assistant', content: 'Tôi đã xem xong bước 1 và 2, tiếp tục nhé.', createdAt: new Date().toISOString() },
      { id: 't3', role: 'tool', content: 'Tool 3', meta: { name: 'Tool 3', summary: 'Bước 3' }, createdAt: new Date().toISOString() },
      { id: 't4', role: 'tool', content: 'Tool 4', meta: { name: 'Tool 4', summary: 'Bước 4' }, createdAt: new Date().toISOString() },
      { id: 't5', role: 'tool', content: 'Tool 5', meta: { name: 'Tool 5', summary: 'Bước 5' }, createdAt: new Date().toISOString() },
    ];

    vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue(mockSessions);
    vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue(messagesWithAssistantBetween);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/chat/s3']}>
          <Routes>
            <Route path="/chat/:sessionId" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Chờ tin nhắn assistant và 2 khối tool xuất hiện
    expect(await screen.findByText(/Tôi đã xem xong bước 1 và 2/i)).toBeInTheDocument();
    const block1 = screen.getByRole('button', { name: /2 bước/i });
    const block2 = screen.getByRole('button', { name: /3 bước/i });
    expect(block1).toBeInTheDocument();
    expect(block2).toBeInTheDocument();
  });

  it('dòng tiến độ hiện tên tool, số bước và thời gian', async () => {
    const mockSessions: ChatSession[] = [
      { id: 's4', title: 'Session progress test', mode: 'safe', busy: false, updatedAt: new Date().toISOString() },
    ];

    vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue(mockSessions);
    vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue([]);
    vi.spyOn(chatApi, 'sendChatMessage').mockResolvedValue({
      userMessageId: 'u-prog',
      assistantMessageId: 'a-prog',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/chat/s4']}>
          <Routes>
            <Route path="/chat/:sessionId" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const textarea = await screen.findByPlaceholderText(/Nhập tin nhắn/i);
    fireEvent.change(textarea, { target: { value: 'Chạy tác vụ kiểm thử' } });
    const sendButton = screen.getByRole('button', { name: /Gửi/i });

    await act(async () => {
      fireEvent.click(sendButton);
    });

    // Phát sự kiện chat.tool
    act(() => {
      sseCallback?.({
        type: 'chat.tool',
        payload: {
          sessionId: 's4',
          messageId: 'tool-step-1',
          name: 'RunTests',
          summary: 'Chạy kiểm thử',
        },
      });
    });

    // Dòng tiến độ có role="status": hiện tên tool, số bước và thời gian
    const statusLine = await screen.findByRole('status');
    expect(statusLine).toBeInTheDocument();
    expect(statusLine).toHaveTextContent(/Chạy kiểm thử/i);
    expect(statusLine).toHaveTextContent(/bước 1/i);
    expect(statusLine).toHaveTextContent(/\d+:\d{2}/);
  });

  it('4. Dialog mode: lựa chọn Đầy đủ bị vô hiệu hóa khi config chưa bật', async () => {
    // Config khi allowFullMode = false
    vi.spyOn(clientApi, 'getConfig').mockResolvedValue({
      modelChainHard: ['hard-model'],
      modelChainEasy: ['easy-model'],
      defaultTimeout: 10800,
      chat: { allowFullMode: false },
    });
    vi.spyOn(clientApi, 'getProjects').mockResolvedValue([]);

    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qc1}>
        <NewSessionModal
          isOpen={true}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // Chờ load config
    await screen.findByText(/Cuộc trò chuyện mới/i);

    const safeRadio = screen.getByDisplayValue('safe') as HTMLInputElement;
    const fullRadio = screen.getByDisplayValue('full') as HTMLInputElement;

    expect(safeRadio).toBeEnabled();
    expect(safeRadio.checked).toBe(true);

    // Lựa chọn Đầy đủ bị vô hiệu hóa
    expect(fullRadio).toBeDisabled();
    expect(screen.getByText(/bật trong Cài đặt/i)).toBeInTheDocument();

    unmount();

    // Re-test khi allowFullMode = true
    vi.spyOn(clientApi, 'getConfig').mockResolvedValue({
      modelChainHard: ['hard-model'],
      modelChainEasy: ['easy-model'],
      defaultTimeout: 10800,
      chat: { allowFullMode: true },
    });

    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc2}>
        <NewSessionModal
          isOpen={true}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      const fullRadioEnabled = screen.getByDisplayValue('full') as HTMLInputElement;
      expect(fullRadioEnabled).toBeEnabled();
    });
  });

  it('5. Enter gửi tin, Shift+Enter xuống dòng', async () => {
    const onSendMock = vi.fn();
    const onCancelMock = vi.fn();

    render(
      <ChatInput
        onSend={onSendMock}
        onCancel={onCancelMock}
        busy={false}
        isEmpty={true}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Nhập tin nhắn/i);

    // Nhập nội dung
    fireEvent.change(textarea, { target: { value: 'Nội dung tin nhắn' } });

    // Nhấn Shift+Enter -> không gọi onSend
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSendMock).not.toHaveBeenCalled();

    // Nhấn Enter đơn thuần -> gọi onSend
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onSendMock).toHaveBeenCalledTimes(1);
    expect(onSendMock).toHaveBeenCalledWith('Nội dung tin nhắn');
  });

  it('6. NewSessionModal lấy model Claude khả dụng từ /api/models và fallback về config.chat.models khi API lỗi', async () => {
    // A. Thành công: lấy từ getModelOptions
    vi.spyOn(clientApi, 'getConfig').mockResolvedValue({
      chat: { allowFullMode: false, models: ['fallback-model-1', 'fallback-model-2'] },
    } as any);
    vi.spyOn(clientApi, 'getProjects').mockResolvedValue([]);
    vi.spyOn(clientApi, 'getProfiles').mockResolvedValue([]);
    vi.spyOn(clientApi, 'getModelOptions').mockResolvedValue({
      models: [
        { id: 'claude-discovered-available', engine: 'claude', available: true, verified: true, profiles: ['p1'] },
        { id: 'claude-discovered-unavailable', engine: 'claude', available: false, verified: false, profiles: [] },
      ],
      suggestions: ['claude-discovered-available'],
      configured: [],
    });

    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qc1}>
        <NewSessionModal isOpen={true} onClose={vi.fn()} onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );

    await screen.findByText(/Cuộc trò chuyện mới/i);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'claude-discovered-available' })).toBeInTheDocument();
    });
    // Không hiện model unavailable hoặc fallback
    expect(screen.queryByRole('option', { name: 'claude-discovered-unavailable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'fallback-model-1' })).not.toBeInTheDocument();

    unmount();

    // B. Khi getModelOptions lỗi: fallback về config.chat.models
    vi.spyOn(clientApi, 'getModelOptions').mockRejectedValue(new Error('Network error'));
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc2}>
        <NewSessionModal isOpen={true} onClose={vi.fn()} onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );

    await screen.findByText(/Cuộc trò chuyện mới/i);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'fallback-model-1' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'fallback-model-2' })).toBeInTheDocument();
    });
  });

  it('7. ChatPage lấy model Claude khả dụng từ /api/models và fallback về config.chat.models khi API lỗi', async () => {
    vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue([
      {
        id: 's1',
        title: 'Active Session',
        mode: 'safe',
        model: 'active-model',
        busy: false,
        updatedAt: new Date().toISOString(),
      },
    ]);
    vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue([]);
    vi.spyOn(clientApi, 'getConfig').mockResolvedValue({
      chat: { model: 'sonnet', models: ['fallback-chat-model'] },
    } as any);
    vi.spyOn(clientApi, 'getModelOptions').mockResolvedValue({
      models: [
        { id: 'active-model', engine: 'claude', available: false, verified: false, profiles: [] },
        { id: 'api-available-model', engine: 'claude', available: true, verified: true, profiles: ['p1'] },
      ],
      suggestions: ['api-available-model'],
      configured: ['active-model'],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/chat/s1']}>
          <Routes>
            <Route path="/chat/:sessionId" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Active session loads
    await screen.findByPlaceholderText(/Nhập tin nhắn/i);

    // Active model is unavailable, shows warning
    await waitFor(() => {
      expect(screen.getByTestId('model-unavailable-warning')).toBeInTheDocument();
    });
  });
});
