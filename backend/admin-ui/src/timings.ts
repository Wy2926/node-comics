import type {TaskDetail} from './types';

const timingLabels: Record<string, string> = {
  download: '原图下载', download_queue: '下载等待', analyze: '图像分析（含 OCR）', analyze_queue: '分析等待',
  analyze_decode: '分析：图片解码与校验', analyze_detect: '分析：文字检测', analyze_group: '分析：段落分组',
  analyze_route: '分析：语言试读与分流', analyze_ocr: '分析：正式 OCR', analyze_colors: '分析：字色与描边取色',
  analyze_bubbles: '分析：气泡检测', analyze_refine: '分析：文字蒙版细化', analyze_serialize: '分析：检查点编码与校验',
  detect_lock_wait: '检测模型锁等待', ocr_lock_wait: 'OCR / 取色模型锁等待', bubble_lock_wait: '气泡模型锁等待',
  inpaint: '抹字', inpaint_queue: '抹字等待', inpaint_lock_wait: '抹字模型锁等待',
  render: '嵌字与编码', render_queue: '嵌字等待', render_areas: '嵌字：气泡分析', render_layout: '嵌字：排版绘字',
  render_diff: '嵌字：差异提取', render_encode: '嵌字：WebP 编码', analysis_submit: '分析提交',
  text_wait: '等待译文', local_total: '领取至结果冻结', output_put: '结果提交', total: '中心登记与结算',
};

export function timingLabel(key: string) {
  return timingLabels[key] ?? key;
}

export function taskTimingRows(timings: TaskDetail['timings']) {
  return [
    ...Object.entries(timings?.node ?? {}).map(([key, seconds]) => ({key, seconds, source: '节点'})),
    ...Object.entries(timings?.delivery ?? {}).map(([key, seconds]) => ({key, seconds, source: '中心'}))
  ].filter(({key}) => key !== 'protocol');
}
