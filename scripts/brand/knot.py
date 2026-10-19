"""닫힌 한 가닥 매듭(세잎 등)을 스트로크 SVG로 그리는 도우미. 모든 자기 교차를 찾아 가닥 진행 순서대로 위아래를 번갈아 엮는다."""
import math

T=["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#2563EB","#1D4ED8","#1E3A8A"]  # 파랑 명암 단계
F=lambda v:f"{v:.2f}"
def svg(b): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">{b}</svg>'
def d_of(pts,closed=False): return "M "+" L ".join(f"{F(x)} {F(y)}" for x,y in pts)+(" Z" if closed else "")

def hexmix(a,b,u):
    pa=[int(a[i:i+2],16) for i in (1,3,5)]; pb=[int(b[i:i+2],16) for i in (1,3,5)]
    return "#"+"".join(f"{round(pa[i]+(pb[i]-pa[i])*u):02x}" for i in range(3))

def tone_at(u, stops):  # u in [0,1), stops: list of colors cycled
    u=round(u*360)/360 % 1.0
    k=len(stops); x=u*k; i=int(x)%k; return hexmix(stops[i],stops[(i+1)%k],x-int(x))

def seg_int(p,q,r,s):
    d=(q[0]-p[0])*(s[1]-r[1])-(q[1]-p[1])*(s[0]-r[0])
    if abs(d)<1e-9: return None
    t=((r[0]-p[0])*(s[1]-r[1])-(r[1]-p[1])*(s[0]-r[0]))/d; u=((r[0]-p[0])*(q[1]-p[1])-(r[1]-p[1])*(q[0]-p[0]))/d
    if 0<=t<1 and 0<=u<1: return (p[0]+t*(q[0]-p[0]), p[1]+t*(q[1]-p[1]), t, u)
    return None

def knot1(pts, width, color, gap=5, uid="k", hi=None):
    """한 가닥 닫힌 매듭. width(u) · color(u)는 파라미터 함수. hi: 하이라이트 색(옵션)."""
    n=len(pts); cr=[]; visits=[]
    for a in range(n):
        for b in range(a+3,n):
            if min(abs(a-b),n-abs(a-b))<=2: continue
            h=seg_int(pts[a],pts[(a+1)%n],pts[b],pts[(b+1)%n])
            if h: cid=len(cr); cr.append([h[0],h[1],None,a+h[2],b+h[3]]); visits+= [(a+h[2],cid),(b+h[3],cid)]
    visits.sort()
    for k,(par,cid) in enumerate(visits):
        if cr[cid][2] is None and k%2==0: cr[cid][2]=par
    for c in cr:
        if c[2] is None: c[2]=c[3]
    tmax=max(width(i/n) for i in range(n))
    rects=""
    for x,y,par,_,_ in cr:
        i=int(par)%n; a=pts[i]; b=pts[(i+1)%n]; ang=math.degrees(math.atan2(b[1]-a[1],b[0]-a[0]))
        w=width(par/n)+2*gap; L=tmax+2*gap+12
        rects+=f'<rect x="{F(x-L/2)}" y="{F(y-w/2)}" width="{L}" height="{w}" fill="#000" transform="rotate({F(ang)} {F(x)} {F(y)})"/>'
    def runs(idx_list, cap):
        """연속 인덱스를 (색, 굵기) 가 같은 구간으로 묶어 연속 패스로 그린다."""
        out=""; cur=None; buf=[]
        def flush():
            nonlocal out, buf
            if len(buf)>=2:
                c,w=cur; out+=f'<path d="{d_of([pts[k%n] for k in buf])}" fill="none" stroke="{c}" stroke-width="{F(w)}" stroke-linecap="{cap}" stroke-linejoin="round"/>'
        for a_,b_ in zip(idx_list, idx_list[1:]):
            u=((a_+b_)/2 % n)/n; key=(color(u), round(width(u)*2)/2)
            if key!=cur:
                if buf: buf.append(b_); flush()
                cur=key; buf=[a_,b_]
            else: buf.append(b_)
        flush(); return out
    def hiruns(idx_list, cap):
        out=""; 
        pts2=[(x-2,y-3) for x,y in pts]
        return f'<path d="{d_of([pts2[k%n] for k in idx_list])}" fill="none" stroke="{hi}" stroke-width="{F(max(2,tmax*0.18))}" stroke-linecap="{cap}" stroke-linejoin="round" opacity="0.85"/>'
    body=f'<mask id="{uid}"><rect width="256" height="256" fill="#fff"/>{rects}</mask><g mask="url(#{uid})">'
    body+=runs(list(range(n+1)), "round")
    if hi: body+=hiruns(list(range(n+1)), "round")
    body+="</g>"
    for x,y,par,_,_ in cr:
        i=int(par); L=tmax+2*gap+14
        js=[i]; acc=0; j=i
        while acc<L/2+6: p,q=pts[j%n],pts[(j+1)%n]; acc+=math.hypot(q[0]-p[0],q[1]-p[1]); j+=1; js.append(j)
        acc=0; j=i
        while acc<L/2+6: p,q=pts[j%n],pts[(j-1)%n]; acc+=math.hypot(q[0]-p[0],q[1]-p[1]); j-=1; js.insert(0,j)
        body+=runs(js, "butt")
        if hi: body+=hiruns(js, "butt")
    return body

def polar(fr, n=720, th1=4*math.pi):
    return [(128+fr(th)*math.cos(th),128+fr(th)*math.sin(th)) for th in [th1*i/n for i in range(n)]]
