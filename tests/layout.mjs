// SPDX-License-Identifier: GPL-3.0+
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function testWidgetSizing(page, { artifactDirectory = 'artifacts/widget-framebuffers' } = {}) {
  const card = '[data-widget="rom"]';
  const handle = `${card} .widget-resize`;
  const rect = selector => page.$eval(selector, el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; });
  await mkdir(artifactDirectory,{recursive:true});
  const frames=[];
  async function capture(name) {
    const menuOpen = await page.$eval('#layout-menu', el => !el.hidden);
    if (menuOpen) await page.click('#btn-layout-menu-close');
    await page.evaluate(()=>window.scrollTo(0,0)); await settle();
    const bytes=await page.screenshot({path:`${artifactDirectory}/${name}.png`,fullPage:true});
    frames.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),card:await rect(card)});
    if (menuOpen) await page.click('#btn-layout-menu');
  }
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function drag(dx, dy) {
    await page.$eval(handle, el => el.scrollIntoView({ block:'center' }));
    const r = await rect(handle);
    const x = r.x+r.width/2, y=r.y+r.height/2;
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x+dx,y+dy,{steps:15}); await page.mouse.up(); await settle();
  }
  async function assertNoOverlap() {
    const boxes = await page.$$eval('#widget-grid > .card:not([hidden])', cards => cards.map(el => { const r = el.getBoundingClientRect(); return {id:el.dataset.widget,x:r.x,y:r.y,right:r.right,bottom:r.bottom}; }));
    for (let i=0;i<boxes.length;i++) for (let j=i+1;j<boxes.length;j++) {
      const a=boxes[i],b=boxes[j];
      assert.ok(a.right<=b.x+1 || b.right<=a.x+1 || a.bottom<=b.y+1 || b.bottom<=a.y+1, `Widgets overlap: ${a.id} and ${b.id}`);
    }
  }
  await page.setViewport({width:1440,height:1200});
  await settle();
  const original = await rect(card);
  await capture("desktop-default");
  const colStep = await page.$eval('#widget-grid', el => Number.parseFloat(getComputedStyle(el).gridTemplateColumns)+Number.parseFloat(getComputedStyle(el).columnGap));
  await drag(colStep,100);
  const grown = await rect(card);
  assert.ok(grown.width > original.width*1.8, 'Dragging corner should widen widget to two columns');
  assert.ok(Math.abs(grown.height-original.height-100)<=6, 'Dragging corner should increase rendered height');
  await assertNoOverlap();
  await capture("desktop-resized");
  await page.reload({waitUntil:'networkidle0'});
  await page.waitForFunction(({selector,width,height}) => {
    const r = document.querySelector(selector)?.getBoundingClientRect();
    return r && Math.abs(r.width-width)<2 && Math.abs(r.height-height)<2;
  }, {timeout:5000}, {selector:card,width:grown.width,height:grown.height});
  await settle();
  const restored = await rect(card);
  assert.ok(Math.abs(restored.width-grown.width)<2 && Math.abs(restored.height-grown.height)<2, 'Actual resized dimensions should survive reload');
  await drag(-colStep,80-restored.height);
  const shrunk = await rect(card);
  assert.ok(Math.abs(shrunk.height-80)<=1, 'Widget should shrink to 80px minimum');
  assert.ok(Math.abs(shrunk.width-original.width)<=2, 'Widget should shrink to one column');
  // Scrolling a small widget must leave the resize grip at its visible corner.
  await page.$eval(card, el => {
    const content = el.querySelector('.widget-content') || el;
    content.scrollTop=content.scrollHeight;
  }); await settle();
  const grip = await rect(handle), box = await rect(card);
  assert.ok(grip.y >= box.y && grip.y+grip.height <= box.y+box.height, 'Resize grip must stay visible after scrolling widget content');
  const hit = await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.classList.contains('widget-resize'), {x:grip.x+grip.width/2,y:grip.y+grip.height/2});
  assert.equal(hit,true,'Scrolled widget resize grip must receive pointer input');
  await capture('desktop-short-scrolled');
  await drag(0,160);
  assert.ok(Math.abs((await rect(card)).height-240)<=6,'Scrolled widget should resize again');
  await page.click(handle,{clickCount:2}); await settle();
  assert.ok(Math.abs((await rect(card)).height-original.height)<2,'Double-click resets natural height');
  await page.click(`${card} .widget-tool-span`); await settle();
  assert.ok((await rect(card)).width>original.width*1.8,'Width button changes rendered width');
  await page.click('#btn-layout-menu');
  await page.select('[aria-label="Game library width"]','1'); await settle();
  assert.ok(Math.abs((await rect(card)).width-original.width)<2,'Drawer column selection changes rendered width');
  // Real keyboard range input, not a call to the layout controller.
  await page.focus('#layout-widget-width'); await page.keyboard.press('End'); await settle();
  const at480 = await rect(card);
  await capture("width-480");
  await page.focus('#layout-widget-width'); await page.keyboard.press('Home'); await settle();
  const at200 = await rect(card);
  await capture("width-200");
  assert.ok(at480.width > at200.width+100,'Minimum width slider should change actual widget size');
  await page.focus('#layout-gap'); await page.keyboard.press('End'); await settle();
  assert.equal(await page.$eval('#widget-grid',el=>getComputedStyle(el).columnGap),'28px');
  await page.click('#layout-beside-screen'); await settle();
  const screen = await rect('.display'), grid = await rect('#widget-grid');
  assert.ok(grid.y>=screen.y+screen.height,'Below-screen setting should move widget grid below display');
  await capture('widgets-below');
  await page.click('#btn-layout-reset'); await page.keyboard.press('Escape'); await settle();
  // Check actual cross-document storage delivery without dispatching a fake
  // storage event or directly changing the layout controller's state.
  const second = await page.browser().newPage();
  try {
    await second.goto(page.url(),{waitUntil:'networkidle0'});
    await second.waitForFunction(()=>window.PCSX2Layout && !document.getElementById('validate').disabled);
    await second.click('#btn-layout-menu');
    await second.select('[aria-label="Game library width"]','2');
    await page.waitForFunction(selector=>document.querySelector(selector).getBoundingClientRect().width>600,{timeout:5000},card);
    await second.click('#btn-layout-reset');
    await page.waitForFunction(selector=>document.querySelector(selector).getBoundingClientRect().width<400,{timeout:5000},card);
  } finally { await second.close(); }
  await page.bringToFront(); await settle();
  await page.click(`${card} .widget-tool-collapse`); await settle();
  assert.ok((await rect(card)).height<original.height/2,'Collapsed widget should shrink');
  await page.click(`${card} .widget-tool-collapse`); await settle();
  await assertNoOverlap();
  for (const width of [900,800,390]) {
    await page.setViewport({width,height:1000}); await settle();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`No overflow at ${width}px`);
    await assertNoOverlap();
    await capture(`viewport-${width}`);
  }
  const mobileHeight = (await rect(card)).height;
  await drag(0,100);
  assert.ok((await rect(card)).height>mobileHeight+80,'Mobile-sized widget can resize vertically');
  // Touch events use the browser's pointer capture path, including movement
  // away from the small grip, without synthesizing DOM resize events.
  await page.setViewport({width:390,height:1000,hasTouch:true,isMobile:true});
  await page.$eval(handle,el=>el.scrollIntoView({block:'center'})); await settle();
  const touchBefore = await rect(card), touchGrip = await rect(handle);
  const client = await page.createCDPSession();
  const x = touchGrip.x+touchGrip.width/2, y = touchGrip.y+touchGrip.height/2;
  try {
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let step=1;step<=10;step++) await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+step*8}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  } finally { await client.detach(); }
  await settle();
  assert.ok(Math.abs((await rect(card)).height-touchBefore.height-80)<=6,'Touch drag should resize actual widget height');
  await assertNoOverlap();
  await capture('phone-touch-resized');
  await page.setViewport({width:1440,height:1000,hasTouch:false,isMobile:false});
  await page.click('#btn-layout-menu'); await page.click('#btn-layout-reset'); await page.keyboard.press('Escape');
  await page.evaluate(()=>window.scrollTo(0,0)); await settle();
  await writeFile(`${artifactDirectory}/report.json`,JSON.stringify(frames,null,2)+'\n');
}
