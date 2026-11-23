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
const allowedFile=new Set(["event-admin.js","event-ui.js","event-ui.css","vendor/lucide.js","tailwind.css","lucian-ui.css","event-glass.css","index.html","student-pass.css","student-pass.js","event-roster.js","event-excel.js","event-images.js"]);
const redirects=new Map(), servers=[], tabs=[], measurements=[];
const injected="window.diagnosticMeasure=()=>{}";
const baselineDir=null;
const beforeDir=process.env.FS_ACTIVATION_BASELINE_DIR||"/private/tmp/fs-activation-before";
const baselineAvailable=["index.html","event-admin.js","event-roster.js","event-glass.css"].every(name=>fs.existsSync(path.join(beforeDir,name)));
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
  const page=await client();
  await page.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  await page.run("showAdminTab('config');stopRemoteSync()");await waitFor(page,"!!managedEventSetup()");
  const actionsBefore=calls.filter(action=>action==="LIST_ROSTER").length;
  const layoutMetrics=[];
  async function shot(name,width,target=page,before=false){
    await target.cdp("Emulation.setDeviceMetricsOverride",{width,height:1050,deviceScaleFactor:1,mobile:width<700});
    await target.run("document.getElementById('toastStack').replaceChildren();document.getElementById('eventConfigCard').scrollIntoView({block:'start'})");await delay(200);
    check(name+" no horizontal overflow",await target.run("document.documentElement.scrollWidth===document.documentElement.clientWidth"));
    if(!before){
      const metrics=await target.run("(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom}};return {event:rect('activeEventSelect'),year:rect('configEventYear'),button:rect('managedEventActivate')}})()");
      layoutMetrics.push({width,...metrics});
      if(width>=1000)check("desktop event left, year right same row",Math.abs(metrics.event.y-metrics.year.y)<2&&metrics.event.x+metrics.event.w<metrics.year.x);
      else if(width<=600)check("mobile dropdowns stack "+width,metrics.year.y>metrics.event.bottom&&Math.abs(metrics.event.x-metrics.year.x)<2);
      check("activation immediately below both dropdowns "+width,metrics.button.y>=Math.max(metrics.event.bottom,metrics.year.bottom)&&metrics.button.y-Math.max(metrics.event.bottom,metrics.year.bottom)<20);
      check("activation fits configuration width "+width,metrics.button.w>=metrics.event.w&&metrics.button.x===metrics.event.x);
      check("school year is select with exact consecutive YYYY-YYYY labels "+width,await target.run("(()=>{const s=document.getElementById('configEventYear');return s.tagName==='SELECT'&&[...s.options].filter(o=>o.value).every(o=>/^20\\d{2}-20\\d{2}$/.test(o.textContent)&&+o.textContent.slice(5)===+o.textContent.slice(0,4)+1)&&!document.getElementById('configYearOptions')})()"));
    }
    fs.writeFileSync(path.join(root,"artifacts/activation-"+name+".png"),Buffer.from((await target.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  }
  check("active event year status shown immediately",await page.run("document.getElementById('configEventYear').value==='2026-2027'&&document.getElementById('configYearStatus').textContent.includes('2026-2027')&&document.getElementById('managedEventActivate').disabled"));
  await page.run("selectManagedEvent('fixture-event-b')");await waitFor(page,"managedEventSetup()?.eventId==='fixture-event-b'");
  for(const width of [1280,768,390,320])await shot("after-"+width,width);
  check("event settings does not read all 395 roster rows",calls.filter(action=>action==="LIST_ROSTER").length===actionsBefore);
  check("bound event year cannot be changed",await page.run("document.getElementById('configEventYear').disabled"));
  if(baselineAvailable){
  const beforePage=await client(app+"/before/index.html");
  await beforePage.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  await beforePage.run("showAdminTab('config');stopRemoteSync();selectManagedEvent('fixture-event-b')");await waitFor(beforePage,"managedEventSetup()?.eventId==='fixture-event-b'");
  for(const width of [1280,390])await shot("before-"+width,width,beforePage,true);
  await beforePage.run("stopRemoteSync()");
  }
  // Cancel replacement, then accept. The response must update without waiting for the held background poll.
  const writesBefore=calls.filter(action=>action==="CONFIGURE_EVENT_ACTIVATION").length;
  page.nextDialog(false);await page.run("document.getElementById('managedEventActivate').click()");
  check("cancel replacement sends no request",calls.filter(action=>action==="CONFIGURE_EVENT_ACTIVATION").length===writesBefore&&await page.run("activeEvent().id==='fixture-event-a'"));
  holdNextRead=true;
  await page.run("document.getElementById('managedEventActivate').click()");
  await waitFor(page,"!mutationBusy&&activeEvent().id==='fixture-event-b'");
  check("activation and year ACK precede background reconciliation",await page.run("awaitingWriteReconciliation&&document.getElementById('configEventYear').value==='2026-2027'&&document.getElementById('managedEventActivate').disabled&&document.getElementById('configYearStatus').textContent.includes('2026-2027')"));
  check("single write activation request",calls.filter(action=>action==="CONFIGURE_EVENT_ACTIVATION").length===writesBefore+1);
  await waitFor(page,"!remoteBusy");await page.run("stopRemoteSync()");
  await page.run("document.querySelector('.managed-create-event').open=true;document.getElementById('newEventName').value='Sự kiện năm mới QA';document.getElementById('newEventDate').value='Ngày thử';document.getElementById('newEventYear').value='2027-2028';addEvent()");
  await waitFor(page,"!mutationBusy&&managedEventSetup()?.event.name==='Sự kiện năm mới QA'");
  const futureId=await page.run("managedEventId()");
  check("future event year saves without switching active event or year",await page.run("activeEvent().id==='fixture-event-b'&&document.getElementById('configEventYear').value==='2027-2028'&&document.getElementById('managedEventActivate').disabled&&document.getElementById('configYearStatus').textContent.includes('Quản lý học sinh')"));
  await waitFor(page,"!remoteBusy");await page.run("stopRemoteSync()");
  await page.run("archiveManagedEvent("+JSON.stringify(futureId)+")");
  await waitFor(page,"!mutationBusy&&EVENTS.find(e=>e.id==="+JSON.stringify(futureId)+").archived");
  check("archived event activation stays blocked; explicit reopen available",await page.run("document.getElementById('managedEventActivate').disabled&&!document.getElementById('managedEventReopen').hidden&&!document.getElementById('managedEventReopen').disabled"));
  await page.run("document.querySelector('.managed-event-link').open=true");
  page.nextDialog(false);const reopenBefore=calls.filter(action=>action==="CONFIGURE_EVENT_ACTIVATION").length;
  await page.run("document.getElementById('managedEventReopen').click()");
  check("cancel reopen keeps archive state and sends no write",calls.filter(action=>action==="CONFIGURE_EVENT_ACTIVATION").length===reopenBefore&&await page.run("EVENTS.find(e=>e.id==="+JSON.stringify(futureId)+").archived"));
  await page.run("document.getElementById('managedEventReopen').click()");
  await waitFor(page,"!mutationBusy&&!EVENTS.find(e=>e.id==="+JSON.stringify(futureId)+").archived");
  check("reopen does not activate or change year",await page.run("activeEvent().id==='fixture-event-b'&&document.getElementById('configEventYear').value==='2027-2028'&&document.getElementById('managedEventActivate').disabled"));
  await waitFor(page,"!remoteBusy");await page.run("stopRemoteSync()");
  // Unlinked legacy event: separate link persists with no active-event or year change.
  cloud.context.withTeacherAuthLock_(()=>{const row=cloud.sheets.get('WorkflowState').rows.find(r=>r[1]==='event-config'),data=JSON.parse(row[3]);delete data.events.find(e=>e.id===futureId).schoolYear;row[3]=JSON.stringify(data);cloud.context.invalidateEventView_();});
  await page.run("refreshEventNow()");await waitFor(page,"!remoteBusy");await page.run("loadManagedEvent("+JSON.stringify(futureId)+",true)");
  await waitFor(page,"!managedEventSetup().event.schoolYear");
  await page.run("document.getElementById('configEventYear').value='2027-2028';document.getElementById('configEventYear').dispatchEvent(new Event('change'));document.querySelector('.managed-event-link').open=true");
  check("unlinked event permits year selection and compact separate link",await page.run("!document.getElementById('configEventYear').disabled&&!document.getElementById('managedEventLink').disabled&&document.getElementById('managedEventActivate').disabled"));
  await page.run("document.getElementById('managedEventLink').click()");
  await waitFor(page,"!mutationBusy&&EVENTS.find(e=>e.id==="+JSON.stringify(futureId)+").schoolYear==='2027-2028'");
  check("link ACK does not activate event",await page.run("activeEvent().id==='fixture-event-b'&&document.getElementById('configEventYear').value==='2027-2028'&&document.getElementById('managedEventLink').disabled"));
  await waitFor(page,"!remoteBusy");await page.run("stopRemoteSync()");
  await page.run("window.qaActivationReload=true");await page.cdp("Page.reload");
  await waitFor(page,"!window.qaActivationReload&&document.readyState==='complete'&&currentUser?.role==='admin'");
  await page.run("showAdminTab('config');selectManagedEvent("+JSON.stringify(futureId)+");stopRemoteSync()");await waitFor(page,"managedEventSetup()?.eventId==="+JSON.stringify(futureId));
  check("reload preserves linked year and active event",await page.run("activeEvent().id==='fixture-event-b'&&document.getElementById('configEventYear').value==='2027-2028'"));
  apiFault="activation-missing";
  await page.run("loadManagedEvent("+JSON.stringify(futureId)+",true)");
  await waitFor(page,"!managedEventSetup().eventActivationVersion");
  check("old deployment disables activation/link/reopen with update instructions",await page.run("['managedEventActivate','managedEventLink','managedEventReopen'].every(id=>document.getElementById(id).disabled)&&document.getElementById('configYearStatus').textContent.includes('event-activation-v1')"));
  await shot("old-backend-390",390);apiFault=null;
  const teacherPage=await client();
  await teacherPage.run("loginAdmin("+JSON.stringify(supervisor)+","+JSON.stringify(teacher.authToken)+",3600)");await waitFor(teacherPage,"currentUser?.access.role==='TEACHER'");
  await teacherPage.run("showAdminTab('config');stopRemoteSync()");
  check("teacher does not see event configuration",await teacherPage.run("document.getElementById('adminConfigPanel').classList.contains('hidden')||document.getElementById('eventConfigCard').hidden"));
  const stats={checks,layoutMetrics,baselineScreenshots:baselineAvailable,fixture:{students:395,classes:12,booths:11,records:2374},externalServices:"BLOCKED: all HTTPS; Apps Script/Sheets/Drive/MailApp mocked",actions:[...new Set(calls)]};
  fs.writeFileSync(path.join(root,"artifacts/event-activation-browser-results.json"),JSON.stringify(stats,null,2));
  console.log(JSON.stringify({checks:checks.length,passed:checks.length}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  for(const socket of tabs)socket.close();chrome?.kill();for(const item of servers)item.close();
});
