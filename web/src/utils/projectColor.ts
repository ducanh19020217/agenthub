import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getProjects } from '../api/client';
import type { Project } from '../types/api';

/** Số màu trong bảng `--t-project-*` (khai báo ở index.css cho cả theme sáng và tối). */
export const PROJECT_PALETTE_SIZE = 10;

/** Chỉ số màu tính từ mã dự án (FNV-1a). Dùng khi không có danh sách dự án. */
export function hashProjectColorIndex(projectId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    hash ^= projectId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % PROJECT_PALETTE_SIZE;
}

/**
 * Cấp màu lần lượt theo thứ tự tạo dự án (rồi theo mã), nên tối đa PROJECT_PALETTE_SIZE dự án
 * đầu tiên không bao giờ trùng màu; dự án mới nhận màu kế tiếp, không làm đổi màu dự án cũ.
 */
export function buildProjectColorMap(projects: Array<Pick<Project, 'id' | 'createdAt'>>): Map<string, number> {
  const ordered = [...projects].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  return new Map(ordered.map((project, index) => [project.id, index % PROJECT_PALETTE_SIZE]));
}

export function projectColorIndex(projectId: string, colorMap?: Map<string, number>): number {
  return colorMap?.get(projectId) ?? hashProjectColorIndex(projectId);
}

/** Biến CSS màu của dự án, ví dụ `var(--t-project-3)`. */
export function projectColor(projectId: string, colorMap?: Map<string, number>): string {
  return `var(--t-project-${projectColorIndex(projectId, colorMap)})`;
}

/** Hàm lấy màu dự án dựa trên danh sách dự án đang cache (cần QueryClientProvider). */
export function useProjectColor(): (projectId: string) => string {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects, staleTime: 60_000 });
  const colorMap = useMemo(() => (Array.isArray(projects) ? buildProjectColorMap(projects) : undefined), [projects]);
  return (projectId: string) => projectColor(projectId, colorMap);
}
