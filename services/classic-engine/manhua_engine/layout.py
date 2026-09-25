"""Unicode line breaking, offline hyphenation and measured multilingual rendering."""
from functools import lru_cache
from pathlib import Path
import math
import re
import unicodedata
import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont
import pyphen
from uniseg.graphemecluster import grapheme_clusters
from uniseg.linebreak import line_break_units
from .languages import language_code

FONT = 'C:/Windows/Fonts/msyh.ttc'
VERTICAL = str.maketrans({'…':'︙','‥':'︰','（':'︵','）':'︶','「':'﹁','」':'﹂','『':'﹃','』':'﹄','ー':'丨','—':'︱','–':'︱','－':'︱'})
PUNCTUATION = str.maketrans({'⁉':'!?','‼':'!!','⁇':'??','⁈':'?!'})
LATIN = str.maketrans({chr(i+0xfee0):chr(i) for i in range(0x21,0x7f) if chr(i).isalnum()})


@lru_cache(maxsize=32)
def coverage(path):
    with TTFont(path, fontNumber=0, lazy=True) as font:
        return frozenset(font.getBestCmap())


@lru_cache(maxsize=16)
def font_paths(custom=(), language='zh'):
    names = {
        'ja': ['YuGothR.ttc', 'msyh.ttc', 'malgun.ttf', 'arial.ttf'],
        'ko': ['malgun.ttf', 'msyh.ttc', 'YuGothR.ttc', 'arial.ttf'],
        'en': ['arial.ttf', 'msyh.ttc', 'YuGothR.ttc', 'malgun.ttf'],
    }.get(language, ['msyh.ttc', 'YuGothR.ttc', 'malgun.ttf', 'arial.ttf'])
    candidates = [str(p) for p in custom]
    for path in candidates:
        if not Path(path).is_file():
            raise FileNotFoundError(f'Font not found: {path}')
    # An explicit release font set must not vary with fonts installed on the
    # destination computer. It is the complete, ordered fallback set.
    if candidates:
        return tuple(dict.fromkeys(candidates))
    candidates += [f'C:/Windows/Fonts/{name}' for name in names]
    candidates += ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
                   '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    paths = tuple(dict.fromkeys(p for p in candidates if Path(p).is_file()))
    if not paths:
        raise FileNotFoundError('Install Noto Sans CJK or specify --font (repeatable for fallback fonts)')
    return paths


@lru_cache(maxsize=256)
def font_at(path, size):
    return ImageFont.truetype(path, size)


@lru_cache(maxsize=8192)
def font_runs(text, paths):
    required = {ord(c) for c in text if not c.isspace() and unicodedata.category(c) != 'Cf'}
    for path in paths:
        if required <= coverage(path): return ((path,text),) if text else ()
    runs = []
    for cluster in grapheme_clusters(text):
        required = {ord(c) for c in cluster if not c.isspace() and unicodedata.category(c) != 'Cf'}
        path = next((p for p in paths if required <= coverage(p)), None)
        if path is None:
            codes = ', '.join(f'U+{c:04X}' for c in sorted(required))
            raise ValueError(f'No font covers {codes}; add a suitable --font')
        if runs and runs[-1][0] == path:
            runs[-1] = (path, runs[-1][1] + cluster)
        else:
            runs.append((path, cluster))
    return tuple(runs)


@lru_cache(maxsize=8192)
def measure(text, paths, size):
    # Baseline alignment preserves accents and descenders across fallback fonts.
    x = 0.; left = top = right = bottom = 0
    for path, value in font_runs(text, paths):
        font = font_at(path, size)
        box = font.getbbox(value, anchor='ls', stroke_width=round(size*.045))
        left, top = min(left, math.floor(x+box[0])), min(top, box[1])
        right, bottom = max(right, math.ceil(x+box[2])), max(bottom, box[3])
        x += font.getlength(value)
    return left, top, max(right, math.ceil(x)), bottom


