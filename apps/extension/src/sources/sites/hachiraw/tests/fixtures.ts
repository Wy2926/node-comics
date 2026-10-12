export const work = 'sample-book';
export const url = 'https://hachiraw.net/manga/' + work;
export const reader = url + '/chapter-1';
export const image = 'https://images.example.test/uploads/chapters/123/02.jpg';
export const cover = `https://images.example.test/uploads/tmp/mangacover/${work}.jpg?quality=80`;
export const chapter = (number: string, hidden = false) => `<a class="ChapterLink ${hidden ? 'hide' : ''}" href="${url}/chapter-${number}"><span class="ng-binding">第${number.replaceAll('-', '.')}話</span><span class="badge">NEW</span><span class="float-right ng-binding">12-10-2026</span></a>`;
export const catalogHtml = () => `<h1>Sample &amp; Book</h1><img class="img-fluid bottom-5" src="${cover}"><div class="BoxBody"><a href="/genres/fantasy">Fantasy</a><div class="col-12">${chapter('2-5')}${chapter('1', true)}</div><span class="chapter_more">もっと見せる</span><a href="javascript:void(0)">Tags</a></div>`;
export const readerHtml = (images = [image, image]) => `<div id="ChapterModal"><a class="btn btn-success" href="${reader}">第1話</a><a href="${url}/chapter-2-5">第2.5話</a></div><div class="DesktopNav"><a href="${url}">Sample Book</a><button>第1話</button><button>Page ${images.length}</button></div><img src="https://ads.example.test/ad.jpg"><div id="TopPage" class="ImageGallery">${images.map(src => `<div><img class="img-fluid lazy" data-original="${src}" src="data:image/gif;base64,R0lG"></div>`).join('')}</div>`;
export function searchHtml(total = 1, page = 1) {
  const cards = Array.from({length: Math.max(0, Math.min(20, total - (page - 1) * 20))}, (_, index) => {
    const slug = `${work}-${(page - 1) * 20 + index}`;
    return `<div class="top-15 ng-scope" ng-repeat="Series in vm.Directory | limitTo:vm.PageLimit"><a class="SeriesName" href="/manga/${slug}"><img src="https://images.example.test/uploads/tmp/mangacover/${slug}.jpg"></a><a class="SeriesName" ng-bind-html="Series.s" href="/manga/${slug}"><b>Sample &amp; Book ${index}</b></a></div>`;
  }).join('');
  const pager = total > 20 ? `<ul class="pagination"><li class="active"><a href="#">${page}</a></li>${page * 20 < total ? `<li><a rel="next" data-ci-pagination-page="${page + 1}" href="/list-manga/${page + 1}?search=sample">→</a></li>` : ''}</ul>` : '';
  return `<div class="BoxHeader">Search Manga ( ${total})</div>${cards}${pager}`;
}
