const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 async function clean(){await page.waitForFunction(()=>!document.querySelector('button[disabled]'));const err=page.locator('[role=alert]');if(await err.count())throw Error(await err.innerText());}
 async function click(text){console.log('Action:',text);await page.getByRole('button',{name:text,exact:true}).click();await clean();}
 async function sign(){await page.getByRole('region',{name:'Transaction review'}).waitFor();await click('Sign & submit local transaction');await page.getByRole('region',{name:'Transaction review'}).waitFor({state:'detached'});}
 try{
 await page.goto('http://127.0.0.1:5180');await page.getByRole('button',{name:'Add test SOL',exact:true}).waitFor();await click('Add test SOL');await click('Create a launch →');await page.getByLabel('Token name',{exact:true}).fill('Browser round');await click('Review campaign transaction');await sign();await page.getByRole('heading',{name:'Browser round',exact:true}).waitFor();
 await page.getByLabel('Test wallet',{exact:true}).selectOption('1');await clean();await click('Add test SOL');await page.getByLabel('Contribution · SOL',{exact:true}).fill('3');await click('Review contribution');await sign();
 await page.getByText('Local rehearsal controls',{exact:true}).click();await click('Advance to funding close');await click('Execute the launch');await sign();await click('Claim tokens & excess SOL');await sign();await page.getByRole('heading',{name:'Continue trading'}).waitFor();
 await page.getByLabel('Direction',{exact:true}).selectOption('sell');await page.getByLabel('Amount · COMM',{exact:true}).fill('1000');await click('Review trade');await sign();
 await click('Add test SOL');await click('Add test SOL');await page.getByLabel('Direction',{exact:true}).selectOption('buy');await page.getByLabel('Amount · SOL',{exact:true}).fill('20');await click('Review trade');await sign();await click('Complete DAMM v2 migration');await sign();await page.getByLabel('Direction',{exact:true}).selectOption('sell');await page.getByLabel('Amount · COMM',{exact:true}).fill('1000');await click('Review trade');await sign();
 await page.screenshot({path:'browser-desktop.png',fullPage:true});
 await page.getByLabel('Test wallet',{exact:true}).selectOption('0');await clean();await click('Create a launch →');await page.getByLabel('Token name',{exact:true}).fill('Refund rehearsal');await click('Review campaign transaction');await sign();await page.getByRole('heading',{name:'Refund rehearsal',exact:true}).waitFor();
 await page.getByLabel('Test wallet',{exact:true}).selectOption('2');await clean();await click('Add test SOL');await page.getByLabel('Contribution · SOL',{exact:true}).fill('1');await click('Review contribution');await sign();await click('Withdraw contribution');await sign();await page.getByLabel('Contribution · SOL',{exact:true}).fill('0.5');await click('Review contribution');await sign();await page.getByText('Local rehearsal controls',{exact:true}).click();await click('Advance to funding close');await click('Recover contribution');await sign();

 await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(300);await page.screenshot({path:'browser-mobile.png',fullPage:false});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile page overflows');assert.deepEqual(errors,[]);
 fs.writeFileSync('browser-result.json',JSON.stringify({passed:true,flows:['create','contribute','advance close','settle','claim excess and tokens','DBC sell','DBC graduation','DAMM migration','DAMM sell','withdraw and redeposit','underfunded refund'],pageErrors:errors,mobileOverflow:false},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
