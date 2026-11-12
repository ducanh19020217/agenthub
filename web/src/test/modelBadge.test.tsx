import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ModelBadge,
  AgentModelBadge,
  formatModelName,
  getModelEngineKey,
  getEngineLabel,
  getBadgeTitle,
} from '../components/ModelBadge';

describe('ModelBadge component and helpers', () => {
  describe('formatModelName', () => {
    it('formats gemini-3.8-flash-high to Gemini Flash · high', () => {
      expect(formatModelName('gemini-3.8-flash-high')).toBe('Gemini Flash · high');
    });

    it('formats gemini-3.8-flash-medium to Gemini Flash · medium', () => {
      expect(formatModelName('gemini-3.8-flash-medium')).toBe('Gemini Flash · medium');
    });

    it('formats gemini-3.8-flash-low to Gemini Flash · low', () => {
      expect(formatModelName('gemini-3.8-flash-low')).toBe('Gemini Flash · low');
    });

    it('formats codex:gpt-5.6-luna to Codex Luna', () => {
      expect(formatModelName('codex:gpt-5.6-luna')).toBe('Codex Luna');
    });

    it('formats gpt-5.6-luna to Codex Luna', () => {
      expect(formatModelName('gpt-5.6-luna')).toBe('Codex Luna');
    });

    it('formats claude to Claude', () => {
      expect(formatModelName('claude')).toBe('Claude');
    });

    it('keeps other model names unmodified', () => {
      expect(formatModelName('claude-opus-4-6-thinking')).toBe('claude-opus-4-6-thinking');
      expect(formatModelName('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
      expect(formatModelName('custom-model-v1')).toBe('custom-model-v1');
    });

    it('falls back to engine when model is not provided', () => {
      expect(formatModelName(null, 'agy')).toBe('Gemini');
      expect(formatModelName(null, 'gemini')).toBe('Gemini');
      expect(formatModelName(undefined, 'codex')).toBe('Codex');
      expect(formatModelName(undefined, 'claude')).toBe('Claude');
      expect(formatModelName('', 'custom')).toBe('custom');
    });
  });

  describe('getModelEngineKey & getEngineLabel', () => {
    it('detects gemini engine from model or engine name', () => {
      expect(getModelEngineKey('gemini-3.8-flash-high')).toBe('gemini');
      expect(getModelEngineKey('', 'agy')).toBe('gemini');
      expect(getModelEngineKey(null, 'gemini')).toBe('gemini');
      expect(getEngineLabel('gemini-3.8-flash-high')).toBe('Gemini');
    });

    it('detects codex engine from model or engine name', () => {
      expect(getModelEngineKey('codex:gpt-5.6-luna')).toBe('codex');
      expect(getModelEngineKey('gpt-5.6-luna')).toBe('codex');
      expect(getModelEngineKey('', 'codex')).toBe('codex');
      expect(getEngineLabel('codex:gpt-5.6-luna')).toBe('Codex');
    });

    it('detects claude engine from model or engine name', () => {
      expect(getModelEngineKey('claude-opus-4-6-thinking')).toBe('claude');
      expect(getModelEngineKey('', 'claude')).toBe('claude');
      expect(getEngineLabel('claude-opus-4-6-thinking')).toBe('Claude');
    });

    it('falls back to other for unknown engines', () => {
      expect(getModelEngineKey('unknown-model', 'unknown')).toBe('other');
    });
  });

  describe('getBadgeTitle', () => {
    it('combines engine, profile, and model', () => {
      expect(getBadgeTitle('gemini-3.8-flash-high', 'agy', 'my-profile')).toBe(
        'Gemini / my-profile / gemini-3.8-flash-high',
      );
    });

    it('infers engine when not provided explicitly and profile is present', () => {
      expect(getBadgeTitle('codex:gpt-5.6-luna', null, 'codex-fast')).toBe(
        'Codex / codex-fast / codex:gpt-5.6-luna',
      );
    });

    it('omits profile segment when profile is null or undefined without undefined text', () => {
      expect(getBadgeTitle('claude-sonnet-4-6', 'claude')).toBe(
        'Claude / claude-sonnet-4-6',
      );
    });
  });

  describe('ModelBadge rendering', () => {
    it('renders with profileName: engine icon, profile, separator, and model name', () => {
      render(
        <ModelBadge
          model="gemini-3.8-flash-high"
          profileName="gemini-prod"
        />,
      );
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('gemini-prod');
      expect(badge).toHaveTextContent('Gemini Flash · high');
      expect(badge).not.toHaveTextContent('undefined');
      expect(badge).toHaveAttribute('title', 'Gemini / gemini-prod / gemini-3.8-flash-high');
      expect(badge).toHaveClass('badge-model-gemini');
    });

    it('renders without profile: does not render profile or undefined', () => {
      render(<ModelBadge model="gemini-3.8-flash-high" />);
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('Gemini Flash · high');
      expect(badge).not.toHaveTextContent('undefined');
      expect(badge).toHaveAttribute('title', 'Gemini / gemini-3.8-flash-high');
      expect(badge).toHaveClass('badge-model-gemini');
      expect(screen.queryByTestId('model-badge-profile')).toBeNull();
    });

    it('infers codex engine from model codex:gpt-5.6-luna with profile', () => {
      render(<AgentModelBadge model="codex:gpt-5.6-luna" profileName="codex-worker" />);
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('codex-worker');
      expect(badge).toHaveTextContent('Codex Luna');
      expect(badge).toHaveAttribute('title', 'Codex / codex-worker / codex:gpt-5.6-luna');
      expect(badge).toHaveClass('badge-model-codex');
    });

    it('infers claude engine from claude-sonnet-4-6 without engine', () => {
      render(<ModelBadge model="claude-sonnet-4-6" profileName="claude-main" />);
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('claude-main');
      expect(badge).toHaveTextContent('claude-sonnet-4-6');
      expect(badge).toHaveAttribute('title', 'Claude / claude-main / claude-sonnet-4-6');
      expect(badge).toHaveClass('badge-model-claude');
    });

    it('renders fallback engine name if model is missing', () => {
      render(<ModelBadge engine="codex" />);
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('Codex');
      expect(badge).toHaveAttribute('title', 'Codex');
      expect(badge).toHaveClass('badge-model-codex');
    });

    it('returns null if neither model nor engine is provided', () => {
      const { container } = render(<ModelBadge model={null} engine={null} />);
      expect(container.firstChild).toBeNull();
    });
  });
});
