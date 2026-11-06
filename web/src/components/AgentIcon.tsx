import React from 'react';

export type AgentProvider = 'agy' | 'gemini' | 'codex' | 'openai' | 'claude' | 'anthropic' | string;

export interface AgentIconProps {
  provider: AgentProvider;
  className?: string;
}

export const GeminiIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="gemini-icon-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style={{ stopColor: 'var(--t-gemini-from)' }} />
        <stop offset="50%" style={{ stopColor: 'var(--t-gemini-via)' }} />
        <stop offset="100%" style={{ stopColor: 'var(--t-gemini-to)' }} />
      </linearGradient>
    </defs>
    <path
      d="M12 1C12 7.075 7.075 12 1 12C7.075 12 12 16.925 12 23C12 16.925 16.925 12 23 12C16.925 12 12 7.075 12 1Z"
      fill="url(#gemini-icon-gradient)"
    />
  </svg>
);

export const CodexIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={`${className} text-[var(--t-codex)]`} aria-hidden="true">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

export const ClaudeIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={`${className} text-[var(--t-claude)]`} aria-hidden="true">
    <path d="M13.6 1.1c0-.6-.5-1.1-1.1-1.1h-1c-.6 0-1.1.5-1.1 1.1v4.7c0 .6.5 1.1 1.1 1.1h1c.6 0 1.1-.5 1.1-1.1V1.1zm0 17.1c0-.6-.5-1.1-1.1-1.1h-1c-.6 0-1.1.5-1.1 1.1v4.7c0 .6.5 1.1 1.1 1.1h1c.6 0 1.1-.5 1.1-1.1v-4.7zm9.3-7.8c.6 0 1.1.5 1.1 1.1v1c0 .6-.5 1.1-1.1 1.1h-4.7c-.6 0-1.1-.5-1.1-1.1v-1c0-.6.5-1.1 1.1-1.1h4.7zm-17.1 0c.6 0 1.1.5 1.1 1.1v1c0 .6-.5 1.1-1.1 1.1H1.1c-.6 0-1.1-.5-1.1-1.1v-1c0-.6.5-1.1 1.1-1.1h4.7zm13.4-7.2c.4-.4 1.1-.4 1.5 0l.8.8c.4.4.4 1.1 0 1.5l-3.3 3.3c-.4.4-1.1.4-1.5 0l-.8-.8c-.4-.4-.4-1.1 0-1.5l3.3-3.3zm-11.8 11.8c.4-.4 1.1-.4 1.5 0l.8.8c.4.4.4 1.1 0 1.5l-3.3 3.3c-.4.4-1.1.4-1.5 0l-.8-.8c-.4-.4-.4-1.1 0-1.5l3.3-3.3zm13.3 5.6c-.4.4-1.1.4-1.5 0l-3.3-3.3c-.4-.4-.4-1.1 0-1.5l.8-.8c.4-.4 1.1-.4 1.5 0l3.3 3.3c.4.4.4 1.1 0 1.5l-.8.8zM8.8 8.9c-.4.4-1.1.4-1.5 0L4 5.6c-.4-.4-.4-1.1 0-1.5l.8-.8c.4-.4 1.1-.4 1.5 0l3.3 3.3c.4.4.4 1.1 0 1.5l-.8.8z" />
  </svg>
);

export const AgentIcon: React.FC<AgentIconProps> = ({ provider, className = 'w-5 h-5' }) => {
  const normalized = (provider || '').toLowerCase().trim();
  if (normalized === 'agy' || normalized === 'gemini' || normalized === 'antigravity') {
    return <GeminiIcon className={className} />;
  }
  if (normalized === 'codex' || normalized === 'openai' || normalized === 'chatgpt') {
    return <CodexIcon className={className} />;
  }
  if (normalized === 'claude' || normalized === 'anthropic') {
    return <ClaudeIcon className={className} />;
  }
  return null;
};
