"use strict";
const fs=require("node:fs"), path=require("node:path"), os=require("node:os"), http=require("node:http");
const vm=require("node:vm"), crypto=require("node:crypto"), assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),{setTimeout:delay}=require("node:timers/promises");
const directory=__dirname, root=process.cwd(), testPath=path.join(root,"tests/event-pass.test.cjs");
const source=fs.readFileSync(testPath,"utf8"), cut=source.indexOf('test("năm học');
const {cloud,btc,teacher,events,studentLogins,rosterRow,admin,supervisor,studentAccessVersion}=
  vm.runInNewContext(source.slice(0,cut)+"\n({...setup(395),studentLogins,rosterRow,admin,supervisor,studentAccessVersion})",{
    require:require("node:module").createRequire(testPath),__dirname:path.dirname(testPath),Buffer,console
  });
cloud.advance(Date.now()-cloud.context.Date.now());
const eventA=events[0].id, eventB=events[1].id;
const fixtureRoster=cloud.post("LIST_ROSTER",btc);
const classes=Array.from({length:12},(_,i)=>(10+Math.floor(i/4))+"A"+(i%4+1));
const profiles=Array.from({length:395},(_,i)=>({...rosterRow(i+1),className:classes[i%classes.length]}));
function ok(result){assert.equal(result.success,true,result.code);return result;}
ok(cloud.post("SAVE_ROSTER",{...btc,schoolYear:fixtureRoster.schoolYear,mode:"update",expectedRevision:fixtureRoster.revision,confirmed:true,rows:profiles}));
const originalBooths=ok(cloud.post("GET_EVENT_VIEW",btc)).records.find(record=>record.id==="booth-config").data.boothList;
const booths=[...originalBooths,...Array.from({length:5},(_,i)=>({id:"perf-"+(i+1),name:"Gian thử "+(i+1),
  location:"Phòng "+(i+1),topic:"Chủ đề thử",description:"Thông tin giả",pin:String(8100+i),icon:"sparkles",color:"blue"}))];
