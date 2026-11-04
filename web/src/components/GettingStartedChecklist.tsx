import React, { useState } from 'react';
import { Check, ChevronRight, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getProfiles, getProjects, getSetupStatus, getTasks, getTelegramStatus } from '../api/client';
import { useLocale } from '../context/LocaleContext';
import { SetupChatButton } from './SetupChatButton';

export const GettingStartedChecklist: React.FC = () => {
  const { t } = useLocale();
  const [hidden, setHidden] = useState(() => localStorage.getItem('agenthub_checklist_hidden') === '1');
  const { data: setup } = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, staleTime: 30_000 });
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles, staleTime: 30_000 });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: getProjects, staleTime: 30_000 });
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: () => getTasks(), staleTime: 30_000 });
  const { data: telegram } = useQuery({ queryKey: ['telegram-status'], queryFn: getTelegramStatus, staleTime: 30_000 });
  if (hidden) return null;
  const items = [
    { key: 'cli', label: t('checklist.cli'), ok: Boolean(setup?.tools.some((tool) => tool.installed)), to: '/setup' },
    { key: 'account', label: t('checklist.account'), ok: profiles.some((profile) => profile.loggedIn), to: '/profiles' },
    { key: 'project', label: t('checklist.project'), ok: projects.length > 0, to: '/projects' },
    { key: 'telegram', label: t('checklist.telegram'), ok: Boolean(telegram?.enabled && telegram.hasToken), to: '/settings' },
    { key: 'task', label: t('checklist.task'), ok: tasks.length > 0, to: '/tasks/new' },
  ];
  return (
    <section data-tour="checklist" className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="text-sm font-semibold">{t('checklist.title')}</h2><p className="mt-1 text-xs text-[var(--t-text-3)]">{t('checklist.subtitle')}</p></div><SetupChatButton />
        <button type="button" onClick={() => { localStorage.setItem('agenthub_checklist_hidden', '1'); setHidden(true); }} aria-label={t('checklist.hide')} className="rounded p-1 text-[var(--t-text-3)] hover:bg-[var(--t-hover)]"><X size={16} /></button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {items.map((item) => <Link key={item.key} to={item.to} className="flex items-center gap-2 rounded-lg border border-[var(--t-border)] p-2.5 text-xs hover:bg-[var(--t-hover)]">
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${item.ok ? 'bg-[var(--t-ok)]/15 text-[var(--t-ok)]' : 'bg-[var(--t-surface-2)] text-[var(--t-text-3)]'}`}>{item.ok ? <Check size={13} /> : <ChevronRight size={13} />}</span><span className={item.ok ? 'text-[var(--t-text-3)] line-through' : ''}>{item.label}</span>
        </Link>)}
      </div>
    </section>
  );
};
