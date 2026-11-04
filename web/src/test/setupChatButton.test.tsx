import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { LocaleProvider } from '../context/LocaleContext';
import { SetupChatButton } from '../components/SetupChatButton';
import * as chat from '../api/chat';

vi.mock('../api/chat', async () => {
  const actual = await vi.importActual<typeof import('../api/chat')>('../api/chat');
  return { ...actual, createChatSession: vi.fn() };
});

function Location() { return <span data-testid="location">{useLocation().pathname}</span>; }

describe('SetupChatButton', () => {
  it('opens a setup chat session from the dashboard', async () => {
    vi.mocked(chat.createChatSession).mockResolvedValue({ id: 'setup-session-1' } as any);
    render(<LocaleProvider initialLocale="en"><BrowserRouter><SetupChatButton /><Location /></BrowserRouter></LocaleProvider>);
    await userEvent.setup().click(screen.getByTestId('setup-chat-button'));
    expect(chat.createChatSession).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup', mode: 'safe' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/chat/setup-session-1');
  });
});
