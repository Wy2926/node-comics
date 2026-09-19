"""Score manually transcribed bubbles; annotations and OCR remain local artifacts."""
import argparse
import json
from pathlib import Path
import unicodedata


def normalize(text):
    # Ignore punctuation/spacing and normalize full-width Latin; retain CJK variants.
    return ''.join(c for c in unicodedata.normalize('NFKC',text) if c.isalnum())


def distance(a,b):
    row=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        nxt=[i]
        for j,y in enumerate(b,1):nxt.append(min(nxt[-1]+1,row[j]+1,row[j-1]+(x!=y)))
        row=nxt
    return row[-1]


def main():
    p=argparse.ArgumentParser();p.add_argument('truth',type=Path);p.add_argument('outputs',nargs='+',type=Path)
    a=p.parse_args();truth=json.loads(a.truth.read_text(encoding='utf-8-sig'));report={}
    for root in a.outputs:
        rows=[]
        for item in truth:
            page=json.loads((root/(item['page']+'.json')).read_text(encoding='utf-8'))
            x0,y0,x1,y1=item['bbox'];selected=[]
            for r in page['regions']:
                rx0,ry0,rx1,ry1=r['bbox'];cx,cy=(rx0+rx1)/2,(ry0+ry1)/2
                if x0<=cx<=x1 and y0<=cy<=y1:selected.append(r['text'])
            expected=normalize(item['text']);actual=normalize(''.join(selected))
            rows.append({'page':item['page'],'reference_chars':len(expected),'errors':distance(expected,actual),
                         'exact':expected==actual,'found':bool(selected)})
        n=sum(r['reference_chars'] for r in rows);errors=sum(r['errors'] for r in rows)
        report[root.name]={'bubbles':len(rows),'reference_chars':n,'errors':errors,'cer':errors/n,
                           'exact_bubbles':sum(r['exact'] for r in rows),'found_bubbles':sum(r['found'] for r in rows),'rows':rows}
    out=Path('artifacts/quality-review/metrics.json');out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({k:{a:b for a,b in v.items() if a!='rows'} for k,v in report.items()},indent=2))

if __name__=='__main__':main()
