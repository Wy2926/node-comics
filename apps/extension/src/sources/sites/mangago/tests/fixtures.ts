import {createCipheriv} from 'node:crypto';
export const work = 'fixture_work', title = 'Fixture Work', origin = 'https://www.mangago.me';
export const url = `${origin}/read-manga/${work}/`, reader = url + 'uu/br_chapter-42/pg-1/';
export const cover = 'https://i3.mangapicgallery.com/r/coverlink/fixture-cover.jpg?4';
export const plain = `https://iweb_9.mangapicgallery.com/r/newpiclink/${work}/42/42_100.jpg`;
export const scrambled = `https://iweb7.mangapicgallery.com/r/cspiclink/${work}/42/aaaaaae2169a4bfd805e9aa21d3112d498d68cbbbbbb.jpeg`;
export function encrypt(value: string) {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from('e11adc3949ba59abbe56e057f20f883e', 'hex'),
    Buffer.from('1234567890abcdef1234567890abcdef', 'hex'));
  cipher.setAutoPadding(false);
  const data = Buffer.from(value), padded = Buffer.alloc(Math.ceil(data.length / 16) * 16); data.copy(padded);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}
export const routes = ['uu/br_chapter-42/pg-1/', 'mr/mk_v-8-chapter-2.5/pg-1/', 'mdx/d_chapter-0/'];
export function catalogHtml() {
  return `<link rel="canonical" href="${url}"><meta property="og:image" content="${cover}">
    <h1>${title}</h1><a href="${url + routes[2]}">Start Reading</a><table id="chapter_table"><tbody>
    ${routes.map((route, i) => `<tr><td><h4><a class="chico" href="${url + route}"><b>Ch.${3 - i}</b></a></h4></td><td><a href="/home/people/1/">Uploader</a></td></tr>`).join('')}
    </tbody></table>`;
}
export function readerHtml(images = [plain, scrambled, plain], target = reader, count = images.length) {
  const base = target.replace(/pg-1\/$/, '');
  return `<title>${title} Ch.3 Page 1 - Mangago</title><link rel="canonical" href="${target}">
    <a id="pic_container" style="display:block" style="min-height:600px"></a>
    <a id="series" href="${url}">${title}</a><ul id="dropdown-menu-page">
    ${Array.from({length: count}, (_, i) => `<li><a href="${base}pg-${i + 1}/">page ${i + 1} of ${count}</a></li>`).join('')}</ul>
    <script>var pcurl = "${target}",current_page=1,total_pages=${count},mid="${work}";</script>
    <script>
var imgsrcs = '${encrypt(images.join(','))}';
    </script>`;
}
export function searchHtml(query = 'Fixture', page = 1, total = 2, empty = false) {
  return `<title>${query} Search Result Page ${page} - Mangago</title>
    <input id="searchform_name" name="name" value="${query}"><ul id="search_list">${empty ? '' : `
    <li><a class="thm-effect" href="${url}"><img src="${cover}" alt="${title}"></a>
    <h2><a href="${url}">${title}</a></h2><a class="chico" href="${reader}">Latest</a></li>`}</ul>
    ${empty ? 'Total: 0' : `<div class="pagination" total="${total}"><div><ol>${Array.from({length: total}, (_, i) => `
    <li class="${i + 1 === page ? 'current' : ''}"><a href="${origin}/r/l_search/?name=${query}&amp;page=${i + 1}">${i + 1}</a></li>`).join('')}</ol></div></div>`}`;
}