ok(cloud.post("SAVE_EVENT_BOOTHS",{...btc,booths}));
for(const booth of booths.slice(1,7))ok(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId:eventA,email:supervisor,boothId:booth.id,enabled:true}));
const rows=[];
const stampDate=new Date(cloud.context.Date.now()).toISOString();
function row(eventId, boothId, student, ticketNo, status){
  const id=eventId+"::"+boothId+"::"+student.code;
  return ["queue",id,stampDate,JSON.stringify({id,eventId,boothId,studentCode:student.code,studentName:student.name,
    className:student.className,ticketNo,status,createdAt:stampDate,completedAt:status==="completed"?stampDate:undefined})];
}
for(let i=1;i<profiles.length;i++){
  for(let j=0;j<4;j++){
    const booth=booths[(i+j)%booths.length];
    rows.push(row(eventA,booth.id,profiles[i],i+1,i%3===0?"waiting":"completed"));
    if(j<2)rows.push(row(eventB,booth.id,profiles[i],i+1,i%3===0?"waiting":"completed"));
  }
}
for(const booth of booths.slice(0,10))rows.push(row(eventA,booth.id,profiles[0],1,"waiting"));
cloud.seedRows("WorkflowState",rows);
cloud.context.withTeacherAuthLock_(()=>cloud.sheets.get("WorkflowState").insertRowsAfter(1000,3000));
cloud.cache.remove("event-pass-read-v1");
const [fixtureStudent]=studentLogins(cloud,btc,[profiles[0].code],eventA);
const calls=[];
const profileBackend=(action, task)=>{calls.push(action);return {result:task(),metric:{action}};};
const allowedFile=new Set(["passport-layout.js","passport-layout-editor.js","event-admin.js","event-ui.js","event-ui.css","vendor/lucide.js","tailwind.css","lucian-ui.css","event-glass.css","index.html","student-pass.css","student-pass.js","event-roster.js","event-excel.js","event-images.js"]);
const redirects=new Map(), servers=[], tabs=[], measurements=[];
const injected="window.diagnosticMeasure=()=>{}";
const baselineDir=process.env.FS_QR_BASELINE;
const outputName=baselineDir?"ui-before":"ui-after";
let collect=null, slow=false, holdNextRead=false, pendingAction=null;
let chrome;
function server(handler){
  const s=http.createServer(handler);
  servers.push(s);
  return new Promise(resolve=>s.listen(0,"127.0.0.1",()=>resolve("http://127.0.0.1:"+s.address().port)));
}
const headers={"Access-Control-Allow-Origin":"*","Timing-Allow-Origin":"*"};
async function attach(url){
  const s=new WebSocket(url);
  tabs.push(s);
  await new Promise((resolve,reject)=>{s.addEventListener("open",resolve,{once:true});s.addEventListener("error",reject,{once:true});});
  const pending=new Map();
  let next=0;
  s.addEventListener("message",({data})=>{
    const reply=JSON.parse(data);
    if(!reply.id)return;
    const entry=pending.get(reply.id);
    if(!entry)return;
    pending.delete(reply.id);
    if(reply.error)entry.reject(Error(reply.error.message));else entry.resolve(reply.result);
  });
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{
    pending.set(++next,{resolve,reject});s.send(JSON.stringify({id:next,method,params}));
  });
  const run=async expression=>{
    const reply=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
    if(reply.exceptionDetails)throw Error((reply.exceptionDetails.exception?.description||reply.exceptionDetails.text).split("\n")[0]);
    return reply.result.value;
  };
  await cdp("Network.enable");
  await cdp("Network.setBlockedURLs",{urls:["*script.google.com/*","*script.googleusercontent.com/*","https://*/*"]});
  await cdp("Page.enable");
  return {cdp,run};
}
async function run(){
  const resultOrigin=await server(async(req,res)=>{
    const match=redirects.get(req.url.slice(1));
    if(!match||req.method!=="GET"){res.writeHead(404).end();return;}
    redirects.delete(req.url.slice(1));
    if(match.delayMs)await delay(match.delayMs);
    res.writeHead(200,{...headers,"Content-Type":"application/json","Cache-Control":"no-store"}).end(match.body);
  });
  const apiOrigin=await server(async(req,res)=>{
    if(req.method!=="POST"){res.writeHead(405,headers).end();return;}
    try {
      const body=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString("utf8"));
      const baseline=slow, currentLog=collect;
      if(baseline)await delay(700);
      if(body.action===pendingAction)await delay(450);
      const {result,metric}=profileBackend(body.action,()=>cloud.post(body.action,body));
      const encoded=JSON.stringify(result), key=crypto.randomUUID();
      const delayMs=(baseline?350+Buffer.byteLength(encoded)/750:0)+(holdNextRead&&body.action==="GET_EVENT_VIEW"?350:0);
      if(holdNextRead&&body.action==="GET_EVENT_VIEW")holdNextRead=false;
      if(currentLog&&metric)currentLog.push(metric);
      redirects.set(key,{body:encoded,delayMs});
      res.writeHead(302,{...headers,Location:resultOrigin+"/"+key}).end();
    } catch {res.writeHead(500,headers).end();}
  });
  const app=await server((req,res)=>{
    const name=req.url==="/"?"index.html":req.url.slice(1);
    if(name==="trace.js"){res.writeHead(200,{"Content-Type":"text/javascript"}).end(injected);return;}
    if(["lucide","tailwind"].includes(name)){
      res.writeHead(200,{"Content-Type":"text/javascript"}).end(fs.readFileSync("/private/tmp/fsevent-pass-"+name+".js"));return;
    }
    if(/^fsevent-pass-font-(\d+)\.woff2$/.test(name)||name==="fsevent-pass-font.css"){
      res.writeHead(200,{"Content-Type":name.endsWith(".css")?"text/css":"font/woff2"}).end(fs.readFileSync("/private/tmp/"+name));return;
    }
    if(!allowedFile.has(name)){res.writeHead(404).end();return;}
    const saved=baselineDir && path.join(baselineDir,name);
    let body=fs.readFileSync(saved && fs.existsSync(saved)?saved:path.join(root,name),"utf8");
    if(name==="index.html")body=body
      .replace(/<script src="https?:[^"]+"><\/script>/g,"")
      .replace(/<link[^>]+href="https?:[^"]+"[^>]*>/g,"")
      .replace("<style>",'<link rel="stylesheet" href="/fsevent-pass-font.css">'+''+'<style>')
      .replace(/const GOOGLE_SCRIPT_URL="[^"]+"/,'const GOOGLE_SCRIPT_URL="'+apiOrigin+'/mock/exec"')
      .replace("</body>",'<script src="/trace.js"></script></body>');
    res.writeHead(200,{"Content-Type":name.endsWith(".js")?"text/javascript":name.endsWith(".css")?"text/css":"text/html; charset=utf-8"}).end(body);
  });
  const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),"fsevent-current-trace-"));
  chrome=spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless","--disable-gpu","--no-first-run","--disable-background-networking","--disable-background-timer-throttling",
      "--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--remote-debugging-port=0","--user-data-dir="+profileDir,"about:blank"],{stdio:"ignore"});
  const portFile=path.join(profileDir,"DevToolsActivePort");
  for(let i=0;i<80&&!fs.existsSync(portFile);i++)await delay(100);
  const cdpOrigin="http://127.0.0.1:"+fs.readFileSync(portFile,"utf8").split("\n")[0];
  async function client(){
    const target=await fetch(cdpOrigin+"/json/new?about:blank",{method:"PUT"}).then(res=>res.json());
    const page=await attach(target.webSocketDebuggerUrl);
    await page.cdp("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.cdp("Page.navigate",{url:app});
    for(let i=0;i<100;i++){
      try{if(await page.run("typeof diagnosticMeasure==='function' && document.readyState==='complete' && document.getElementById('studentLoginEvent').textContent!=='Đang tải sự kiện…'"))return page;}catch{}
      await delay(40);
    }
    throw Error("Fixture page unavailable");
  }
  cloud.context.withTeacherAuthLock_(()=>{
    const sheet=cloud.sheets.get("WorkflowState");
    for(let i=sheet.rows.length-1;i>0;i--)if(sheet.rows[i][0]==="queue"){
      const data=JSON.parse(sheet.rows[i][3]);
      if(data.studentCode===fixtureStudent.code)sheet.rows.splice(i,1);
      else if(data.boothId==='robotics'&&data.status==='waiting'){data.status='completed';data.completedAt=stampDate;sheet.rows[i][3]=JSON.stringify(data);}
    }
  });cloud.cache.remove("event-pass-read-v1");
  const page=await client();
  const checks=[],positions=[],limits=[];
  const verify=(name,result)=>{assert.equal(result,true,name);checks.push({name,status:"PASS"});};
  const waitFor=async(expression)=>{for(let i=0;i<250;i++){if(await page.run(expression))return;await delay(30);}throw Error("QR fixture timed out: "+expression);};
  await page.run("document.getElementById('studentCodeInput').value="+JSON.stringify(fixtureStudent.code)+";document.getElementById('studentAccessInput').value="+JSON.stringify(fixtureStudent.accessCode)+";submitStudentLogin({preventDefault(){}})");
  await waitFor("currentUser?.role==='student'");
  await page.run("openStudentEvent(activeEvent().id);stopRemoteSync()");await delay(300);
  for(const width of [1280,320,375,390,430]){
    await page.cdp("Emulation.setDeviceMetricsOverride",{width,height:844,deviceScaleFactor:1,mobile:width<700});
    await page.run("window.scrollTo(0,0)");await delay(180);
    fs.writeFileSync(path.join(root,"artifacts/qr-"+(baselineDir?"before":"after")+"-"+width+".png"),Buffer.from((await page.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  }
  if(!baselineDir){
    const visible="getComputedStyle(document.getElementById('studentQrFab')).display!=='none'";
    const rect=()=>page.run("(()=>{const r=document.getElementById('studentQrFab').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,viewport:innerHeight,scroll:scrollY}})()");
    verify("one QR launcher; duplicate main PIN and card prompts removed",await page.run("document.querySelectorAll('[onclick=\"openQrScanner()\"]').length===1&&!document.getElementById('quickBoothPinInput')&&!document.getElementById('studentBoothList').textContent.includes('Quét QR')"));
    verify("FAB belongs directly to body with accessible dialog label",await page.run("document.getElementById('studentQrFab').parentElement===document.body&&document.getElementById('studentQrFab').getAttribute('aria-controls')==='qrScannerModal'&&!!document.getElementById('studentQrFab').getAttribute('aria-label')"));
    const allBooths=[...originalBooths,...Array.from({length:14},(_,i)=>({id:'qr-fixture-'+i,name:'Gian thử QR '+i,location:'Khu thử '+i,topic:'Dữ liệu giả',description:'Mô phỏng',pin:String(7000+i),icon:'sparkles',color:'blue'}))];
    for(const count of [2,6,20]){
      ok(cloud.post('SAVE_EVENT_BOOTHS',{...btc,booths:allBooths.slice(0,count)}));
      await page.run("stopRemoteSync();refreshEventNow()");await waitFor("!remoteBusy&&BOOTHS.length==="+count);
      verify('booth information and order preserved '+count,await page.run("[...document.querySelectorAll('#studentBoothList .booth-card')].every((card,i)=>card.textContent.includes(BOOTHS[i].name)&&card.textContent.includes(BOOTHS[i].location)&&card.textContent.includes('Chi tiết')&&!!card.querySelector('[data-lucide=\"'+BOOTHS[i].icon+'\"]'))"));
      for(const width of [1280,320,375,390,430]){
        await page.cdp('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<700});
        await page.run('window.scrollTo(0,0)');await delay(80);
        const start=await rect();verify('FAB visible '+count+'/'+width,await page.run(visible));
        verify('viewport position and circle not clipped '+count+'/'+width,start.x>=15&&start.x+start.width<=width&&Math.abs(start.viewport-start.bottom-16)<1&&start.height>=48);
        const before=calls.length;
        for(const scroll of [250,900,100000]){
          await page.run('window.scrollTo(0,'+scroll+')');await delay(40);const current=await rect();
          verify('fixed during scroll '+count+'/'+width+'/'+scroll,Math.abs(current.x-start.x)<1&&Math.abs(current.y-start.y)<1);
          positions.push({booths:count,viewportWidth:width,requestedScroll:scroll,...current});
          if(count===20&&width===390&&scroll===100000)fs.writeFileSync(path.join(root,'artifacts/qr-after-20-bottom-390.png'),Buffer.from((await page.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
        }
        verify('no scroll API requests '+count+'/'+width,calls.length===before);
        verify('last card and footer clear FAB '+count+'/'+width,await page.run("(()=>{const y=document.getElementById('studentQrFab').getBoundingClientRect().y;return document.querySelector('#studentBoothList .booth-card:last-child').getBoundingClientRect().bottom<y&&document.querySelector('footer').getBoundingClientRect().bottom<y})()"));
        verify('no horizontal overflow '+count+'/'+width,await page.run('document.documentElement.scrollWidth===document.documentElement.clientWidth'));
      }
    }
    const performance=await page.run(`(async()=>{const root=document.getElementById('studentBoothList'),node=root.firstChild,times=[];let previous=performance.now();for(let i=0;i<36;i++){window.scrollBy(0,i%2?-110:140);await new Promise(requestAnimationFrame);const now=performance.now();if(i>3)times.push(now-previous);previous=now;}times.sort((a,b)=>a-b);return {p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],sameDom:root.firstChild===node}})()`);
    verify('20 booths retain DOM during scrolling',performance.sameDom);positions.push({scrollPerformance20Booths:performance});
    const stable=await rect();await page.run("document.querySelector('main').style.transform='translate(25px,40px)';document.getElementById('studentApp').style.filter='blur(0px)';document.getElementById('studentApp').style.contain='paint'");
    const transformed=await rect();verify('ancestor app transform/filter/contain do not move FAB',Math.abs(stable.x-transformed.x)<1&&Math.abs(stable.y-transformed.y)<1);
    await page.run("document.querySelector('main').style.removeProperty('transform');document.getElementById('studentApp').style.removeProperty('filter');document.getElementById('studentApp').style.removeProperty('contain')");
    try{
      await page.cdp('Emulation.setSafeAreaInsets',{insets:{top:0,left:0,right:0,bottom:34}});
      const safe=await rect();verify('safe area adds 34px below FAB',Math.abs(safe.viewport-safe.bottom-50)<1);
    }catch(error){if(/wasn't found|not found|Invalid parameters/.test(error.message))limits.push('CDP safe-area emulation unavailable; real iPhone pending');else throw error;}
    finally{try{await page.cdp('Emulation.setSafeAreaInsets',{insets:{top:0,left:0,right:0,bottom:0}})}catch{}}
    await page.run("window.qrFixture={starts:0,stops:0,clears:0,denied:false};window.Html5Qrcode=class {async start(camera,options,success){qrFixture.starts++;qrFixture.camera=camera.facingMode;qrFixture.decode=success;if(qrFixture.denied)throw new DOMException('fixture denied','NotAllowedError');this.stream=await navigator.mediaDevices.getUserMedia({video:true});qrFixture.stream=this.stream;const video=document.createElement('video');video.srcObject=this.stream;video.autoplay=true;video.muted=true;document.getElementById('qrReader').append(video);}async stop(){this.stream?.getTracks().forEach(track=>track.stop());qrFixture.stops++;}clear(){document.getElementById('qrReader').replaceChildren();qrFixture.clears++;}};");
    await page.cdp("Page.bringToFront");
    await page.run("window.scrollTo(0,0);document.getElementById('studentQrFab').focus()");
    await page.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
    await page.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await waitFor("qrScannerStarted");
    verify('keyboard FAB opens camera via existing scanner',await page.run("qrFixture.starts===1&&qrFixture.camera==='environment'&&qrFixture.stream.getVideoTracks()[0].readyState==='live'"));
    verify('FAB hides while scanner is open',!await page.run(visible));
    await page.run("onScanSuccess('invalid QR fixture')");
    verify('invalid QR stays open with error',await page.run("isQrScannerOpen&&document.getElementById('qrScannerStatus').textContent.includes('không hợp lệ')"));
    const joinBeforeWrong=calls.filter(a=>a==='JOIN_QUEUE').length;
    await page.run('onScanSuccess('+JSON.stringify(JSON.stringify({eventId:eventB,boothId:'robotics',pin:originalBooths[0].pin}))+')');
    verify('other-event QR rejected without JOIN_QUEUE',calls.filter(a=>a==='JOIN_QUEUE').length===joinBeforeWrong&&await page.run('isQrScannerOpen'));
    await page.run('onScanSuccess('+JSON.stringify(JSON.stringify({eventId:eventA,boothId:'robotics',pin:originalBooths[0].pin}))+')');
    await waitFor("!boothJoinInProgress&&!mutationBusy");
    verify('valid QR joins correct booth once',cloud.post('GET_EVENT_VIEW',{studentSession:await page.run('currentUser.studentSession')}).records.filter(r=>r.type==='queue'&&r.data.boothId==='robotics').length===1&&await page.run("currentBoothId==='robotics'"));
    verify('camera stopped after successful scan',await page.run("qrFixture.stream.getTracks().every(t=>t.readyState==='ended')"));
    verify('booth details modal does not overlap FAB',!await page.run(visible));
    await page.run("closeBoothModal();document.getElementById('studentQrFab').click()");await waitFor('qrScannerStarted');
    await page.run('onScanSuccess('+JSON.stringify(JSON.stringify({eventId:eventA,boothId:'robotics',pin:originalBooths[0].pin}))+')');await waitFor('!boothJoinInProgress&&!mutationBusy');
    verify('repeat QR creates no duplicate queue row',cloud.post('GET_EVENT_VIEW',{studentSession:await page.run('currentUser.studentSession')}).records.filter(r=>r.type==='queue'&&r.data.boothId==='robotics').length===1);
    await page.run("closeBoothModal();qrFixture.denied=true;document.getElementById('studentQrFab').click()");await waitFor("!qrScannerStartPromise");
    verify('camera denial retains PIN fallback',await page.run("document.getElementById('qrScannerStatus').textContent.includes('Bạn vẫn có thể nhập mã PIN')&&!document.getElementById('qr-pin-input').disabled"));
    await page.cdp('Emulation.setDeviceMetricsOverride',{width:390,height:380,deviceScaleFactor:1,mobile:true});
    await delay(250);
    await page.run("document.getElementById('qr-pin-input').focus();document.getElementById('qr-pin-input').scrollIntoView({block:'center',behavior:'instant'})");await delay(80);
    verify('PIN remains reachable with keyboard-sized viewport',await page.run("(()=>{const r=document.getElementById('qr-pin-input').getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight&&getComputedStyle(document.getElementById('qr-pin-input')).fontSize==='16px'})()"));
    fs.writeFileSync(path.join(root,'artifacts/qr-pin-small-viewport.png'),Buffer.from((await page.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    verify('PIN is not covered by a toast',await page.run("(()=>{const n=document.getElementById('qr-pin-input'),r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n})()"));
    const pinErrorBefore=await page.run("document.getElementById('qrScannerStatus').textContent");
    await page.run("document.getElementById('qr-pin-input').value='0000';joinBoothByPin('qr-pin-input')");
    verify('wrong PIN reports error without joining',await page.run("isQrScannerOpen&&document.getElementById('qrScannerStatus').textContent!=="+JSON.stringify(pinErrorBefore)));
    await page.run("document.getElementById('qr-pin-input').value="+JSON.stringify(originalBooths[1].pin)+";document.querySelector('#qrScannerModal form').requestSubmit()");await waitFor('!boothJoinInProgress&&!qrScanHandling&&!mutationBusy');
    verify('correct PIN works after camera denial',await page.run("currentBoothId==='chemistry'&&!isQrScannerOpen"));
    await page.run("closeBoothModal();document.getElementById('studentQrFab').focus();document.getElementById('studentQrFab').click()");await waitFor('!qrScannerStartPromise');
    await page.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await waitFor('!isQrScannerOpen');await delay(80);
    verify('Escape closes scanner, restores FAB and keyboard focus',await page.run(visible+"&&document.activeElement.id==='studentQrFab'"));
    await page.run("showToast('Thông báo thử QR','info')");
    verify('toast leaves floating action accessible',await page.run("document.getElementById('toastStack').getBoundingClientRect().bottom<document.getElementById('studentQrFab').getBoundingClientRect().top"));
    const auth={studentSession:await page.run('currentUser.studentSession')};
    const joined=cloud.post('GET_EVENT_VIEW',auth).records.find(r=>r.type==='queue'&&r.data.boothId==='robotics');
    ok(cloud.post('TEACHER_COMPLETE',{...teacher,eventId:eventA,boothId:'robotics',ids:[joined.id]}));
    await page.run('stopRemoteSync();refreshEventNow()');await waitFor('!remoteBusy');
    await page.cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.run("document.getElementById('studentPassButton').click()");
    verify('passport and backend-confirmed stamp unaffected',await page.run("document.querySelectorAll('.student-pass-stamp.is-complete').length===1&&document.querySelectorAll('.student-pass-stamp').length===20"));
    verify('passport hides FAB',!await page.run(visible));
    await page.run("document.getElementById('studentPassClose').click();window.qrReloadMarker=true");
    await page.cdp('Page.reload');await waitFor("!window.qrReloadMarker&&document.readyState==='complete'&&currentUser?.role==='student'");await page.run('stopRemoteSync()');
    await waitFor("document.getElementById('studentPassCount').textContent==='1/20'");
    if(await page.run("!document.getElementById('reviewModal').classList.contains('hidden')")){
      verify('review modal also hides FAB',!await page.run(visible));await page.run('closeReviewModal()');
    }
    await waitFor("getComputedStyle(document.getElementById('studentQrFab')).display!=='none'");
    verify('reload restores one FAB and official progress',await page.run(visible+"&&document.querySelectorAll('#studentQrFab').length===1&&document.getElementById('studentPassCount').textContent==='1/20'"));
    await page.run('logout()');verify('FAB hidden after logout',!await page.run(visible));
    limits.push('Native QR decoder callback and camera denial mocked; getUserMedia uses Chrome fake video device. No physical camera or iOS/Android keyboard tested.');

  }
  fs.writeFileSync(path.join(root,"artifacts/qr-"+(baselineDir?"before":"after")+"-results.json"),JSON.stringify({checks,positions,limits,fixture:{students:395,classes:12,queueRecords:cloud.sheets.get("WorkflowState").rows.filter(row=>row[0]==="queue").length},environment:"Chrome localhost, Apps Script/Sheets/OTP mocks; external HTTPS blocked"},null,2));
  console.log(JSON.stringify({checks:checks.length,passed:checks.length,baseline:!!baselineDir}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  for(const s of tabs)s.close();
  chrome?.kill();
  for(const server of servers)server.close();
});
