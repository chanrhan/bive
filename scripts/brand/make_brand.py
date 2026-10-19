"""BIVE 아이콘 · 로고 생성기. 심볼: 세잎 매듭(trefoil) 한 가닥, 파랑 명암이 한 바퀴에 밝음→어두움→밝음으로 이음새 없이 흐른다."""
import math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import knot as K
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = Path(__file__).resolve().parents[2] / "packages/app/resources/brand"; OUT.mkdir(parents=True, exist_ok=True)
T=K.T; F=K.F
PLATE="#0E0E11"; DARK="#0A0A0D"
def polar(fr, n=720): return [(128+fr(th)*math.cos(th),128+fr(th)*math.sin(th)) for th in [4*math.pi*i/n for i in range(n)]]
P=polar(lambda th: 56+36*math.cos(1.5*th))
def tone(u, a=T[1], b=T[3], c=T[5]):
    u=round(u*360)/360 % 1.0; w=0.5-0.5*math.cos(2*math.pi*u)
    return K.hexmix(a,b,w*2) if w<0.5 else K.hexmix(b,c,(w-0.5)*2)
def mark(uid="m"): return K.knot1(P, lambda u:22, tone, uid=uid)

icon=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="BIVE 아이콘">
  <rect width="256" height="256" rx="58" fill="{PLATE}"/>
  <g transform="translate(128 128) scale(0.78) translate(-128 -128)">{mark("i")}</g>
</svg>
'''
(OUT/"icon.svg").write_text(icon, encoding="utf-8")
(OUT/"mark.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 20 216 216" width="216" height="216" role="img" aria-label="BIVE 심볼">{mark("s")}</svg>\n', encoding="utf-8")

def text_path(text, font_path, size, x, y, tracking=0.0):
    f=TTFont(font_path); gs,cmap,hmtx=f.getGlyphSet(),f.getBestCmap(),f["hmtx"]
    s=size/f["head"].unitsPerEm; pen=SVGPathPen(gs); cx=x
    for ch in text:
        g=cmap[ord(ch)]; gs[g].draw(TransformPen(pen,(s,0,0,-s,cx,y))); cx+=hmtx[g][0]*s+tracking
    return pen.getCommands(), cx
BOLD="/usr/share/fonts/opentype/inter/InterDisplay-SemiBold.otf"
H=160; sc=0.52; sx,sy=14,(H-216*sc)/2
tx=sx+216*sc+14
word,wend=text_path("BIVE",BOLD,92,tx,H/2+33,tracking=-3.5); W=round(wend+26)
def logo(color):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="BIVE 로고">
  <g transform="translate({sx} {sy:.1f}) scale({sc}) translate(-20 -20)">{mark("l")}</g>
  <path d="{word}" fill="{color}"/>
</svg>
'''
(OUT/"logo.svg").write_text(logo(DARK), encoding="utf-8")
(OUT/"logo-dark.svg").write_text(logo("#F5F5F7"), encoding="utf-8")
print("logo",W,"x",H)

# ── 세로형 로고 (심볼 위, 글자 아래) · 글자 단독 ──────────────────────
INK_L="#0A0A0D"; INK_D="#F5F5F7"
def stacked(color):
    Wv=260; msc=0.62; mh=216*msc; mx=(Wv-mh)/2; my=22
    size=64; d,wend=text_path("BIVE",BOLD,size,0,0,-2.4)
    tw=wend; tx=(Wv-tw)/2; ty=my+mh+14+size*0.72
    Hv=round(ty+16)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {Wv} {Hv}" width="{Wv}" height="{Hv}" role="img" aria-label="BIVE 로고 세로형">
  <g transform="translate({mx:.1f} {my}) scale({msc}) translate(-20 -20)">{mark("v")}</g>
  <g transform="translate({tx:.1f} {ty:.1f})"><path d="{d}" fill="{color}"/></g>
</svg>
'''
(OUT/"logo-stacked.svg").write_text(stacked(INK_L), encoding="utf-8")
(OUT/"logo-stacked-dark.svg").write_text(stacked(INK_D), encoding="utf-8")
def wordmark_only(color):
    size=92; d,wend=text_path("BIVE",BOLD,size,16,size*0.74+8,-3.5); Ww=round(wend+16); Hw=round(size*0.74+24)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {Ww} {Hw}" width="{Ww}" height="{Hw}" role="img" aria-label="BIVE 워드마크"><path d="{d}" fill="{color}"/></svg>\n'
(OUT/"wordmark.svg").write_text(wordmark_only(INK_L), encoding="utf-8")
(OUT/"wordmark-dark.svg").write_text(wordmark_only(INK_D), encoding="utf-8")
print("stacked/wordmark written")
