import React from 'react';
import { MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createChatSession } from '../api/chat';
import { useLocale } from '../context/LocaleContext';
import { Button } from './ui/Button';

export const SetupChatButton: React.FC<{ size?: 'sm' | 'md'; className?: string }> = ({ size = 'sm', className }) => {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const session = await createChatSession({ title: t('setup.chatTitle'), kind: 'setup', mode: 'safe' });
      navigate(`/chat/${session.id}`);
    } finally { setBusy(false); }
  };
  return <Button size={size} variant="primary" className={className} onClick={() => void open()} loading={busy} data-testid="setup-chat-button"><MessageSquare size={size === 'sm' ? 14 : 16} /><span>{t('setup.chatButton')}</span></Button>;
};
