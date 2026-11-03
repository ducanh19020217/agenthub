import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import { subscribeToEvents } from '../../api/sse';
import { useLocale } from '../../context/LocaleContext';

export const SecretRequestCard: React.FC = () => {
  const { t } = useLocale();
  const [request, setRequest] = useState<{ requestId: string; label?: string } | null>(null);
  const [value, setValue] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => subscribeToEvents((event) => {
    if (event.type === 'secret.requested' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload as { requestId?: string; label?: string };
      if (payload.requestId) { setRequest({ requestId: payload.requestId, label: payload.label }); setDone(false); setValue(''); }
    }
  }), []);
  if (!request || done) return null;
  return <form className="mx-5 mb-2 rounded-xl border border-[var(--t-warn)] bg-[var(--t-warn)]/10 p-3" onSubmit={async (event) => {
    event.preventDefault();
    await apiFetch(`/api/secrets/requests/${encodeURIComponent(request.requestId)}/value`, { method: 'POST', body: JSON.stringify({ value }) });
    setDone(true); setValue('');
  }}>
    <div className="font-semibold text-sm">{request.label || t('extra.secretRequest')}</div>
    <input className="mt-2 w-full rounded border p-2 bg-[var(--t-surface)]" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoFocus aria-label={t('extra.secretValue')} />
    <button className="mt-2 rounded bg-[var(--t-accent)] px-3 py-1.5 text-sm text-[var(--t-on-accent)]" type="submit">{t('common.save')}</button>
  </form>;
};
