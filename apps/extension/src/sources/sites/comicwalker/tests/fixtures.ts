export const work = 'KC_000001_S', episode = 'KC_0000010000100011_E', second = 'KC_0000010000200011_E';
export const workId = '00000000-0000-0000-0000-000000000001', episodeId = '00000000-0000-0000-0000-000000000002';
export const cover = 'https://cdn.comic-walker.com/integration/cdpf/resources/000001/fixture.jpg';
export const row = (code = episode, isActive = true) => ({code, id: episodeId, title: 'Chapter', subTitle: '', isActive,
  serviceId: 'web', type: 'normal', internal: {pageCount: 8}});
export function fixture() {
  const workData = {work: {code: work, id: workId, title: 'Fixture Work', language: 'ja', originalThumbnail: cover, internal: {scrollType: 'rtl'}},
    firstEpisodes: {total: 2, result: [row(), row(second, false)]}, comics: {total: 0, result: []}};
  return {props: {pageProps: {workId, workCode: work, episodeCode: episode, episodeType: 'first',
    dehydratedState: {queries: [
      {queryKey: ['/api/contents/details/work', {workCode: work}], state: {data: workData}},
      {queryKey: ['/api/contents/details/episode', {workCode: work, episodeCode: episode}], state: {data: {episode: row()}}},
    ]}}}};
}
export const html = (value: unknown = fixture()) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(value)}</script>`;
export const manuscripts = () => ({scrollDirection: 'rtl', manuscripts: Array.from({length: 8}, (_, i) => ({page: i + 1,
  width: 800, height: 1100, drmMode: 'xor', drmHash: '0123456789abcdef',
  drmImageUrl: `https://cdn.comic-walker.com/images/1/1/1/fixture/1/${i + 1}_fixture.webp?Signature=synthetic`}))});
