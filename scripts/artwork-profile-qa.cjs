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
const baselineDir=null;
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
  const roster=ok(cloud.post('LIST_ROSTER',btc));
  const displayName='HỌC SINH MẪU NGUYỄN MINH AN';
  ok(cloud.post('SAVE_ROSTER',{...btc,schoolYear:roster.schoolYear,mode:'update',expectedRevision:roster.revision,confirmed:true,rows:[{...profiles[0],name:displayName}]}));
  const page=await client();
  await page.run('loginAdmin('+JSON.stringify(admin)+','+JSON.stringify(btc.authToken)+',3600)');
  await page.run("showAdminTab('config');stopRemoteSync()");await waitFor(page,'!!managedEventSetup()');
  async function choose(kind,assetPath,name,preset){
    await page.run("document.getElementById('eventPassportVariant').value="+JSON.stringify(kind)+";document.getElementById('eventPassportVariant').dispatchEvent(new Event('change'))");
    await page.run(`(async()=>{const blob=await fetch(${JSON.stringify(assetPath)}).then(r=>r.blob());const data=new DataTransfer();data.items.add(new File([blob],${JSON.stringify(name)},{type:'image/png'}));const input=document.getElementById('eventPassportFile');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(page,"document.getElementById('eventImagesStatus').textContent.includes('sẵn sàng')");
    check(kind+' filename selects matching printed-field template',await page.run('document.getElementById("eventPassportProfileTemplate").value==='+JSON.stringify(preset)));
    await page.run("document.getElementById('eventPassportExpand').click()");
    await waitFor(page,"!document.querySelector('#eventImageViewerCanvas .passport-art-profile').hidden");
    check(kind+' preview uses a sample DOM name, not a real roster lookup',await page.run("document.querySelector('#eventImageViewerCanvas .passport-art-name').textContent==='HỌC SINH MẪU'&&document.querySelector('#eventImageViewerCanvas .passport-art-class').textContent==='10A1'"));
    fs.writeFileSync(path.join(root,'artifacts/art-profile-preview-'+kind+'.png'),Buffer.from((await page.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportSave').click()");
    await waitFor(page,'!document.getElementById("eventImagesSelect").disabled&&managedEventSetup().event.images.'+kind+'?.layout?.profileTemplate==='+JSON.stringify(preset));
  }
  await choose('passport','/profile-reference-desktop.png','FPT_Open_STEM_Day_Ngang_HoTen_Lop.png','open-stem-landscape-v1');
  await choose('passportMobile','/profile-reference-mobile.png','FPT_Open_STEM_Day_Doc_393x852_DPR3_HoTen_Lop.png','open-stem-portrait-v1');
  const fileBytes=()=>JSON.stringify([...cloud.imageFiles.values()].map(blob=>crypto.createHash('sha256').update(Buffer.from(blob.getBytes())).digest('hex')));
  const imageBytesBefore=fileBytes();
  const studentPage=await client();
  await studentPage.run('document.getElementById("studentCodeInput").value='+JSON.stringify(fixtureStudent.code)+';document.getElementById("studentAccessInput").value='+JSON.stringify(fixtureStudent.accessCode)+';document.getElementById("studentLoginButton").click()');
  await waitFor(studentPage,"currentUser?.role==='student'");
  await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");
  await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  const metrics=[];
  for(const width of [1280,430,393,390,375,320]){
    const height=({1280:900,430:932,393:852,390:844,375:667,320:568})[width];
    await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});
    await waitFor(studentPage,"!document.querySelector('#studentPassCanvas .passport-art-profile').hidden&&document.querySelector('.student-pass-profile').classList.contains('has-art-profile')");await delay(100);
    const m=await studentPage.run(`(()=>{const canvas=document.getElementById('studentPassCanvas'),root=canvas.querySelector('.passport-art-profile'),name=root.querySelector('.passport-art-name'),cls=root.querySelector('.passport-art-class');const r=n=>{const x=n.getBoundingClientRect();return {x:x.x,y:x.y,w:x.width,h:x.height,bottom:x.bottom,right:x.right}};return {canvas:r(canvas),overlay:r(root),name:r(name),className:r(cls),art:r(document.getElementById('studentPassArtwork')),nameText:name.textContent,classText:cls.textContent,nameFont:parseFloat(getComputedStyle(name.firstElementChild).fontSize),nameFits:name.firstElementChild.getBoundingClientRect().height<=name.clientHeight+1&&name.firstElementChild.scrollWidth<=name.clientWidth+1,overflow:document.getElementById('studentPassDialog').scrollWidth-document.getElementById('studentPassDialog').clientWidth,firstStamp:r(document.querySelector('#studentPassBooths button')),done:document.querySelectorAll('#studentPassDialog .is-complete').length}})()`);
    const source=width>=768?{w:2098,h:749,name:[240,50,447,90],className:[135,171,552,90]}:{w:1179,h:2556,name:[405,500,684,131],className:[259,696,832,124]};
    check('dynamic own name and class in printed blanks '+width,m.nameText===displayName&&m.classText===profiles[0].className);
    check('uncropped supplied image and overlay share ratio '+width,Math.abs(m.art.w/m.art.h-source.w/source.h)<.01&&Math.abs(m.overlay.h-m.art.h)<2);
    for(const key of ['name','className']){
      const [x,y,w,h]=source[key],field=m[key];
      check('correct '+key+' percentage coordinates '+width,Math.abs(field.x-(m.overlay.x+x/source.w*m.overlay.w))<1.1&&Math.abs(field.y-(m.overlay.y+y/source.h*m.overlay.h))<1.1&&Math.abs(field.w-w/source.w*m.overlay.w)<1.1&&Math.abs(field.h-h/source.h*m.overlay.h)<1.1);
    }
    check('legible complete name and no horizontal overflow '+width,m.nameFits&&m.nameFont>=12&&m.overflow<=1);
    check('stamps stay below printed fields and do not falsely complete '+width,m.firstStamp.y>=m.className.bottom+1&&m.done===0);
    metrics.push({width,...m,nameText:undefined,classText:undefined});
    await studentPage.run("document.querySelector('.student-pass-body').scrollTop=0");
    fs.writeFileSync(path.join(root,'artifacts/art-profile-'+width+'.png'),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  const longName=('Học sinh mẫu '+('TênDài'.repeat(12))).slice(0,80);
  const longRoster=ok(cloud.post('LIST_ROSTER',btc));
  ok(cloud.post('SAVE_ROSTER',{...btc,schoolYear:longRoster.schoolYear,mode:'update',expectedRevision:longRoster.revision,confirmed:true,rows:[{...profiles[0],name:longName}]}));
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,'!remoteBusy');await delay(100);
  check('long name is preserved with readable separate fallback',await studentPage.run("document.getElementById('studentPassName').textContent==="+JSON.stringify(longName)+"&&!document.querySelector('.student-pass-profile').classList.contains('has-art-profile')&&document.getElementById('studentPassDialog').scrollWidth===document.getElementById('studentPassDialog').clientWidth"));
  fs.writeFileSync(path.join(root,'artifacts/art-profile-long-name-mobile.png'),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  const restoreRoster=ok(cloud.post('LIST_ROSTER',btc));
  ok(cloud.post('SAVE_ROSTER',{...btc,schoolYear:restoreRoster.schoolYear,mode:'update',expectedRevision:restoreRoster.revision,confirmed:true,rows:[{...profiles[0],name:displayName}]}));
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,'!remoteBusy');
  const queueId=eventA+'::robotics::'+profiles[0].code;
  ok(cloud.post('TEACHER_COMPLETE',{...teacher,eventId:eventA,boothId:'robotics',ids:[queueId]}));
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,"document.querySelectorAll('#studentPassDialog .is-complete').length===1");
  check('official completion unchanged with profile overlay',await studentPage.run("document.querySelector('#studentPassBooths .is-complete').textContent==='HOÀN THÀNH'&&document.querySelector('#studentPassCanvas .passport-art-name').textContent==="+JSON.stringify(displayName)));
  for(const [width,height,label] of [[1280,900,'desktop'],[393,852,'mobile']]){
    await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});
    await waitFor(studentPage,"!document.querySelector('#studentPassCanvas .passport-art-profile').hidden&&document.querySelector('.student-pass-profile').classList.contains('has-art-profile')");await delay(120);
    await studentPage.run("document.querySelector('.student-pass-body').scrollTop=0");
    fs.writeFileSync(path.join(root,'artifacts/art-profile-confirmed-'+label+'.png'),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  await studentPage.run("document.getElementById('studentPassClose').click();window.profileReloadMarker=true");await studentPage.cdp('Page.reload');
  await waitFor(studentPage,"!window.profileReloadMarker&&typeof currentUser!=='undefined'&&currentUser?.role==='student'");
  await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");await waitFor(studentPage,"!document.querySelector('#studentPassCanvas .passport-art-profile').hidden");
  check('reload keeps profile template and backend-confirmed stamp',await studentPage.run("document.querySelector('#studentPassCanvas .passport-art-name').textContent==="+JSON.stringify(displayName)+"&&document.querySelectorAll('#studentPassDialog .is-complete').length===1"));
  check('student text never changes stored Drive image bytes',fileBytes()===imageBytesBefore);
  const info=ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images;
  ok(cloud.post('SAVE_EVENT_IMAGE',{...btc,eventId:eventA,kind:'passportMobile',operation:'default',expectedRevision:info.revision}));
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,'!remoteBusy');
  check('tiny Desktop fallback keeps readable separate identity instead of clipped text',await studentPage.run("!document.querySelector('.student-pass-profile').classList.contains('has-art-profile')&&document.getElementById('studentPassName').textContent==="+JSON.stringify(displayName)));
  const stats={checks,metrics,fixture:{students:395,classes:12,booths:11},references:'User-supplied artwork PNGs, unchanged on disk; profile text rendered as HTML only',externalServices:'BLOCKED; mock Sheets/Drive/MailApp, localhost POST/redirect/JSON'};
  fs.writeFileSync(path.join(root,'artifacts/artwork-profile-browser-results.json'),JSON.stringify(stats,null,2));console.log(JSON.stringify({checks:checks.length,passed:checks.length}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{for(const socket of tabs)socket.close();chrome?.kill();for(const item of servers)item.close();});