@lru_cache(maxsize=2048)
def glyph(text, paths, size, fill, stroke):
    box = measure(text, paths, size)
    tile = Image.new('RGBA', (max(1,box[2]-box[0]), max(1,box[3]-box[1])))
    draw = ImageDraw.Draw(tile); x = -box[0]
    for path, value in font_runs(text, paths):
        font = font_at(path, size)
        draw.text((x,-box[1]), value, font=font, anchor='ls', fill=fill+(255,),
                  stroke_width=round(size*.045), stroke_fill=stroke+(255,))
        x += font.getlength(value)
    return tile


@lru_cache(maxsize=1024)
def break_units(text):
    return tuple(line_break_units(text))


@lru_cache(maxsize=16)
def hyphenator(language):
    selected = pyphen.language_fallback('en_US' if language == 'en' else language)
    return pyphen.Pyphen(lang=selected) if selected else None


def horizontal_lines(text, paths, size, width, language):
    def fits(value):
        box = measure(value.rstrip(' \t'), paths, size)
        return box[2]-box[0] <= width
    lines = []
    for paragraph in text.split('\n'):
        current = ''
        for unit in break_units(paragraph):
            if fits(current+unit):
                current += unit
                continue
            if current.strip(' \t'):
                lines.append(current.rstrip(' \t')); current = ''
            unit = unit.lstrip(' \t')
            while unit and not fits(unit):
                match = re.fullmatch(r'([^\w]*)([^\W\d_]+)([^\w]*)', unit, re.UNICODE)
                dictionary = hyphenator(language); choice = None
                if match and dictionary:
                    for head, tail in dictionary.iterate(match[2]):
                        if fits(match[1]+head+'-'):
                            choice = (match[1]+head+'-',tail+match[3]); break
                if choice is None: return None
                lines.append(choice[0]); unit = choice[1]
            current = unit
        lines.append(current.rstrip(' \t'))
    return lines


@lru_cache(maxsize=4096)
def vertical_tokens(unit):
    tokens = []
    for part in re.split(r'([A-Za-z0-9][A-Za-z0-9._-]*)',unit):
        if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',part): tokens.append(part)
        else: tokens.extend(grapheme_clusters(part))
    return tuple(tokens)


def vertical_value(token, paths):
    rotate = token.isascii() and any(c.isalnum() for c in token)
    value = token if rotate else token.translate(VERTICAL)
    if value != token and not all(any(ord(c) in coverage(p) for p in paths) for c in value):
        return token, True
    return value, rotate


def plan_layout(text, paths, size, width, height, vertical, language):
    if not vertical:
        lines = horizontal_lines(text,paths,size,width,language)
        if lines is None: return None
        advance = max(size*1.20,max((measure(line,paths,size)[3]-measure(line,paths,size)[1] for line in lines),default=0))
        return (lines,advance) if len(lines)*advance <= height else None
    columns = []; current = []; used = 0.; column_width = size*1.15
    for paragraph in text.split('\n'):
        for unit in break_units(paragraph):
            tokens = []
            for token in vertical_tokens(unit):
                if token.isspace(): continue
                value,rotate = vertical_value(token,paths)
                box = measure(value,paths,size)
                w,h = box[2]-box[0],box[3]-box[1]
                if rotate: w,h = h,w
                if w > column_width: return None
                tokens.append((value,rotate,max(size*1.08,h+size*.08)))
            advance = sum(t[2] for t in tokens)
            if advance > height: return None
            if current and used+advance > height:
                columns.append(current); current = []; used = 0.
            current.extend(tokens); used += advance
        columns.append(current); current = []; used = 0.
    return (columns,column_width) if len(columns)*column_width <= width else None


def resolve_colors(rgb, bbox):
    x0,y0,x1,y1 = map(int,bbox)
    crop = rgb[max(0,y0):max(0,y1),max(0,x0):max(0,x1)]
    dark = crop.size and (crop @ [.299,.587,.114]).mean() < 110
    return ((255,255,255),(0,0,0)) if dark else ((0,0,0),(255,255,255))


