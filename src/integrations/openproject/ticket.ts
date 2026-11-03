import fs from 'node:fs';
import path from 'node:path';
import type { OpenProjectClient } from './client.js';

export function renderTicketMarkdown(workPackage: any, activities: any[], baseUrl: string): string {
  const lines = [`# ${workPackage.displayId || workPackage.id}: ${workPackage.subject || ''}`, '', workPackage.description?.raw || ''];
  for (const activity of activities) { if (activity.comment?.raw) lines.push('', `## Comment ${activity.id}`, activity.comment.raw); }
  return lines.join('\n').replaceAll(`${baseUrl}/api/v3/attachments/`, 'attachments/');
}

export async function writeTicketDirectory(client: OpenProjectClient, workPackage: any, activities: any[], dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true, mode: 0o700 });
  let markdown = renderTicketMarkdown(workPackage, activities, '');
  const links = [...markdown.matchAll(/(?:src=|\()\/?api\/v3\/attachments\/(\d+)\/content[^\s)"']*/g)].map((m) => m[1]);
  for (const id of new Set(links)) { const response = await client.downloadAttachment(id); const type = response.headers.get('content-type') || ''; const ext = type.split('/')[1]?.split(';')[0] || 'bin'; const target = `images/${id}.${ext}`; fs.writeFileSync(path.join(dir, target), Buffer.from(await response.arrayBuffer()), { mode: 0o600 }); markdown = markdown.replaceAll(`/api/v3/attachments/${id}/content`, target); }
  fs.writeFileSync(path.join(dir, 'ticket.md'), markdown, { mode: 0o600 });
}
