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
const baselineDir=process.env.FS_PASS_STYLE_BASELINE_DIR||null;
const beforeDir=process.env.FS_STAMP14_BASELINE_DIR||"/private/tmp/fs-artwork-profile-before";
const baselineAvailable=["index.html","student-pass.js","student-pass.css","event-images.js","event-glass.css"].every(name=>fs.existsSync(path.join(beforeDir,name)));
let collect=null, slow=false, holdNextRead=false, pendingAction=null, apiFault=null;
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
  let acceptNextDialog=true;
  const dialogs=[];
  let next=0;
  s.addEventListener("message",({data})=>{
    const reply=JSON.parse(data);
    if(reply.method==="Page.javascriptDialogOpening"){
      dialogs.push(reply.params.type);
      const accept=acceptNextDialog;acceptNextDialog=true;
      void cdp("Page.handleJavaScriptDialog",{accept});return;
    }
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
  return {cdp,run,dialogs,nextDialog:accept=>{acceptNextDialog=accept}};
}
async function run(){
  events[0].name="STEMDAY · dữ liệu thử";events[1].name="Ngày hội Openday · dữ liệu thử";
  cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");cloud.setProperty("FS_EVENT_PUBLIC_IMAGES","true");
  ok(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventA,events}}));
  ok(cloud.post("SAVE_ROSTER",{...btc,schoolYear:"2027-2028",mode:"skip",confirmed:true,rows:[rosterRow(396)]}));
  const resultOrigin=await server(async(req,res)=>{
    const match=redirects.get(req.url.slice(1));
    if(!match||req.method!=="GET"){res.writeHead(404).end();return;}
    redirects.delete(req.url.slice(1));
    if(match.delayMs)await delay(match.delayMs);
    res.writeHead(200,{...headers,"Content-Type":"application/json","Cache-Control":"no-store"}).end(match.body);
  });
  const apiOrigin=await server(async(req,res)=>{
    if(!["POST","GET"].includes(req.method)){res.writeHead(405,headers).end();return;}
    try {
      const body=req.method==="GET"?Object.fromEntries(new URL(req.url,"http://fixture").searchParams):JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString("utf8"));
      const baseline=slow, currentLog=collect;
      if(baseline)await delay(700);
      if(body.action===pendingAction)await delay(450);
      if(apiFault===401){res.writeHead(401,{...headers,"Content-Type":"text/html"}).end("fixture permission denial");return;}
      let {result,metric}=profileBackend(body.action,()=>apiFault==="image-denied"&&body.action==="SAVE_EVENT_IMAGE"?
        {success:false,code:"IMAGE_UNAVAILABLE",message:"Lỗi ghi ảnh giả lập"}:req.method==="GET"?JSON.parse(cloud.get(body).value):cloud.post(body.action,body));
      if(apiFault==="image-metadata"&&body.action==="SAVE_EVENT_IMAGE"&&result.success)result={success:true};
      if(apiFault==="legacy" && ["GET_EVENT_VIEW","GET_EVENT_API_VERSION"].includes(body.action)){
        result={...result};delete result.studentAccessVersion;
      }
      if(apiFault==="public-unchanged" && body.action==="GET_EVENT_VIEW" && !body.studentSession){
        result={success:true,apiVersion:result.apiVersion,studentAccessVersion:result.studentAccessVersion,studentLoginEnabled:true,unchanged:true};
      }
      if(apiFault==="activation-missing"&&body.action==="GET_EVENT_SETUP"){result={...result};delete result.eventActivationVersion;}
      if(apiFault==="variants-missing"&&body.action==="GET_EVENT_SETUP"&&result.event?.images)delete result.event.images.passportVariantsVersion;
      if(body.action==="GET_EVENT_VIEW"&&!result.success) console.error(JSON.stringify({stage:"fixture-view",code:result.code}));
      const encoded=JSON.stringify(result), key=crypto.randomUUID();
      const delayMs=(baseline?350+Buffer.byteLength(encoded)/750:0)+(holdNextRead&&body.action==="GET_EVENT_VIEW"?350:0);
      if(holdNextRead&&body.action==="GET_EVENT_VIEW")holdNextRead=false;
      if(currentLog&&metric)currentLog.push(metric);
      redirects.set(key,{body:encoded,delayMs});
      res.writeHead(302,{...headers,Location:resultOrigin+"/"+key}).end();
    } catch {res.writeHead(500,headers).end();}
  });
  const app=await server((req,res)=>{
    const pathname=new URL(req.url,"http://fixture").pathname, before=pathname.startsWith("/before/");
    const name=pathname==="/"?"index.html":pathname.replace(/^\/before\//,"/").slice(1);
    if(name==="trace.js"){res.writeHead(200,{"Content-Type":"text/javascript"}).end(injected);return;}
    if(["lucide","tailwind"].includes(name)){
      res.writeHead(200,{"Content-Type":"text/javascript"}).end(fs.readFileSync("/private/tmp/fsevent-pass-"+name+".js"));return;
    }
    if(/^fsevent-pass-font-(\d+)\.woff2$/.test(name)||name==="fsevent-pass-font.css"){
      res.writeHead(200,{"Content-Type":name.endsWith(".css")?"text/css":"font/woff2"}).end(fs.readFileSync("/private/tmp/"+name));return;
    }
    const artworkFiles={"profile-reference-desktop.png":"/Users/user/Downloads/FPT_Open_STEM_Day_Ngang_HoTen_Lop.png","profile-reference-mobile.png":"/Users/user/Downloads/FPT_Open_STEM_Day_Doc_393x852_DPR3_HoTen_Lop.png"};
    if(artworkFiles[name]){res.writeHead(200,{"Content-Type":"image/png"}).end(fs.readFileSync(artworkFiles[name]));return;}
    if(!allowedFile.has(name)){res.writeHead(404).end();return;}
    const saved=(before&&baselineAvailable?beforeDir:baselineDir) && path.join(before&&baselineAvailable?beforeDir:baselineDir,name);
    let body=fs.readFileSync(saved && fs.existsSync(saved)?saved:path.join(root,name),"utf8");
    if(name==="index.html")body=body
      .replace(/<script src="https?:[^"]+"><\/script>/g,"")
      .replace(/<link[^>]+href="https?:[^"]+"[^>]*>/g,"")
      .replace("<style>",'<link rel="stylesheet" href="/fsevent-pass-font.css">'+(baselineDir?'<script src="/lucide"></script>':'')+'<style>')
      .replace(/const GOOGLE_SCRIPT_URL="[^"]+"/,'const GOOGLE_SCRIPT_URL="'+apiOrigin+'/mock/exec"')
      .replace("</body>",'<script src="/trace.js"></script></body>');
    res.writeHead(200,{"Content-Type":name.endsWith(".js")?"text/javascript":name.endsWith(".css")?"text/css":"text/html; charset=utf-8"}).end(body);
  });
  const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),"fsevent-current-trace-"));
  chrome=spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless","--disable-gpu","--no-first-run","--disable-background-networking","--disable-background-timer-throttling",
      "--remote-debugging-port=0","--user-data-dir="+profileDir,"about:blank"],{stdio:"ignore"});
  const portFile=path.join(profileDir,"DevToolsActivePort");
  for(let i=0;i<80&&!fs.existsSync(portFile);i++)await delay(100);
  const cdpOrigin="http://127.0.0.1:"+fs.readFileSync(portFile,"utf8").split("\n")[0];
  async function client(url=app){
    const target=await fetch(cdpOrigin+"/json/new?about:blank",{method:"PUT"}).then(res=>res.json());
    const page=await attach(target.webSocketDebuggerUrl);
    await page.cdp("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.cdp("Page.navigate",{url});
    for(let i=0;i<100;i++){
      try{if(await page.run("typeof diagnosticMeasure==='function' && document.readyState==='complete' && document.getElementById('studentLoginEvent').textContent!=='Đang tải sự kiện…'"))return page;}catch{}
      await delay(40);
    }
    throw Error("Fixture page unavailable");
  }
  const checks=[];
  const check=(name,result)=>{assert.equal(result,true,name);checks.push({name,status:"PASS"});};
  async function waitFor(page,expression){
    for(let i=0;i<250;i++){if(await page.run(expression))return;await delay(30);}
    throw Error("Mock browser timed out: "+expression.replace(/"[^\"]*"/g,'"…"').slice(0,90));
  }

  const label=baselineDir?'before':'after';
  const allBooths=Array.from({length:20},(_,i)=>i<booths.length?booths[i]:{...booths[0],id:'style-extra-'+i,name:'Gian mẫu '+(i+1),pin:String(8500+i),icon:i%2?'brain':'box'});
  ok(cloud.post('SAVE_EVENT_BOOTHS',{...btc,booths:allBooths.slice(0,15)}));
  const page=await client();
  await page.run('loginAdmin('+JSON.stringify(admin)+','+JSON.stringify(btc.authToken)+',3600)');await page.run("showAdminTab('config');stopRemoteSync()");await waitFor(page,'!!managedEventSetup()');
  async function choose(kind,url,name){
    await page.run('document.getElementById("eventPassportVariant").value='+JSON.stringify(kind)+';document.getElementById("eventPassportVariant").dispatchEvent(new Event("change"))');
    await page.run(`(async()=>{const blob=await fetch(${JSON.stringify(url)}).then(r=>r.blob()),data=new DataTransfer();data.items.add(new File([blob],${JSON.stringify(name)},{type:'image/png'}));const input=document.getElementById('eventPassportFile');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(page,"document.getElementById('eventImagesStatus').textContent.includes('sẵn sàng')");await page.run("document.getElementById('eventPassportSave').click()");await waitFor(page,'!document.getElementById("eventImagesSelect").disabled&&managedEventSetup().event.images.'+kind+'?.version');
  }
  await choose('passport','/profile-reference-desktop.png','FPT_Open_STEM_Day_Ngang_HoTen_Lop.png');await choose('passportMobile','/profile-reference-mobile.png','FPT_Open_STEM_Day_Doc_393x852_DPR3_HoTen_Lop.png');
  const studentPage=await client();
  await studentPage.run('document.getElementById("studentCodeInput").value='+JSON.stringify(fixtureStudent.code)+';document.getElementById("studentAccessInput").value='+JSON.stringify(fixtureStudent.accessCode)+';document.getElementById("studentLoginButton").click()');await waitFor(studentPage,"currentUser?.role==='student'");
  await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')&&!!document.querySelector('#studentPassClose svg')");
  // Capture one official completion first, then multiple. No local stamp mutation.
  const firstQueue=eventA+'::'+allBooths[0].id+'::'+profiles[0].code;
  check(label+' no completion before teacher acknowledgement',await studentPage.run("document.querySelectorAll('#studentPassDialog .is-complete').length===0"));
  ok(cloud.post('TEACHER_COMPLETE',{...teacher,eventId:eventA,boothId:allBooths[0].id,ids:[firstQueue]}));
  check(label+' no premature stamp before authenticated refresh',await studentPage.run("document.querySelectorAll('#studentPassDialog .is-complete').length===0"));
  await studentPage.run("window.recordedSealAnimations=[];document.getElementById('studentPassBooths').addEventListener('animationstart',e=>{if(e.animationName==='studentPassSeal')recordedSealAnimations.push({name:e.animationName,duration:getComputedStyle(e.target).animationDuration})});refreshEventNow();stopRemoteSync()");
  await waitFor(studentPage,"document.querySelectorAll('#studentPassDialog .is-complete').length===1");await delay(400);
  check(label+' exactly one official completed stamp',await studentPage.run("document.querySelectorAll('#studentPassDialog .is-complete').length===1&&document.querySelector('#studentPassBooths .is-complete').textContent==='HOÀN THÀNH'"));
  const animation=await studentPage.run('window.recordedSealAnimations');
  if(!baselineDir)check('ACK animation runs for 320ms',animation.length===1&&animation[0].duration==='0.32s');
  const metrics=[];
  function contrast(fg,bg){const l=hex=>{const c=hex.match(/../g).map(h=>parseInt(h,16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};const a=l(fg),b=l(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
  const contrastRatio=baselineDir?null:contrast('FFFFFF','142D63');
  async function measure(width,state){
    const m=await studentPage.run(`(()=>{const d=document.getElementById('studentPassDialog'),b=document.getElementById('studentPassClose'),s=b.querySelector('svg'),body=document.querySelector('.student-pass-body'),canvas=document.getElementById('studentPassCanvas');const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};const seal=n=>{const c=getComputedStyle(n),inner=getComputedStyle(n,'::before'),icon=n.querySelector('[data-lucide]'),text=n.querySelector('.student-pass-state');return{...rect(n),border:c.borderTopColor,borderStyle:c.borderTopStyle,bg:c.backgroundColor,bgImage:c.backgroundImage,shadow:c.boxShadow,innerBorder:inner.borderTopColor,innerStyle:inner.borderTopStyle,radius:c.borderRadius,iconColor:icon&&getComputedStyle(icon).color,textColor:text&&getComputedStyle(text).color,text:text?.textContent||'',children:n.children.length,iconRect:icon&&rect(icon),textRect:text&&rect(text)}};const complete=[...document.querySelectorAll('#studentPassBooths>li:not([hidden]) button.is-complete')],empty=[...document.querySelectorAll('#studentPassBooths>li:not([hidden]) button:not(.is-complete)')];return{modal:rect(d),button:rect(b),svg:rect(s),svgMargin:getComputedStyle(s).margin,buttonPadding:getComputedStyle(b).padding,buttonTransform:getComputedStyle(b).transform,aria:b.getAttribute('aria-label'),overflow:d.scrollWidth-d.clientWidth,canvas:rect(canvas),scroller:{height:body.clientHeight,total:body.scrollHeight},complete:complete.map(seal),empty:empty.map(seal)}})()`);
    check(label+' circular stamps stay bounded '+state+'/'+width,m.overflow<=1&&[...m.complete,...m.empty].every(s=>Math.abs(s.w-s.h)<1&&s.x>=m.canvas.x&&s.right<=m.canvas.right+1&&s.y>=m.canvas.y&&s.bottom<=m.canvas.bottom+1));
    if(!baselineDir){
      check('44px button, 20px centered X '+state+'/'+width,Math.abs(m.button.w-44)<.1&&Math.abs(m.button.h-44)<.1&&Math.abs(m.svg.w-20)<.1&&Math.abs(m.svg.h-20)<.1&&Math.abs((m.svg.x+m.svg.w/2)-(m.button.x+m.button.w/2))<.1&&Math.abs((m.svg.y+m.svg.h/2)-(m.button.y+m.button.h/2))<.1);
      check('close spacing and accessible label '+state+'/'+width,Math.abs(m.button.y-m.modal.y-17)<1.1&&Math.abs(m.modal.right-m.button.right-17)<1.1&&m.aria==='Đóng phiếu trải nghiệm'&&m.buttonPadding==='0px'&&m.svgMargin==='0px'&&m.buttonTransform==='none');
      check('exact gold/navy/white completed palette '+state+'/'+width,m.complete.length>0&&m.complete.every(s=>s.border==='rgb(255, 209, 102)'&&s.innerBorder===s.border&&s.borderStyle==='solid'&&s.innerStyle==='solid'&&s.bg==='rgb(20, 45, 99)'&&s.bgImage==='none'&&s.iconColor==='rgb(255, 255, 255)'&&s.textColor===s.iconColor&&s.text==='HOÀN THÀNH'&&s.children===2));
      check('empty dashed navy rings without glow '+state+'/'+width,m.empty.length>0&&m.empty.every(s=>s.border==='rgb(113, 134, 181)'&&s.innerBorder===s.border&&s.borderStyle==='dashed'&&s.innerStyle==='dashed'&&s.bg==='rgb(20, 45, 99)'&&s.shadow==='none'&&s.children===0&&!s.text));
      check('seal size and centered content fit '+state+'/'+width,[...m.complete,...m.empty].every(s=>s.w>=(width<768?69:79)&&s.w<=(width<768?91:101))&&m.complete.every(s=>s.iconRect.bottom<=s.textRect.y+1&&s.iconRect.x>=s.x&&s.iconRect.right<=s.right&&s.textRect.bottom<=s.bottom-5&&s.textRect.x>=s.x&&s.textRect.right<=s.right));
    }
    metrics.push({width,state,...m});return m;
  }
  for(const width of [320,375,390,393,430,1280]){
    await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height:width===1280?900:852,deviceScaleFactor:1,mobile:width<700});await delay(100);
    await studentPage.run("while(!document.getElementById('studentPassPrevious').disabled)document.getElementById('studentPassPrevious').click();document.querySelector('.student-pass-body').scrollTop=0");
    const before=await measure(width,'one');
    fs.writeFileSync(path.join(root,`artifacts/stem15-${label}-${width}.png`),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await studentPage.run("document.querySelector('.student-pass-body').scrollTop=99999");
    const after=await studentPage.run("(()=>{const r=document.getElementById('studentPassClose').getBoundingClientRect();return{x:r.x,y:r.y}})()");
    check(label+' close stays pinned during inner scroll '+width,Math.abs(before.button.x-after.x)<.1&&Math.abs(before.button.y-after.y)<.1);
    if(!baselineDir){
      await studentPage.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:before.button.x+22,y:before.button.y+22});await delay(200);
      check('close stays centered on hover '+width,await studentPage.run("getComputedStyle(document.getElementById('studentPassClose')).transform==='none'"));
    }
  }
  for(const booth of allBooths.slice(1,3))ok(cloud.post('TEACHER_COMPLETE',{...teacher,eventId:eventA,boothId:booth.id,ids:[eventA+'::'+booth.id+'::'+profiles[0].code]}));
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,"document.querySelectorAll('#studentPassDialog .is-complete').length===3");await delay(400);
  for(const width of [390,1280]){
    await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<700});await delay(100);await studentPage.run("document.querySelector('.student-pass-body').scrollTop=0");await measure(width,'multiple');
    fs.writeFileSync(path.join(root,`artifacts/stem15-${label}-multiple-${width}.png`),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  if(!baselineDir){
    check('white text/icon contrast exceeds WCAG AA',contrastRatio>7);
    await studentPage.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});await measure(1280,'reduced-transparency');
    await studentPage.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-contrast',value:'more'}]});await measure(1280,'more-contrast');
    await studentPage.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const nextBooth=allBooths[3];ok(cloud.post('TEACHER_COMPLETE',{...teacher,eventId:eventA,boothId:nextBooth.id,ids:[eventA+'::'+nextBooth.id+'::'+profiles[0].code]}));
    await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,"document.querySelectorAll('#studentPassDialog .is-complete').length===4");
    check('reduced motion suppresses stamp animation',await studentPage.run("[...document.querySelectorAll('#studentPassBooths .animate-stampPop')].every(n=>getComputedStyle(n).animationName==='none')"));
    await studentPage.cdp('Emulation.setEmulatedMedia',{features:[]});
    await studentPage.run('document.getElementById("studentPassClose").focus()');
    await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await waitFor(studentPage,"!document.getElementById('studentPassDialog').open");check('keyboard closes modal and restores focus to trigger',await studentPage.run("document.activeElement===document.getElementById('studentPassButton')"));
    await studentPage.run("window.stemReloadMarker=true");await studentPage.cdp('Page.reload');await waitFor(studentPage,"!window.stemReloadMarker&&typeof currentUser!=='undefined'&&currentUser?.role==='student'");
    await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");await waitFor(studentPage,"document.querySelectorAll('#studentPassDialog .is-complete').length===4");await measure(1280,'reload');
    check('reload retains exactly four official confirmations',await studentPage.run("document.querySelectorAll('#studentPassBooths .is-complete').length===4"));
    await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});await delay(100);
    const touchClose=await studentPage.run("(()=>{const r=document.getElementById('studentPassClose').getBoundingClientRect();return{x:r.x+22,y:r.y+22}})()");
    await studentPage.cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    await studentPage.cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...touchClose,id:0}]});
    check('pressed close control does not shift or scale',await studentPage.run("getComputedStyle(document.getElementById('studentPassClose')).transform==='none'"));
    await studentPage.cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await waitFor(studentPage,"!document.getElementById('studentPassDialog').open");
    await waitFor(studentPage,"document.activeElement===document.getElementById('studentPassButton')");
    check('44px touch target closes passport',await studentPage.run("!document.getElementById('studentPassDialog').open&&document.activeElement===document.getElementById('studentPassButton')"));
    await studentPage.cdp('Emulation.setTouchEmulationEnabled',{enabled:false});

  }
  fs.writeFileSync(path.join(root,'artifacts/stem15-'+label+'-results.json'),JSON.stringify({checks,metrics,contrastRatio,animation,environment:'Chrome localhost; actual frontend POST/302/JSON; fake Sheets/Drive/MailApp; external HTTPS blocked',devices:'320,375,390,393,430,1280px; real iPhone/Android not tested'},null,2));
  console.log(JSON.stringify({mode:label,checks:checks.length,passed:checks.length,contrast:contrastRatio}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{for(const socket of tabs)socket.close();chrome?.kill();for(const item of servers)item.close();});
