"""Find bounded, blank lettering areas independently of the OCR text bounds.

The OCR boxes seed the search and divide shared balloons; they are never enlarged
blindly. Work on the cleaned page before drawing any translations.
"""
import cv2
import numpy as np


def lettering_areas(rgb, regions):
    if not regions:
        return []
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    height, width = gray.shape
    areas = [None] * len(regions)
    boxes = np.asarray([r['bbox'] for r in regions], dtype=int).reshape(-1, 4)
    boxes[:, ::2] = boxes[:, ::2].clip(0, width)
    boxes[:, 1::2] = boxes[:, 1::2].clip(0, height)
    # Opening closes narrow gaps in the outline without filling artwork holes.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    for blank in (gray >= 200, gray <= 55):
        blank = cv2.morphologyEx(blank.astype(np.uint8), cv2.MORPH_OPEN, kernel)
        _, labels, stats, _ = cv2.connectedComponentsWithStats(blank, 8)
        selected = {}
        for index, (x0, y0, x1, y1) in enumerate(boxes):
            if areas[index] is not None or min(x1-x0, y1-y0) < 2:
                continue
            if abs(regions[index].get('angle', 0)) >= 10:
                continue
            ids, counts = np.unique(labels[y0:y1, x0:x1], return_counts=True)
            counts[ids == 0] = 0
            component = int(ids[counts.argmax()])
            bw, bh = x1-x0, y1-y0
            if component == 0 or counts.max() < bw*bh*.55:
                continue
            x, y, w, h, pixels = map(int, stats[component])
            # Reject implausibly large or fragmented background components.
            # Allow a balloon clipped by one page edge, but not a whole page.
            if (pixels > width*height*.65 or pixels > bw*bh*24
                    or w > max(bw*6, bh*3) or h > max(bh*6, bw*3)
                    or (w > width*.8 and h > height*.5)
                    or pixels < w*h*.3):
                continue
            selected.setdefault(component, []).append(index)
        for component, members in selected.items():
            x, y, w, h, _ = map(int, stats[component])
            yy, xx = np.ogrid[y:y+h, x:x+w]
            component_mask = labels[y:y+h, x:x+w] == component
            # Partition a shared balloon by distance to each original text box.
            # Include nearby non-selected regions so their fallback text is safe.
            neighbors = [i for i, (a,b,c,d) in enumerate(boxes)
                         if a < x+w and c > x and b < y+h and d > y]
            owner = np.full((h,w), -1, np.int32)
            nearest = np.full((h,w), np.inf, np.float32)
            for i in neighbors:
                a,b,c,d = boxes[i]
                distance = np.maximum(np.maximum(a-xx, xx-c), 0)**2 + np.maximum(np.maximum(b-yy, yy-d), 0)**2
                take = distance < nearest
                owner[take] = i
                nearest[take] = distance[take]
            for index in members:
                a,b,c,d = boxes[index]
                pad = max(3, min(12, round(min(w,h)*.045)))
                mask = (component_mask & (owner == index)).astype(np.uint8)
                mask = cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (pad*2+1,)*2),
                                 borderType=cv2.BORDER_CONSTANT, borderValue=0)
                if not mask.any():
                    continue
                mx,my,mw,mh = cv2.boundingRect(mask)
                if mw*mh < (c-a)*(d-b)*1.15:
                    continue
                areas[index] = {'bbox':[x+mx,y+my,x+mx+mw,y+my+mh],
                                'mask':mask[my:my+mh,mx:mx+mw], 'padding':pad}
    return areas
