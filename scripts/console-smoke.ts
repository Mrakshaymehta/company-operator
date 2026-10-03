// Drives the console in a real browser through the approval task and saves screenshots.
// Needs `pnpm dev` running.   pnpm tsx scripts/console-smoke.ts /tmp/shots
import { chromium } from 'playwright';
const shots = process.argv[2] ?? '/tmp/ui';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1360, height: 1000 } });
await p.goto('http://localhost:4000/#/');
await p.waitForSelector('#task-form');
await p.screenshot({ path: `${shots}/1-home.png`, fullPage: true });
await p.click('text=Swift Cargo invoice (needs approval)');
await p.click('button:has-text("Start task")');
await p.waitForURL(/#\/runs\//);
const t0 = Date.now();
await p.waitForSelector('#approve', { timeout: 600000 });
console.log('approval card after', Math.round((Date.now() - t0) / 1000), 's');
await p.waitForTimeout(800);
await p.screenshot({ path: `${shots}/2-approval.png`, fullPage: true });
await p.click('#approve');
await p.waitForSelector('.banner', { timeout: 600000 });
await p.waitForTimeout(1500);
console.log('finished after', Math.round((Date.now() - t0) / 1000), 's:', await p.textContent('.banner'));
await p.screenshot({ path: `${shots}/3-report.png`, fullPage: true });
await p.goto('http://localhost:4000/#/memory/rajesh-packaging');
await p.waitForSelector('text=Current facts');
await p.screenshot({ path: `${shots}/4-memory.png`, fullPage: true });
await p.goto('http://localhost:4000/#/controls');
await p.waitForSelector('#faults');
await p.screenshot({ path: `${shots}/5-controls.png`, fullPage: true });
await b.close();