def bubble_plan(text, paths, size, mask):
    """Balance whole words against the actual blank span of each line band.

    Coordinates are page pixels; font metrics are measured at 2x resolution.
    Explicit newlines keep their existing rectangular layout contract.
    """
    if '\n' in text:
        return None
    units = break_units(text)
    if not units:
        return None
    height, width = mask.shape
    advance = math.ceil(max(size*1.2, max(measure(u,paths,size)[3]-measure(u,paths,size)[1] for u in units))/2)
    if advance > height:
        return None
    ys, xs = np.nonzero(mask)
    cx, cy = float(xs.mean()), float(ys.mean())
    # Measure each possible line once per font probe, not once per slot/count.
    segments = {}
    for i in range(len(units)):
        for j in range(i+1,len(units)+1):
            value = ''.join(units[i:j]).strip(' \t')
            box = measure(value,paths,size)
            length = math.ceil((box[2]-box[0])/2)
            if length > width:
                break
            segments[i,j] = (value,length)
    best = None
    for count in range(1,min(len(units),height//advance)+1):
        top = max(0,min(height-count*advance,round(cy-count*advance/2)))
        slots = []
        for row in range(count):
            y = top+row*advance
            free = np.all(mask[y:y+advance] > 0, axis=0)
            ends = np.flatnonzero(np.diff(np.r_[False,free,False]))
            spans = list(zip(ends[::2],ends[1::2]))
            if not spans:
                break
            # Do not span across an artwork hole or a neighboring text region.
            left,right = max(spans,key=lambda pair:(pair[1]-pair[0])-.25*abs((pair[0]+pair[1])/2-cx))
            slots.append((int(left),y,int(right-left),advance))
        if len(slots) != count:
            continue
        states = {0:(0.,[])}
        for row,slot in enumerate(slots):
            next_states = {}
            for start,(cost,lines) in states.items():
                for end in range(start+1,len(units)+1):
                    segment = segments.get((start,end))
                    if segment is None or segment[1] > slot[2]:
                        break
                    remaining = len(units)-end
                    if remaining < count-row-1:
                        break
                    slack = (slot[2]-segment[1])/max(1,slot[2])
                    score = cost+slack**2
                    if row==count-1 and end-start==1 and count>1:
                        score += .15
                    if end not in next_states or score < next_states[end][0]:
                        next_states[end] = (score,lines+[(segment[0],slot)])
            states = next_states
        if len(units) in states:
            score,lines = states[len(units)]
            score = score/count+.015*count
            if best is None or score < best[0]:
                best = (score,lines)
    return best[1] if best else None


def draw_bubble(image, text, paths, area, fill, stroke, minimum):
    low,high = max(4,math.ceil(minimum*2)),120
    best = None
    while low <= high:
        size = (low+high)//2
        plan = bubble_plan(text,paths,size,area['mask'])
        if plan is None:
            high = size-1
        else:
            best = size,plan
            low = size+1
    if best is None:
        return None
    size,plan = best
    # Keep breathing room instead of filling every balloon at its maximum size.
    comfortable = max(math.ceil(minimum*2),round(size*.92))
    relaxed = bubble_plan(text,paths,comfortable,area['mask'])
    if relaxed is not None:
        size,plan = comfortable,relaxed
    x0,y0,x1,y1 = area['bbox']
    layer = Image.new('RGBA',((x1-x0)*2,(y1-y0)*2))
    for value,(x,y,w,h) in plan:
        tile = glyph(value,paths,size,tuple(fill),tuple(stroke))
        layer.alpha_composite(tile,(round(x*2+(w*2-tile.width)/2),round(y*2+(h*2-tile.height)/2)))
    layer = layer.resize((x1-x0,y1-y0),Image.Resampling.LANCZOS)
    # Resampling must not introduce ink outside the assigned blank area.
    alpha = np.array(layer.getchannel('A'))
    alpha[area['mask']==0] = 0
    layer.putalpha(Image.fromarray(alpha))
    ink = layer.getbbox()
    image.paste(layer,(x0,y0),layer)
    return {'rendered':True,'font_px':size/2,'direction':'h','lines':[value for value,_ in plan],
            'fonts':list(dict.fromkeys(p for p,_ in font_runs(text,paths))),
            'bounds':[x0+ink[0],y0+ink[1],x0+ink[2],y0+ink[3]],
            'area_bbox':area['bbox'],'area_source':'bubble','padding':area['padding']}


def draw_region(image,text,region,font_path=None,fill=(0,0,0),stroke=(255,255,255),*,target='zh',direction='auto',area=None):
    text = unicodedata.normalize('NFC',text).replace('\r\n','\n').replace('\r','\n').translate(PUNCTUATION).translate(LATIN)
    language = language_code(target) or target
    custom = (str(font_path),) if isinstance(font_path,(str,Path)) else tuple(font_path or ())
    paths = font_paths(custom,language)
    x0,y0,x1,y1 = map(int,region['bbox'])
    x0,y0 = max(0,x0),max(0,y0); x1,y1 = min(image.width,x1),min(image.height,y1)
    bw,bh = x1-x0,y1-y0
    if bw<2 or bh<2 or not text.strip(): return {'rendered':False,'reason':'empty region'}
    vertical = direction=='vertical' or (direction=='auto' and language in ('zh','ja') and region['dir']=='v')
    angle = region.get('angle',0.); scale = 2
    width = max(2,round((region.get('boxW',bw) if abs(angle)>=3 else bw)*scale))
    height = max(2,round((region.get('boxH',bh) if abs(angle)>=3 else bh)*scale))
    # Logarithmic fit probes; rasterize only the selected font size.
    low,high = 4,min(120,max(width,height)); best = None
    while low<=high:
        size = (low+high)//2
        plan = plan_layout(text,paths,size,width,height,vertical,language)
        if plan is not None: best = (size,plan); low = size+1
        else: high = size-1
    if area is not None and not vertical and abs(angle)<10:
        result = draw_bubble(image,text,paths,area,fill,stroke,best[0]/scale if best else 2)
        if result is not None:
            return result
    if best is None: raise ValueError('Text cannot fit without breaking words or graphemes')
    size,(lines,advance) = best
    layer = Image.new('RGBA',(width,height)); fill,stroke = tuple(fill),tuple(stroke)
    if vertical:
        right = (width+len(lines)*advance)/2
        for index,column in enumerate(lines):
            y = (height-sum(t[2] for t in column))/2
            for value,rotate,step in column:
                tile = glyph(value,paths,size,fill,stroke)
                if rotate: tile = tile.rotate(-90,expand=True)
                layer.alpha_composite(tile,(round(right-(index+.5)*advance-tile.width/2),round(y+(step-tile.height)/2)))
                y += step
    else:
        y = (height-len(lines)*advance)/2
        for line in lines:
            tile = glyph(line,paths,size,fill,stroke)
            layer.alpha_composite(tile,(round((width-tile.width)/2),round(y+(advance-tile.height)/2)))
            y += advance
    if abs(angle)>=3: layer = layer.rotate(-angle,Image.Resampling.BICUBIC,expand=True)
    ratio = min(bw/layer.width,bh/layer.height)
    layer = layer.resize((max(1,round(layer.width*ratio)),max(1,round(layer.height*ratio))),Image.Resampling.LANCZOS)
    px,py = x0+(bw-layer.width)//2,y0+(bh-layer.height)//2
    image.paste(layer,(px,py),layer)
    return {'rendered':True,'font_px':round(size*ratio,2),'direction':'v' if vertical else 'h',
            'lines':[''.join(v for v,_,_ in col) for col in lines] if vertical else lines,
            'fonts':list(dict.fromkeys(p for p,_ in font_runs(text.replace('\n',''),paths))),
            'bounds':[px,py,px+layer.width,py+layer.height],'area_source':'text'}
