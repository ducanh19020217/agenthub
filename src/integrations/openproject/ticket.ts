import fs from 'node:fs';
import path from 'node:path';
import type {
  OpenProjectClient,
  OpenProjectWorkPackage,
  OpenProjectActivity,
} from './client.js';

export function renderTicketMarkdown(
  workPackage: OpenProjectWorkPackage,
  activities: OpenProjectActivity[],
  baseUrl = '',
): string {
  const lines = [
    `# ${workPackage.displayId || workPackage.id}: ${workPackage.subject || ''}`,
    '',
    workPackage.description?.raw || '',
  ];
  for (const activity of activities) {
    if (activity.comment?.raw) {
      lines.push('', `## Comment ${activity.id}`, activity.comment.raw);
    }
  }
  let markdown = lines.join('\n');
  if (baseUrl) {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    markdown = markdown.replaceAll(`${cleanBase}/api/v3/attachments/`, '/api/v3/attachments/');
  }
  return markdown;
}

export async function writeTicketDirectory(
  client: OpenProjectClient,
  workPackage: OpenProjectWorkPackage,
  activities: OpenProjectActivity[],
  dir: string,
  baseUrl = '',
): Promise<void> {
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true, mode: 0o700 });
  let markdown = renderTicketMarkdown(workPackage, activities, baseUrl);
  const regex = /\/api\/v3\/attachments\/(\d+)\/content[^\s)"']*/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    if (match[1]) links.push(match[1]);
  }
  for (const id of new Set(links)) {
    const response = await client.downloadAttachment(id);
    const type = response.headers.get('content-type') || '';
    const rawExt = type.split('/')[1]?.split(';')[0]?.trim();
    const ext = rawExt && /^[a-zA-Z0-9]+$/.test(rawExt) ? rawExt : 'png';
    const target = `images/${id}.${ext}`;
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(path.join(dir, target), buffer, { mode: 0o600 });
    markdown = markdown.replaceAll(
      new RegExp(`/api/v3/attachments/${id}/content[^\\s)"']*`, 'g'),
      target,
    );
  }
  fs.writeFileSync(path.join(dir, 'ticket.md'), markdown, { mode: 0o600 });
}
