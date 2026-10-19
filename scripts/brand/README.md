# 브랜드 에셋 생성 스크립트

`packages/app/resources/brand/`의 SVG · PNG를 다시 만들 때 쓴다. 결과물은 저장소에 커밋되어 있으므로 평소에는 실행할 필요가 없다.

| 파일 | 역할 |
|---|---|
| `knot.py` | 닫힌 한 가닥 매듭(세잎 등)을 스트로크 SVG로 그리고 교차를 자동으로 엮는 도우미 |
| `make_brand.py` | 확정 심볼로 `icon.svg` `mark.svg` `logo*.svg` `wordmark*.svg` 생성 |
| `make_figma_svg.py` | Figma 편집용 `mark-figma.svg` 생성 (스트로크 패스 3개 + 선형 그라데이션) |
| `render.mjs` | SVG를 Chromium으로 PNG 렌더 (`node render.mjs in.svg out.png W H bg`) |

## 실행

```bash
pip install fonttools            # 워드마크를 패스로 변환
pnpm add -D playwright-core      # 또는 임시 폴더에 설치
python3 scripts/brand/make_brand.py
python3 scripts/brand/make_figma_svg.py
B=packages/app/resources/brand
node scripts/brand/render.mjs $B/icon.svg $B/icon-512.png 512 512 transparent
node scripts/brand/render.mjs $B/logo.svg $B/logo.png 706 320 transparent
```

Chromium 경로는 `render.mjs` 안에 `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`로 고정되어 있다. 다른 환경에서는 그 줄만 바꾼다.

## 확정 사양 (2026-10-19)

- 심볼: 토러스 매듭 (2,3), 반지름 `56 + 36·cos(1.5θ)`, 획 22, 교차 틈 5.
- 색: 가닥을 따라 `#93C5FD → #3B82F6 → #1D4ED8 → … → #93C5FD` 코사인 흐름(한 바퀴 1회, 이음새 없음). 아이콘 판 `#0E0E11`.
- 워드마크: Inter Display SemiBold 대문자, 92px 기준 자간 -3.5, 색 `#0A0A0D` / `#F5F5F7`.
