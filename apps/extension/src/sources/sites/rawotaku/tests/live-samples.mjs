// Public catalog URLs from the source's home, popular, new and genre lists.
// Long-running/completed works, new short catalogs and Japanese punctuation.
export const catalogUrls = [
  'ブルーロック', 'ワンピース', 'キングダム', '呪術廻戦', 'ナルト', 'ドラゴンボール',
  '転生したらスライムだった件', 'アオのハコ', 'きみは四葉のクローバー', '瓶詰人魚',
  '秀くんはうみちゃんにいじめられたい！！',
  '婚約破棄されて嫁いだ先の旦那様は、結婚翌日に私が妻だと気づいたようです',
  '俺だけが魔法使い族の異世界', '認知してください魔王様',
  '邪神に拾われた聖女が、もう一度初恋を取り戻すまで', '最果ての聖女のクロニクル',
  '非の打ち所のない令息から婚約の打診が来たので、断ってみました',
  '皇帝陛下の運命の人は、私でした～後宮寵愛占い譚～', 'さざめとりお',
  '異世界転生したら、推しの敵役のメイドになりました', '陽がのぼり菜の花は咲く',
  '劇場版-魔法少女まどか☆マギカ-〈ワルプルギスの廻天〉', '社外取締役-島耕作', '紛争でしたら八田まで',
].map(slug => `https://rawotaku.com/read/${encodeURIComponent(slug)}-raw/`);
