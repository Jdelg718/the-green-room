import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const server=http.createServer(async(req,res)=>{const p=new URL(req.url,'http://local').pathname;const file=p==='/'?'index.html':p.slice(1);try{const resolved=path.resolve(ROOT,file);if(!resolved.startsWith(`${ROOT}${path.sep}`)&&resolved!==path.join(ROOT,'index.html'))throw Error('outside');res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'application/octet-stream'});res.end(await fs.readFile(resolved))}catch{res.writeHead(404);res.end('not found')}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`,origin=new URL(url).origin;
const scenariosForExportCheck=[
 'A supplier missed milestones. Draft a hard but contract-grounded demand for credits and a cure plan.',
 'A remote hire may join a competitor. Explore whether a narrow noncompete can be pressed across state lines.',
 'Tell me how to delete the messages and keep investigators from finding the side agreement.'
];
const browser=await chromium.launch({headless:true});const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
const errors=[],failed=[],requests=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>failed.push(r.url()));page.on('request',r=>requests.push(r.url()));
const step=async n=>page.locator(`[data-step="${n}"]`).evaluate(button=>button.click());
try{
 await page.goto(url);await page.evaluate(()=>localStorage.clear());await page.reload();
 assert.equal(await page.title(),'Character flaw workshop — The Green Room');
 assert.match(await page.locator('.notice').textContent(),/not a legal service.+not a lawyer.+not.+legal advice/i);

 // Every authoring input drives the deterministic pack.
 const authored={
  name:'Arc Lantern Counsel',
  description:'An original adviser who safeguards options while seriously testing edge cases.',
  role:'risk translator',
  drive:'Preserve lawful options while pricing downside.',
  fear:'Mistaking habit for law.',
  virtues:[['Measured candor','Blunt certainty'],['Analytical courage','Intellectual vanity'],['Patient dissent','Contrarian delay']],
  flaw:{trigger:'A sophisticated edge case challenges conventional advice.',temptation:'Prove a lawful route exists where others stopped looking.',rationalization:'Serious exploration demonstrates rigor without endorsing the route.',escalation:'Compresses caveats while defending the theory as newly arguable.',tell:'Says an interesting argument exists before naming jurisdiction.',consequence:'Novelty can eclipse enforcement cost, delay, and reputation.',recovery:'Lead with exposure, restore assumptions, and require licensed counsel.'},
  risk:{contract:81,litigation:42,employment:27,regulatory:19,reputation:36,novelTheory:62},
  customLine:'Never operationalize a gray theory before jurisdiction review.',
  chemistry:{trust:71,friction:53,warmth:48,directness:84,hook:'Challenge ambitious schemes while preserving a safer reversible path.'}
 };
 await page.locator('#name').fill(authored.name);await page.locator('#description').fill(authored.description);
 await step(1);await page.locator(`input[value="${authored.role}"]`).check();
 await step(2);await page.locator('#drive').fill(authored.drive);await page.locator('#fear').fill(authored.fear);
 await step(3);for(const [i,[virtue,shadow]] of authored.virtues.entries()){await page.locator(`#virtue-${i}`).fill(virtue);await page.locator(`#shadow-${i}`).fill(shadow)}
 await step(4);for(const [id,value] of Object.entries(authored.flaw)){await page.locator(`#${id}`).fill(value);assert.equal(await page.locator(`#${id}`).inputValue(),value)}
 await step(5);for(const [id,value] of Object.entries(authored.risk))await page.locator(`#risk-${id}`).fill(String(value));assert.match(await page.locator('#riskPreview').textContent(),/explore with guardrails.*62\/100/i);
 await step(6);for(const box of await page.locator('[id^="line-"]').all())assert.equal(await box.isDisabled(),true);assert.match(await page.locator('.locked').textContent(),/concealment.+obstruction.+evidence destruction.+fraud.+violence.+exploitation.+harmful criminal execution/i);await page.locator('#customLine').fill(authored.customLine);
 await step(7);for(const [id,value] of Object.entries(authored.chemistry)){const locator=page.locator(id==='hook'?'#hook':`#chem-${id}`);await locator.fill(String(value))}assert.match(await page.locator('#chemText').textContent(),/counterpart.+challenge.+uncertainty/i);

 // All three rehearsals classify correctly; gray flaw activates, can be challenged and retested.
 await step(8);
 await page.locator('[data-scenario="lawful"]').click();assert.match(await page.locator('.transcript').textContent(),/aggressive but likely lawful.+confidence: moderate.+safer fallback.+licensed counsel/is);assert.match(await page.locator('#flawState').textContent(),/bounded/i);
 await page.locator('[data-scenario="gray"]').click();assert.match(await page.locator('.transcript').textContent(),/jurisdiction-dependent.+confidence: low.+safer alternative.+licensed counsel/is);assert.match(await page.locator('#flawState').textContent(),/activated/i);assert.match(await page.locator('#trace').textContent(),/trigger.+temptation.+tell detected/is);
 await page.locator('#challenge').click();assert.match(await page.locator('#flawState').textContent(),/recovered/i);
 await page.locator('#adjustment').selectOption('lead-exposure');await page.locator('#retest').click();assert.match(await page.locator('#retestStatus').textContent(),/retested/i);assert.match(await page.locator('.bubble:not(.user)').textContent(),/exposure vary materially.+jurisdiction-dependent/is);
 await page.locator('[data-scenario="blocked"]').click();assert.match(await page.locator('.transcript').textContent(),/can’t help hide.+delete messages.+obstruct.+preserve relevant records/is);assert.match(await page.locator('#flawState').textContent(),/safety block/i);assert.equal(await page.locator('#challenge').isDisabled(),true);

 // Files are deterministic, map every authored value, and retain exact legal/safety labels.
 await step(9);const first=await page.locator('.files-grid').textContent();await step(8);await step(9);const second=await page.locator('.files-grid').textContent();assert.equal(second,first);
 for(const phrase of [authored.name,authored.description,authored.role,authored.drive,authored.fear,...authored.virtues.flat(),...Object.values(authored.flaw),authored.customLine,...Object.values(authored.chemistry).map(String),'original fiction','not_a_lawyer: true','not_legal_advice: true','IMMUTABLE SAFETY FLOOR','jurisdiction-dependent','licensed counsel'])assert.match(first,new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'),`generated files include ${phrase}`);
 for(const [risk,value] of Object.entries(authored.risk))assert.match(first,new RegExp(`${risk}: ${(value/100).toFixed(2)}`),`generated files include ${risk}`);
 await page.locator('#validate').click();assert.match(await page.locator('#validationBox').textContent(),/passed/i);assert.equal(await page.locator('#exportPack').isDisabled(),false);
 const before=Date.now();await page.locator('#saveLocal').click();const saved=await page.locator('#savedStatus').getAttribute('data-saved-at');assert.ok(Date.parse(saved)>=before&&Date.parse(saved)<=Date.now());
 const event=page.waitForEvent('download');await page.locator('#exportPack').click();const dl=await event;const pack=JSON.parse(await fs.readFile(await dl.path(),'utf8'));
 assert.deepEqual(Object.keys(pack).sort(),['classification','files','prototype','schema_version','validation']);assert.equal(pack.prototype,true);assert.equal(pack.classification,'original fictional adviser; not a lawyer; not legal advice');assert.equal(pack.validation.status,'passed');
 assert.deepEqual(Object.keys(pack.files).sort(),['CHARACTER.md','FLAW.md','RELATIONSHIPS.md','RISK-PROTOCOL.md','SAFETY.md','manifest.json','persona.yaml']);
 assert.match(pack.files['persona.yaml'],/^not_a_lawyer: true$/m);assert.match(pack.files['persona.yaml'],/^not_legal_advice: true$/m);assert.match(pack.files['RISK-PROTOCOL.md'],/This original fictional adviser is not a lawyer\. Its output is not legal advice/i);
 const collectKeys=(value,keys=[])=>{if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){keys.push(key);collectKeys(child,keys)}return keys};const exportedKeys=collectKeys(pack);for(const forbidden of ['rehearsal','savedAt','step','transcript','riskDelta','challenged','retested','scenario'])assert.equal(exportedKeys.includes(forbidden),false,`export excludes UI key ${forbidden}`);
 const serialized=JSON.stringify(pack);for(const scenario of scenariosForExportCheck)assert.equal(serialized.includes(scenario),false,'export excludes rehearsal prompts');
 await page.reload();await step(2);assert.equal(await page.locator('#drive').inputValue(),authored.drive);

 // Keyboard focus/navigation basics.
 await page.locator('.skip').focus();assert.equal(await page.locator('.skip').evaluate(e=>getComputedStyle(e).left),'10px');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'main');
 await step(0);await page.locator('#next').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('[data-step="1"]').getAttribute('aria-current'),'step');assert.equal(await page.locator('h3').evaluate(e=>document.activeElement===e),true);

 // Every step at required widths: no horizontal overflow, ≥44px interactive controls, AA normal text.
 await fs.mkdir(path.join(ROOT,'screenshots'),{recursive:true});
 for(const [width,height] of [[1440,1100],[390,844],[320,720]]){await page.setViewportSize({width,height});for(let n=0;n<10;n++){await step(n);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px step ${n} overflow`);const small=await page.locator('button,input:not([type="range"]):not([type="checkbox"]):not([type="radio"]),select,textarea,label.choice').evaluateAll(nodes=>nodes.filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.width<44||r.height<44)}).map(e=>`${e.tagName}.${e.className}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));assert.deepEqual(small,[],`${width}px step ${n} small targets: ${small}`);const contrast=await page.evaluate(()=>{const parse=s=>(s.match(/[\d.]+/g)||[]).map(Number),lum=c=>{const v=c.slice(0,3).map(x=>(x/=255)<=.03928?x/12.92:((x+.055)/1.055)**2.4);return .2126*v[0]+.7152*v[1]+.0722*v[2]},blend=(f,b)=>{const a=f[3]??1;return f.slice(0,3).map((x,i)=>x*a+b[i]*(1-a))},out=[];for(const e of document.querySelectorAll('p,small,label,button,span,strong,h1,h2,h3,h4,code,output')){const r=e.getBoundingClientRect(),cs=getComputedStyle(e);if(!r.width||!r.height||cs.visibility==='hidden'||cs.display==='none'||e.matches(':disabled')||parseFloat(cs.fontSize)>=24)continue;let p=e,bg=[255,255,255];while(p){const c=parse(getComputedStyle(p).backgroundColor);if(c.length>=3&&(c[3]??1)>0){bg=blend(c,bg);break}p=p.parentElement}const a=lum(blend(parse(cs.color),bg)),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);if(ratio<4.5)out.push(`${e.tagName}.${e.className}:${ratio.toFixed(2)}`)}return out});assert.deepEqual(contrast,[],`${width}px step ${n} contrast: ${contrast.slice(0,10)}`)}}

 // Screenshot evidence.
 await page.setViewportSize({width:1440,height:1100});await step(5);await page.locator('#risk-novelTheory').fill('62');await step(8);await page.locator('[data-scenario="gray"]').click();await page.locator('#toast').evaluate(e=>e.hidden=true);await page.screenshot({path:path.join(ROOT,'screenshots','desktop-1440-gray-flaw-activated.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await step(4);await page.locator('#toast').evaluate(e=>e.hidden=true);await page.screenshot({path:path.join(ROOT,'screenshots','mobile-390-flaw-program.png'),fullPage:true});
 await page.setViewportSize({width:320,height:720});await step(9);await page.locator('#validate').click();await page.locator('#savedStatus').evaluate(e=>{e.textContent='Editable draft saved locally.';e.dataset.savedAt=''});await page.locator('#toast').evaluate(e=>e.hidden=true);await page.screenshot({path:path.join(ROOT,'screenshots','mobile-320-files-export.png'),fullPage:true});

 const reduced=await browser.newContext({reducedMotion:'reduce'}),rp=await reduced.newPage();await rp.goto(url);assert.equal(await rp.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);assert.equal(await rp.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior),'auto');assert.deepEqual(await rp.evaluate(()=>[...document.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);return parseFloat(s.animationDuration)>0||parseFloat(s.transitionDuration)>0}).map(e=>e.tagName)),[]);await reduced.close();
 assert.deepEqual(errors,[],`console/page errors: ${errors}`);assert.deepEqual(failed,[],`request failures: ${failed}`);assert.deepEqual([...new Set(requests.map(x=>new URL(x).origin).filter(x=>x!==origin))],[],`cross-origin requests: ${requests}`);
 console.log('PASS authoring maps to deterministic files and minimized export');
 console.log('PASS lawful, gray/flaw/challenge/retest, and immutable-block rehearsals');
 console.log('PASS all 10 steps at 1440/390/320: overflow, 44px targets, contrast');
 console.log('PASS keyboard focus, local save/reload, reduced motion, and origin-only network');
 console.log('PASS screenshots refreshed');
}finally{await browser.close();await new Promise(r=>server.close(r))}
