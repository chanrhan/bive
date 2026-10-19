"""Figma 편집용 SVG: 가닥을 6개의 굵은 스트로크 패스(기본 3 + 교차 위 조각 3)로만 구성해 Figma에서 벡터로 바로 편집 가능하게 만든다.
색은 Figma가 지원하는 선형 그라데이션으로 근사하고, 레이어 이름을 id로 남긴다."""
import math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import knot as K
OUT = Path(__file__).resolve().parents[2] / "packages/app/resources/brand"
T=K.T; F=K.F
def polar(fr, n=720): return [(128+fr(th)*math.cos(th),128+fr(th)*math.sin(th)) for th in [4*math.pi*i/n for i in range(n)]]
pts=polar(lambda th: 56+36*math.cos(1.5*th)); n=len(pts); t=22; gap=5
# 교차 계산 (knots2.knot1 과 동일 규칙)
cr=[]; visits=[]
for a in range(n):
    for b in range(a+3,n):
        if min(abs(a-b),n-abs(a-b))<=2: continue
        h=K.seg_int(pts[a],pts[(a+1)%n],pts[b],pts[(b+1)%n])
        if h: cid=len(cr); cr.append([h[0],h[1],None,a+h[2],b+h[3]]); visits+=[(a+h[2],cid),(b+h[3],cid)]
visits.sort()
for k,(par,cid) in enumerate(visits):
    if cr[cid][2] is None and k%2==0: cr[cid][2]=par
# 아래 가닥 틈: 교차마다 under 파라미터 주변을 비운다 → 가닥을 '틈 사이 구간'들로 분할
unders=sorted([(c[4] if abs(c[2]-c[3])<1e-6 else c[3]) for c in cr])
L=(t+2*gap+12)/2+6   # 틈 반길이(px) 근사 → 인덱스로 환산(세그먼트 평균 길이)
seglen=sum(math.hypot(pts[(i+1)%n][0]-pts[i][0],pts[(i+1)%n][1]-pts[i][1]) for i in range(n))/n
gi=int(L/seglen*0.75)
cuts=[(int(u)-gi, int(u)+gi) for u in unders]
# 기본 가닥 구간: cuts 사이
cuts.sort(); pieces=[]
for k in range(3):
    s=cuts[k][1]; e=cuts[(k+1)%3][0]+(n if k==2 else 0)
    pieces.append([pts[i%n] for i in range(s,e+1)])
def d_of(p): return "M "+" L ".join(f"{F(x)} {F(y)}" for x,y in p)
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bive-gradient" gradientUnits="userSpaceOnUse" x1="40" y1="200" x2="216" y2="56">
      <stop offset="0" stop-color="{T[5]}"/><stop offset="0.5" stop-color="{T[3]}"/><stop offset="1" stop-color="{T[1]}"/>
    </linearGradient>
  </defs>
  <g id="BIVE mark" fill="none" stroke="url(#bive-gradient)" stroke-width="{t}" stroke-linecap="round" stroke-linejoin="round">
''' + "".join(f'    <path id="strand-{i+1}" d="{d_of(p)}"/>\n' for i,p in enumerate(pieces)) + '''  </g>
</svg>
'''
(OUT/"mark-figma.svg").write_text(svg, encoding="utf-8")
print("pieces", [len(p) for p in pieces])
