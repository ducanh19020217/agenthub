import React from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { getProjects } from '../api/client';
import { buildProjectColorMap, projectColor } from '../utils/projectColor';

interface ProjectTagProps {
  projectId: string;
  /** Tên hiển thị; bỏ trống thì tự tra tên dự án (cần QueryClientProvider), không có thì hiện mã. */
  name?: string;
  className?: string;
}

const Tag: React.FC<{ projectId: string; label: string; className: string; color?: string }> = ({ projectId, label, className, color = projectColor(projectId) }) => {
  return (
    <span
      data-testid="project-tag"
      data-project={projectId}
      title={projectId}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${className}`}
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{label}</span>
    </span>
  );
};

const TagWithLookup: React.FC<{ projectId: string; name?: string; className: string }> = ({ projectId, name: explicitName, className }) => {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects, staleTime: 60_000 });
  const list = Array.isArray(projects) ? projects : [];
  const name = explicitName || list.find((project) => project.id === projectId)?.name;
  const color = projectColor(projectId, list.length ? buildProjectColorMap(list) : undefined);
  return <Tag projectId={projectId} label={name || projectId} className={className} color={color} />;
};

/** Nhãn dự án có màu tự gán theo mã dự án; hiện tên dự án nếu biết, rê chuột để thấy mã. */
export const ProjectTag: React.FC<ProjectTagProps> = ({ projectId, name, className = '' }) => {
  const queryClient = React.useContext(QueryClientContext);
  if (!queryClient) return <Tag projectId={projectId} label={name || projectId} className={className} />;
  return <TagWithLookup projectId={projectId} name={name} className={className} />;
};
