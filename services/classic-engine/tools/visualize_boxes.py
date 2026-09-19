"""Render existing detection/OCR JSON without loading models or running inference.

Usage: python tools/visualize_boxes.py IMAGE_DIR JSON_DIR OUTPUT_DIR
The output contains numbered comparison PNGs and a fully offline HTML viewer.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


COLORS = {"D": "#d97706", "O": "#007eac", "G": "#bd2991"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def load_pages(images: Path, results: Path) -> list[dict]:
    pages = []
    for source in sorted(p for p in images.iterdir() if p.suffix.lower() in IMAGE_EXTENSIONS):
        result = results / (source.stem + ".json")
        data = json.loads(result.read_text(encoding="utf-8-sig"))
        if "detection_quads" not in data:
            raise ValueError(f"{result}: missing detection_quads; OCR lines are not all detections")
        with Image.open(source) as image:
            width, height = image.size
        if list(data["size"]) != [width, height]:
            raise ValueError(f"{result}: JSON size differs from original image")
        detections, lines, regions = data["detection_quads"], data["lines"], data["regions"]
        if data.get("detected_lines", len(detections)) != len(detections):
            raise ValueError(f"{result}: incomplete detection_quads")
        if data.get("recognized_lines", len(lines)) != len(lines):
            raise ValueError(f"{result}: incomplete lines")
        for quad in detections + [line["quad"] for line in lines]:
            if len(quad) != 4 or any(len(point) != 2 or not all(math.isfinite(v) for v in point) for point in quad):
                raise ValueError(f"{result}: invalid quad")
        pages.append({
            "name": source.stem, "source": source,
            "image": f"originals/{source.name}", "png": f"pages/{source.stem}.png",
            "width": width, "height": height, "detection_quads": detections,
            "lines": [{key: line.get(key) for key in ("quad", "text", "prob", "attempts")} for line in lines],
            "regions": [{"bbox": region["bbox"], "text": region.get("text", "")} for region in regions],
        })
    if not pages:
        raise ValueError(f"No original images found in {images}")
    return pages


def find_font(requested: Path | None) -> str:
    candidates = [requested] if requested else [
        Path("C:/Windows/Fonts/msyh.ttc"), Path("C:/Windows/Fonts/simhei.ttf"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/System/Library/Fonts/PingFang.ttc"),
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return str(candidate)
    raise ValueError("CJK font not found; pass --font PATH to render OCR text correctly")


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font, width: int) -> list[str]:
    rows, row = [], ""
    for character in text.replace("\r", ""):
        if character == "\n":
            rows.append(row)
            row = ""
        elif row and draw.textlength(row + character, font=font) > width:
            rows.append(row)
            row = character
        else:
            row += character
    rows.append(row)
    return rows


def render_png(page: dict, output: Path, font_path: str) -> None:
    font = ImageFont.truetype(font_path, 15)
    title_font = ImageFont.truetype(font_path, 20)
    small = ImageFont.truetype(font_path, 10)
    width, height = page["width"], page["height"]
    top, gap, legend_width = 72, 16, 360
    measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    legend = []
    for index, line in enumerate(page["lines"], 1):
        probability = line["prob"]
        confidence = f"{probability:.1%}" if probability is not None else "—"
        heading = f"O{index}  置信度 {confidence}  尝试 {line['attempts']}"
        legend.append((heading, wrap_text(measure, line["text"] or "", font, legend_width - 24)))
    legend_height = sum(31 + len(rows) * 22 + 12 for _, rows in legend)
    canvas = Image.new("RGB", (2 * width + 3 * gap + legend_width, max(height, legend_height) + top + gap), "#f6f8fb")
    draw = ImageDraw.Draw(canvas)
    with Image.open(page["source"]) as image:
        source = image.convert("RGB")
        canvas.paste(source, (gap, top))
        canvas.paste(source, (width + 2 * gap, top))
    draw.text((gap, 10), f"{page['name']} · 原图检测 / OCR 识别对照", font=title_font, fill="#172235")
    draw.text((gap, 43), f"D 检测框：{len(page['detection_quads'])}", font=font, fill=COLORS["D"])
    draw.text((width + 2 * gap, 43), f"O 识别框：{len(page['lines'])}   G 分组框：{len(page['regions'])}", font=font, fill=COLORS["O"])
    legend_x = 2 * width + 3 * gap
    draw.text((legend_x, 43), "OCR 文字 / 置信度 / 尝试次数", font=font, fill="#172235")

    def polygon(quad, prefix, index, offset, label_y=0):
        points = [(float(x) + offset, float(y) + top) for x, y in quad]
        draw.line(points + points[:1], fill=COLORS[prefix], width=2 if prefix != "G" else 1)
        # Panel titles supply D/O; compact numbers stay legible on narrow columns.
        label = f"G{index}" if prefix == "G" else str(index)
        left = min(max(offset, min(x for x, _ in points)), offset + width - 40)
        upper = min(max(top, min(y for _, y in points) + label_y), top + height - 18)
        box = draw.textbbox((left + 2, upper), label, font=small)
        draw.rectangle((left, upper, box[2] + 2, box[3] + 1), fill=COLORS[prefix])
        draw.text((left + 2, upper), label, font=small, fill="white")

    for index, quad in enumerate(page["detection_quads"], 1):
        polygon(quad, "D", index, gap)
    for index, region in enumerate(page["regions"], 1):
        x0, y0, x1, y1 = region["bbox"]
        polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], "G", index, width + 2 * gap, -17)
    for index, line in enumerate(page["lines"], 1):
        polygon(line["quad"], "O", index, width + 2 * gap)
    y = top
    for heading, rows in legend:
        draw.text((legend_x, y), heading, font=font, fill=COLORS["O"])
        y += 31
        for row in rows:
            draw.text((legend_x, y), row, font=font, fill="#172235")
            y += 22
        y += 12
    canvas.save(output / page["png"], compress_level=3)


HTML = r'''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>检测与 OCR 框对照</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eff2f6;color:#172235;font:14px system-ui,sans-serif}header{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid #ccd4df;padding:12px 18px}h1{font-size:18px;margin:0 0 10px}.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}button,select,a.download{border:1px solid #bcc8d8;background:white;padding:7px 10px;border-radius:5px;color:inherit}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}label{white-space:nowrap}input{accent-color:#007eac}#summary{font-size:12px;color:#536078;margin-top:9px}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px;padding:14px}.compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start;overflow:auto}figure{margin:0;min-width:0}figcaption{font-weight:600;margin:0 0 8px}.picture{position:relative;background:#fff;line-height:0}.picture img{display:block;width:100%;height:auto}.picture svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.compare.actual figure{width:var(--page-width)}.compare.actual{grid-template-columns:repeat(2,var(--page-width))}aside{background:white;border:1px solid #d5dce6;border-radius:8px;max-height:calc(100vh - 165px);overflow:auto;padding:12px}aside h2{margin:0 0 6px;font-size:15px}aside p{font-size:12px;color:#536078}.entry{width:100%;text-align:left;display:block;margin:7px 0;padding:10px;white-space:normal;overflow-wrap:anywhere}.entry strong{display:block;margin-bottom:5px}.entry.selected{background:#e7f6ff;border-color:#007eac}.entry small{display:block;color:#536078;margin-top:5px}polygon,rect.box{vector-effect:non-scaling-stroke;cursor:pointer;fill:transparent;stroke-width:2}g.selected polygon,g.selected rect.box{fill:#ffea0066;stroke-width:4}svg text{font:12px system-ui,sans-serif;font-weight:700;paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round;pointer-events:none}.D{color:#d97706}.O{color:#007eac}.G{color:#bd2991}#detail{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:#f6f8fb;border-radius:5px;font-size:12px}@media(max-width:900px){.workspace{grid-template-columns:1fr}aside{max-height:400px}.compare{gap:6px}header{position:static}}
</style>
<header><h1>检测与 OCR 框对照</h1><div class="controls">
<button id="prev" aria-label="上一页">← 上一页</button><select id="pages" aria-label="选择页面"></select><button id="next" aria-label="下一页">下一页 →</button>
<label class="D"><input id="D" type="checkbox">检测框</label><label class="O"><input id="O" type="checkbox" checked>识别框</label><label class="G"><input id="G" type="checkbox">分组框</label><label><input id="numbers" type="checkbox" checked>编号</label>
<button id="zoom">原始尺寸</button><a class="download" id="png" target="_blank" rel="noopener">打开标框 PNG</a></div><div id="summary"></div></header>
<main class="workspace"><section class="compare" id="compare"><figure><figcaption>原图</figcaption><div class="picture"><img id="original" alt="漫画原图"></div></figure><figure><figcaption>标框 · 点击框或右侧条目查看详情</figcaption><div class="picture"><img id="overlayImage" alt="漫画标框底图"><svg id="overlay" xmlns="http://www.w3.org/2000/svg" aria-label="检测、识别与分组框"></svg></div></figure></section><aside><h2>框详情</h2><div id="detail">选择一个框查看文字与置信度。</div><p>D = 完整检测；O = OCR 保留的识别行；G = 分组。编号各自独立，不代表一一对应。检测与分组无置信度字段。</p><div id="entries"></div></aside></main>
<script id="data" type="application/json">__DATA__</script>
<script>
'use strict';
const pages=JSON.parse(document.getElementById('data').textContent),$=id=>document.getElementById(id),ns='http://www.w3.org/2000/svg',colors={D:'#d97706',O:'#007eac',G:'#bd2991'};
let index=0,selected=null;
const node=(tag,attrs={})=>{const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);return el};
pages.forEach((page,i)=>{const option=document.createElement('option');option.value=i;option.textContent=`${i+1} / ${pages.length} · ${page.name}`;$('pages').append(option)});
function items(page){return [...page.detection_quads.map((quad,i)=>({kind:'D',id:i+1,quad})),...page.lines.map((line,i)=>({...line,kind:'O',id:i+1})),...page.regions.map((region,i)=>({...region,kind:'G',id:i+1}))]}
function describe(item){let text=`${item.kind}${item.id}`;if(item.kind==='O')text+=` · 置信度 ${item.prob==null?'未知':(item.prob*100).toFixed(1)+'%'} · 尝试 ${item.attempts??'未知'}`;if(item.text)text+='\n'+item.text;return text}
function select(item){selected=item.kind+item.id;$('detail').textContent=describe(item)+'\n坐标：'+JSON.stringify(item.quad??item.bbox);document.querySelectorAll('[data-key]').forEach(el=>el.classList.toggle('selected',el.dataset.key===selected));const entry=$('entries').querySelector(`[data-key="${selected}"]`);if(entry)entry.scrollIntoView({block:'nearest'})}
function draw(){const page=pages[index];$('overlay').replaceChildren();$('entries').replaceChildren();for(const item of items(page)){if(!$(item.kind).checked)continue;const key=item.kind+item.id,group=node('g',{'data-key':key});if(key===selected)group.classList.add('selected');let x,y,shape;if(item.quad){x=Math.min(...item.quad.map(p=>p[0]));y=Math.min(...item.quad.map(p=>p[1]));shape=node('polygon',{points:item.quad.map(p=>p.join(',')).join(' ')})}else{const [x0,y0,x1,y1]=item.bbox;x=x0;y=y0;shape=node('rect',{class:'box',x,y,width:x1-x0,height:y1-y0})}shape.setAttribute('stroke',colors[item.kind]);if(item.kind!=='O')shape.setAttribute('stroke-dasharray',item.kind==='D'?'5 3':'10 4');const title=node('title');title.textContent=describe(item);shape.append(title);group.append(shape);if($('numbers').checked){const label=node('text',{x:Math.max(0,Math.min(x,page.width-30)),y:Math.max(13,y+(item.kind==='G'?-3:13)),fill:colors[item.kind]});label.textContent=key;group.append(label)}group.addEventListener('click',()=>select(item));$('overlay').append(group);const entry=document.createElement('button');entry.className='entry'+(key===selected?' selected':'');entry.dataset.key=key;const heading=document.createElement('strong');heading.style.color=colors[item.kind];heading.textContent=key;entry.append(heading);const text=document.createElement('span');text.textContent=item.text||(item.kind==='D'?'检测框':'无文字');entry.append(text);if(item.kind==='O'){const meta=document.createElement('small');meta.textContent=`置信度 ${item.prob==null?'未知':(item.prob*100).toFixed(1)+'%'} · 尝试 ${item.attempts??'未知'}`;entry.append(meta)}entry.addEventListener('click',()=>select(item));$('entries').append(entry)}if(!$('entries').children.length)$('entries').textContent='当前没有可见框。'}
function show(next){index=Math.max(0,Math.min(pages.length-1,next));selected=null;const page=pages[index];$('pages').value=index;$('original').src=page.image;$('overlayImage').src=page.image;$('overlay').setAttribute('viewBox',`0 0 ${page.width} ${page.height}`);$('compare').style.setProperty('--page-width',page.width+'px');$('png').href=page.png;$('prev').disabled=index===0;$('next').disabled=index===pages.length-1;$('summary').textContent=`${page.name} · ${page.width} × ${page.height} · 检测 ${page.detection_quads.length} · 识别 ${page.lines.length} · 分组 ${page.regions.length} · ← → 翻页 · 本地离线查看`;$('detail').textContent='选择一个框查看文字与置信度。';history.replaceState(null,'','#'+page.name);draw()}
$('prev').onclick=()=>show(index-1);$('next').onclick=()=>show(index+1);$('pages').onchange=()=>show(Number($('pages').value));for(const id of ['D','O','G','numbers'])$(id).onchange=draw;$('zoom').onclick=()=>{const actual=$('compare').classList.toggle('actual');$('zoom').textContent=actual?'适应窗口':'原始尺寸'};document.addEventListener('keydown',event=>{if(['INPUT','SELECT','BUTTON'].includes(event.target.tagName)||event.altKey||event.ctrlKey||event.metaKey)return;if(event.key==='ArrowLeft'){event.preventDefault();show(index-1)}if(event.key==='ArrowRight'){event.preventDefault();show(index+1)}});show(Math.max(0,pages.findIndex(page=>page.name===location.hash.slice(1))));
</script></html>'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--font", type=Path, help="CJK .ttf/.ttc/.otf font for PNG labels")
    args = parser.parse_args()
    images, results, output = args.images.resolve(), args.results.resolve(), args.output.resolve()
    if output in (images, results) or output in images.parents or output in results.parents:
        parser.error("Output must be separate from source images and JSON results")
    pages = load_pages(images, results)
    font = find_font(args.font)
    (output / "originals").mkdir(parents=True, exist_ok=True)
    (output / "pages").mkdir(exist_ok=True)
    for page in pages:
        shutil.copy2(page["source"], output / page["image"])
        render_png(page, output, font)
    payload = [{key: value for key, value in page.items() if key != "source"} for page in pages]
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    (output / "index.html").write_text(HTML.replace("__DATA__", serialized), encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps({
        "source_images": str(images), "source_results": str(results), "page_count": len(pages),
        "pages": [{"name": p["name"], "detection": len(p["detection_quads"]), "ocr": len(p["lines"]), "groups": len(p["regions"])} for p in pages],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Generated {len(pages)} comparison PNGs and {output / 'index.html'}")


if __name__ == "__main__":
    main()
