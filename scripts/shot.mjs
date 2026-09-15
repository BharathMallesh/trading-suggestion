import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:5173/preview.html', { waitUntil: 'networkidle' });
await page.waitForSelector('text=Hi, I', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/buddy-home.png' });
await browser.close();
console.log('saved docs/buddy-home.png');
