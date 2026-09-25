// Synthetic public-directory wire format for isolated browser acceptance only.
import {createCipheriv} from 'node:crypto';
const secret = 'fixture-key-1234', iv = 'fixture-iv-12345';
export const catalogKeyScript = `<script>var ccz = '${secret}';</script>`;
export function catalogResponse(slug, groups) {
  const labels = [...new Set(groups.flatMap(group => group.chapters.map(chapter => chapter.type ?? '话')))];
  const data = {build: {path_word: slug, type: labels.map((name, index) => ({id: index + 1, name}))},
    groups: Object.fromEntries(groups.map(group => [group.id, {path_word: group.id, name: group.title, count: group.chapters.length,
      chapters: group.chapters.map(chapter => ({id: chapter.id, name: chapter.title, type: labels.indexOf(chapter.type ?? '话') + 1})),
      last_chapter: {uuid: group.chapters.at(-1).id, count: group.chapters.length, comic_path_word: slug, group_path_word: group.id}}]))};
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(secret), Buffer.from(iv));
  return JSON.stringify({code: 200, results: iv + Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('hex')});
}
