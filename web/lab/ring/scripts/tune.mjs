import { LAB, launch, waitReady } from './browser.mjs';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${LAB}/?p=0`);
await waitReady(page);
const unit = 0.5 / (6.2 * Math.tan((14 * Math.PI) / 180));
const trials = JSON.parse(process.argv[2]);
for (const t of trials) {
  const px = await page.evaluate(([t, unit]) => {
    const arc = window.__lab.ring.debug.scene.children[3];
    const { k, ...rest } = t; Object.assign(arc.material, rest); if (k) arc.material.color.setRGB(0.913 * k, 0.376 * k, 0.017 * k);
    arc.material.needsUpdate = false;
    const out = [];
    for (const deg of [-30, 0, 30]) {
      const a = (deg * Math.PI) / 180;
      out.push(window.__lab.probe(0.5 + Math.cos(a) * unit * 1.09, 0.5 + Math.sin(a) * unit * 1.09).slice(0, 3).map(Math.round));
    }
    return out;
  }, [t, unit]);
  console.log(JSON.stringify(t), JSON.stringify(px));
}
await browser.close();
