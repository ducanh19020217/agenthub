import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AgentIcon, GeminiIcon, CodexIcon, ClaudeIcon } from '../components/AgentIcon';

describe('AgentIcon', () => {
  it('renders GeminiIcon for agy and gemini', () => {
    const { container: agyContainer } = render(<AgentIcon provider="agy" />);
    expect(agyContainer.querySelector('svg')).toBeInTheDocument();
    expect(agyContainer.querySelector('linearGradient')).toBeInTheDocument();

    const { container: geminiContainer } = render(<AgentIcon provider="gemini" />);
    expect(geminiContainer.querySelector('svg')).toBeInTheDocument();
  });

  it('renders CodexIcon for codex and openai', () => {
    const { container: codexContainer } = render(<AgentIcon provider="codex" />);
    expect(codexContainer.querySelector('svg')).toBeInTheDocument();
    expect(codexContainer.querySelector('.text-\\[var\\(--t-codex\\)\\]')).toBeInTheDocument();

    const { container: openaiContainer } = render(<AgentIcon provider="openai" />);
    expect(openaiContainer.querySelector('svg')).toBeInTheDocument();
  });

  it('renders ClaudeIcon for claude and anthropic', () => {
    const { container: claudeContainer } = render(<AgentIcon provider="claude" />);
    expect(claudeContainer.querySelector('svg')).toBeInTheDocument();
    expect(claudeContainer.querySelector('.text-\\[var\\(--t-claude\\)\\]')).toBeInTheDocument();

    const { container: anthropicContainer } = render(<AgentIcon provider="anthropic" />);
    expect(anthropicContainer.querySelector('svg')).toBeInTheDocument();
  });

  it('renders standalone icons directly', () => {
    const { container: gemini } = render(<GeminiIcon className="w-6 h-6" />);
    expect(gemini.querySelector('svg')).toHaveClass('w-6', 'h-6');

    const { container: codex } = render(<CodexIcon className="w-6 h-6" />);
    expect(codex.querySelector('svg')).toHaveClass('w-6', 'h-6');

    const { container: claude } = render(<ClaudeIcon className="w-6 h-6" />);
    expect(claude.querySelector('svg')).toHaveClass('w-6', 'h-6');
  });

  it('returns null for unknown provider', () => {
    const { container } = render(<AgentIcon provider="unknown_provider" />);
    expect(container.firstChild).toBeNull();
  });
});
