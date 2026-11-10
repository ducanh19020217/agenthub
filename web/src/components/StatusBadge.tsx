import React from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { TaskStatus, WaitReason, HubStatus, BlockingDiskInfo } from '../types/api';
import { useLocale } from '../context/LocaleContext';
import { formatReason } from '../utils/events';

export type ExtendedTaskStatus = TaskStatus | 'checking';

export interface StatusBadgeProps {
  status: ExtendedTaskStatus;
  waitReason?: WaitReason;
  blockingDisk?: BlockingDiskInfo | null;
  diskFreeGB?: number;
  diskMinFreeGB?: number;
  diskLabel?: string;
  diskPath?: string;
  projectId?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  waitReason,
  blockingDisk,
  diskFreeGB,
  diskMinFreeGB,
  diskLabel,
  diskPath,
  projectId,
  className = '',
  size = 'md',
}) => {
  const { t, locale } = useLocale();
  const queryClient = React.useContext(QueryClientContext);
  const cachedStatus = queryClient?.getQueryData<HubStatus>(['status']);

  let label = t(`status.${status}`);
  let tooltip = blockingDisk?.path || diskPath;
  if (waitReason) {
    if (waitReason === 'disk') {
      const free = blockingDisk?.freeGB ?? diskFreeGB ?? cachedStatus?.disk?.freeGB;
      const min = blockingDisk?.minFreeGB ?? diskMinFreeGB ?? cachedStatus?.disk?.minFreeGB;
      if (free !== undefined && min !== undefined) {
        let diskName = blockingDisk?.label ?? diskLabel;
        if (!diskName && cachedStatus?.disks) {
          const hubHomeDisk = cachedStatus.disks.find((disk) => disk.source === 'hub_home' && disk.low);
          if (hubHomeDisk) {
            diskName = hubHomeDisk.label;
            if (!tooltip) tooltip = hubHomeDisk.path;
          } else if (projectId) {
            const projectDisk = cachedStatus.disks.find(
              (disk) => disk.source === 'worktrees' && disk.low && (disk.path.includes(projectId) || cachedStatus.disks?.filter((d) => d.source === 'worktrees' && d.low).length === 1)
            );
            if (projectDisk) {
              diskName = projectDisk.path ? `${projectDisk.label} (${projectDisk.path})` : projectDisk.label;
              if (!tooltip) tooltip = projectDisk.path;
            }
          }
          if (!diskName) {
            const lowDisk = cachedStatus.disks.find((disk) => disk.low);
            if (lowDisk) {
              diskName = lowDisk.path && !lowDisk.label.includes(lowDisk.path) && lowDisk.source !== 'hub_home'
                ? `${lowDisk.label} (${lowDisk.path})`
                : lowDisk.label;
              if (!tooltip) tooltip = lowDisk.path;
            }
          }
        }
        if (diskName && (diskName.toLowerCase().includes('dữ liệu hub') || diskName.toLowerCase().includes('hub home'))) {
          label = t('waitReason.hubHome', { free, min });
        } else {
          label = diskName ? t('waitReason.diskNamed', { label: diskName, free, min }) : t('waitReason.disk', { free, min });
        }
      } else {
        label = t('waitReason.diskShort');
      }
    } else if (waitReason === 'quota') {
      label = t('waitReason.quota');
    } else if (waitReason === 'slot') {
      label = t('waitReason.slot');
    } else if (waitReason === 'load') {
      label = t('waitReason.load');
    } else if (waitReason === 'dependency') {
      label = t('waitReason.dependency');
    } else if (waitReason === 'no_department_profile') {
      label = t('waitReason.no_department_profile');
    } else if (waitReason === 'no_matching_profile') {
      label = t('waitReason.no_matching_profile');
    } else if (waitReason === 'parallel') {
      label = t('waitReason.parallel');
    } else if (waitReason === 'department_parallel') {
      label = t('waitReason.department_parallel', { department: 'department' });
    } else if (waitReason === 'profile_busy') {
      label = t('waitReason.profile_busy');
    } else if (waitReason === 'project_unavailable') {
      label = t('waitReason.project_unavailable');
    } else if (waitReason === 'focus') {
      label = t('waitReason.focus');
    } else if (waitReason === 'restart') {
      label = t('waitReason.restart');
    } else {
      label = formatReason(waitReason, locale);
    }
  }

  const isPulse = status === 'running' || status === 'checking';
  const isWaitingWithReason = Boolean(waitReason);

  const bgStyle = isWaitingWithReason
    ? `var(--wait-${waitReason}-bg)`
    : `var(--status-${status}-bg, color-mix(in srgb, var(--t-surface-2) 15%, transparent))`;

  const colorStyle = isWaitingWithReason
    ? `var(--wait-${waitReason}-text)`
    : `var(--status-${status}-text, var(--t-text))`;

  const borderStyle = isWaitingWithReason
    ? `var(--wait-${waitReason}-border)`
    : `var(--status-${status}-border, transparent)`;

  const dotStyle = isWaitingWithReason
    ? `var(--wait-${waitReason}-dot)`
    : `var(--status-${status}-dot, currentColor)`;

  const sizeClasses = {
    sm: 'text-xs px-2.5 py-0.5',
    md: 'text-xs font-semibold px-3 py-1',
    lg: 'text-sm font-semibold px-3.5 py-1.5',
  }[size];

  return (
    <span
      data-testid={`status-badge-${status}`}
      data-status={status}
      data-wait-reason={waitReason || undefined}
      title={tooltip || undefined}
      style={{
        backgroundColor: bgStyle,
        color: colorStyle,
        borderColor: borderStyle,
      }}
      className={`inline-flex items-center gap-1.5 rounded-full border border-transparent font-semibold transition-colors ${sizeClasses} ${className}`}
    >
      <span
        style={{
          backgroundColor: dotStyle,
        }}
        className={`w-1.5 h-1.5 rounded-full ${isPulse ? 'animate-pulse' : ''}`}
      />
      <span>{label}</span>
    </span>
  );
};
