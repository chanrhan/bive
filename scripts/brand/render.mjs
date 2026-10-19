import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const [,, svgPath, outPath, w, h, bg] = process.argv;
const svg = readFileSync(svgPath, 'utf8');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:${bg}">${svg.replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`)}</body></html>`);
await page.screenshot({ path: outPath, omitBackground: bg === 'transparent' });
await browser.close();
