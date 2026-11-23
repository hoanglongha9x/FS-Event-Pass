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
const baselineDir=process.env.FS_UI_BASELINE;
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
  const page=await client();
  const checks=[], results={};
  const verify=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
  const evaluate=code=>page.run(code);
  async function shot(name,width,height=900){
    await page.cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<700});
    await evaluate("window.scrollTo(0,0)");
    await delay(240);
    const dimensions=await evaluate("[document.documentElement.clientWidth,document.documentElement.scrollWidth]");
    verify(name+" fits "+width,dimensions[0]===dimensions[1]);
    fs.writeFileSync(path.join(root,"artifacts",outputName+"-"+name+".png"),Buffer.from((await page.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  }
  verify("logo constrained on initial load",await evaluate("document.querySelector('.brand-logo').getBoundingClientRect().width<70"));
  verify("icons available on initial load",await evaluate("document.querySelectorAll('#loginView svg').length>3"));
  if(!baselineDir){
    await page.cdp("Emulation.setScriptExecutionDisabled",{value:true});
    await page.cdp("Page.reload");await delay(350);
    verify("initial icons and logo survive disabled JavaScript",await evaluate("document.querySelectorAll('#loginView svg').length>3&&document.querySelector('.brand-logo').getBoundingClientRect().width===49"));
    await shot("first-paint-no-js",390,844);
    await page.cdp("Emulation.setScriptExecutionDisabled",{value:false});
    await page.cdp("Page.reload");
    for(let i=0;i<100;i++){
      if(await evaluate("document.readyState==='complete'&&document.getElementById('studentLoginEvent').textContent!=='Đang tải sự kiện…'"))break;
      await delay(40);
    }
  }
  await shot("login-desktop",1280,850);
  await shot("login-mobile",390,844);
  if(!baselineDir){
    verify("no icon CDN or Tailwind runtime",await evaluate("![...document.scripts].some(s=>/tailwind/.test(s.src)||/https:.*lucide/.test(s.src))"));
    verify("existing SVG preserved",await evaluate("(()=>{const svg=document.querySelector('svg[data-lucide]');FSchoolUi.render();FSchoolUi.render();return document.contains(svg)})()"));
    verify("new DOM icon initialized",await evaluate("(()=>{const button=document.createElement('button');button.innerHTML='<i data-lucide=save></i>Lưu';document.body.append(button);FSchoolUi.render(button);const ok=!!button.querySelector('svg');button.remove();return ok})()"));
    verify("one toast only and error semantics",await evaluate("(()=>{showToast('Thông báo thử','check');showToast('Lỗi giả lập <test>','circle-alert','error');return document.querySelectorAll('.ui-toast').length===1&&document.querySelector('.ui-toast').getAttribute('role')==='alert'&&document.querySelector('.ui-toast-message').textContent==='Lỗi giả lập <test>'})()"));
    await evaluate("document.querySelector('.ui-toast-close').click()");await delay(200);
    verify("toast dismisses",await evaluate("document.querySelectorAll('.ui-toast').length===0"));
    pendingAction="SEND_TEACHER_OTP_V3";
    await evaluate("document.querySelector('[data-role=admin]').click();document.getElementById('teacherEmailInput').value="+JSON.stringify(admin)+";validateTeacherEmail();void(window.otpTest=sendTeacherOtp())");
    verify("OTP loading begins before response",await evaluate("document.getElementById('sendOtpButton').dataset.uiState==='loading'&&document.getElementById('sendOtpButton').disabled"));
    await evaluate("sendTeacherOtp()");
    await evaluate("window.otpTest");pendingAction=null;
    verify("OTP loading finishes after backend",await evaluate("document.getElementById('sendOtpButton').dataset.uiState==='success'"));
    verify("no duplicate OTP submission",calls.filter(a=>a==="SEND_TEACHER_OTP_V3").length===1);
    // A deliberately invalid value; no real mail, OTP, token or request body is recorded.
    const wrongOtp=String((Number(cloud.mail.at(-1).body.match(/\b\d{6}\b/)[0])+1)%1000000).padStart(6,"0");
    await evaluate("document.getElementById('teacherOtpInput').value="+JSON.stringify(wrongOtp)+";window.verifyTest=verifyTeacherLogin()");
    await evaluate("window.verifyTest");
    verify("failed OTP does not sign in",await evaluate("!currentUser"));
  }
  await evaluate("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  await delay(350);
  await evaluate("stopRemoteSync();showAdminTab('config')");await delay(350);
  await shot("management-desktop",1280,1100);
  for(const width of [768,390,320])await shot("management-"+width,width,1000);
  await evaluate("showAdminTab('dashboard');stopRemoteSync()");
  await shot("dashboard-mobile",390,900);
  // Same 395 profiles / 12 classes / 11 booths / 2374 records for both builds.
  // Exclude warm-up and wait for frames, including deferred icon work.
  await page.cdp("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate("showAdminTab('queue');stopRemoteSync();window.scrollTo(0,0)");await delay(100);
  verify("benchmark queue is visible",await evaluate("document.getElementById('queueList').getClientRects().length>0"));
  const beforeCalls=calls.length;
  results.queue=await evaluate(`(async()=>{
    const samples=[];
    for(let i=0;i<24;i++){
      const start=performance.now();renderQueue();const js=performance.now()-start;
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      if(i>3)samples.push({js,frames:performance.now()-start});
    }
    const stats=k=>{const a=samples.map(x=>x[k]).sort((a,b)=>a-b);return {p50:+((a[9]+a[10])/2).toFixed(2),p95:+a[18].toFixed(2)}};
    return {js:stats('js'),frames:stats('frames'),samples:20};
  })()`);
  verify("queue render adds no requests",calls.length===beforeCalls);
  await page.cdp("Performance.enable");
  await page.cdp("Emulation.setCPUThrottlingRate",{rate:4});
  const taskMetric=async()=>Object.fromEntries((await page.cdp("Performance.getMetrics")).metrics.map(m=>[m.name,m.value]));
  const taskStart=await taskMetric();
  results.queueCpu4=await evaluate(`(async()=>{
    const a=[];for(let i=0;i<24;i++){
      const start=performance.now();renderQueue();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      if(i>3)a.push(performance.now()-start);
    }
    a.sort((x,y)=>x-y);return {p50:+((a[9]+a[10])/2).toFixed(2),p95:+a[18].toFixed(2)};
  })()`);
  const taskEnd=await taskMetric();
  results.queueCpu4.taskMsPerRender=+((taskEnd.TaskDuration-taskStart.TaskDuration)*1000/24).toFixed(2);
  await page.cdp("Emulation.setCPUThrottlingRate",{rate:1});
  if(!baselineDir){
    pendingAction="SAVE_EVENT_BOOTHS";
    await evaluate("showAdminTab('config');stopRemoteSync();window.savedButton=document.querySelector('#adminBoothConfig button[onclick^=saveBoothSettings]');window.savedButton.click()");
    await delay(80);
    verify("write pending state before acknowledgement",await evaluate("window.savedButton.getAttribute('aria-busy')==='true'&&window.savedButton.dataset.uiState==='loading'"));
    await evaluate("(async()=>{while(mutationBusy)await new Promise(r=>setTimeout(r,10))})()");pendingAction=null;
    verify("write pending state ends after acknowledgement",await evaluate("window.savedButton.getAttribute('aria-busy')!=='true'&&window.savedButton.dataset.uiState==='success'"));
    // Inspect the transient state in the same browser task, before its 1.6s reset.
    verify("error state ends loading",await evaluate("window.uiHandle=FSchoolUi.begin(document.getElementById('refreshEventButton'));FSchoolUi.end(window.uiHandle,'error');document.getElementById('refreshEventButton').dataset.uiState==='error'"));
    await page.cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"},{name:"prefers-reduced-transparency",value:"reduce"}]});
    verify("reduced motion and transparency",await evaluate("getComputedStyle(document.getElementById('refreshEventButton')).transitionDuration==='0s'&&getComputedStyle(document.querySelector('header')).backdropFilter==='none'"));
    verify("reduced motion suppresses confetti",await evaluate("(()=>{let calls=0;window.confetti=()=>calls++;triggerFptConfetti();return calls===0})()"));
    await shot("reduced-mobile",320,900);
    await page.cdp("Emulation.setEmulatedMedia",{features:[]});
  }
  await evaluate("logout();loadPublicEvent()");await delay(250);
  if(!baselineDir){
    const teacherPage=await client();
    await teacherPage.run("(async()=>{await loginAdmin("+JSON.stringify(supervisor)+","+JSON.stringify(teacher.authToken)+",3600);stopRemoteSync()})()");
    await teacherPage.cdp("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:true});
    verify("teacher retains assigned-booth permissions",await teacherPage.run("!canOpenAdminTab('config')&&document.getElementById('teacherBoothSelect').options.length===7"));
    await delay(250);
    fs.writeFileSync(path.join(root,"artifacts",outputName+"-teacher-mobile.png"),Buffer.from((await teacherPage.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
    await page.cdp("Page.bringToFront");
  }
  if(!baselineDir)await evaluate("delete document.getElementById('refreshEventButton').dataset.uiState;document.querySelector('.ui-toast-close')?.click()");
  await evaluate("document.getElementById('studentCodeInput').value="+JSON.stringify(fixtureStudent.code)+";document.getElementById('studentAccessInput').value="+JSON.stringify(fixtureStudent.accessCode)+";submitStudentLogin({preventDefault(){}})");
  await evaluate("openStudentEvent(activeEvent().id);stopRemoteSync()");await delay(350);
  await shot("student-mobile",390,900);
  for(const width of [1280,768,390,320]){
    await page.cdp("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width<700});
    await evaluate("document.getElementById('studentPassButton').click()");
    await shot("pass-"+width,width,900);
    verify("round stamps "+width,await evaluate("[...document.querySelectorAll('.student-pass-stamp')].every(n=>Math.abs(n.getBoundingClientRect().width-n.getBoundingClientRect().height)<1)"));
    await evaluate("document.getElementById('studentPassClose').click()");
  }
  if(!baselineDir){
    await evaluate("document.getElementById('studentPassButton').focus();document.getElementById('studentPassButton').click()");
    await page.cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await page.cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await delay(100);
    verify("native dialog Escape restores focus",await evaluate("!document.getElementById('studentPassDialog').open&&document.activeElement.id==='studentPassButton'"));
    await evaluate("document.getElementById('studentPassButton').focus();openBoothModal('robotics')");await delay(80);
    verify("custom modal autofocus",await evaluate("document.getElementById('boothModal').contains(document.activeElement)"));
    await evaluate("window.modalFirst=document.activeElement;[...document.getElementById('boothModal').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex=\"0\"]')].filter(n=>n.getClientRects().length).at(-1).focus()");
    await page.cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
    await page.cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
    verify("custom modal traps Tab",await evaluate("document.activeElement===window.modalFirst"));
    await page.cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape"});
    await page.cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape"});await delay(80);
    verify("custom modal Escape restores focus and resets booth",await evaluate("document.getElementById('boothModal').classList.contains('hidden')&&currentBoothId===null&&document.activeElement.id==='studentPassButton'"));
    await evaluate("document.getElementById('studentPassButton').click()");
    const waiting=cloud.post("GET_EVENT_VIEW",{studentSession:await evaluate("currentUser.studentSession")}).records.find(r=>r.type==="queue"&&r.data.boothId==="robotics");
    verify("waiting queue has no completed stamp",await evaluate("document.querySelectorAll('.student-pass-stamp.is-complete').length===0"));
    ok(cloud.post("TEACHER_COMPLETE",{...teacher,eventId:eventA,boothId:"robotics",ids:[waiting.id]}));
    await evaluate("pollRemote()");
    verify("stamp appears only after official completion",await evaluate("document.querySelectorAll('.student-pass-stamp.is-complete').length===1"));
    await evaluate("window.stampNode=document.querySelector('.student-pass-stamp.is-complete');pollRemote()");
    verify("same poll does not recreate stamp",await evaluate("window.stampNode===document.querySelector('.student-pass-stamp.is-complete')"));
    await shot("completed-pass-mobile",390,900);
    // Prepare a completed, eligible synthetic fixture for stage presentation.
    // These are in-memory mock rows; no Apps Script/Sheets service is contacted.
    const studentAuth=await evaluate("eventAuth()");
    for(const item of cloud.sheets.get("WorkflowState").rows){
      if(item[0]!=="queue")continue;
      const data=JSON.parse(item[3]);
      if(data.eventId===eventA && data.studentCode===profiles[0].code){
        item[3]=JSON.stringify({...data,status:"completed",completedAt:stampDate});
      }
    }
    cloud.seedRows("WorkflowState",[row(eventA,booths[10].id,profiles[0],1,"completed")]);
    cloud.cache.remove("event-pass-read-v1");
    ok(cloud.post("SUBMIT_VOTE",{...studentAuth,eventId:eventA,boothId:"robotics"}));
    await evaluate("logout()");
    const drawAdmin=cloud.seedTeacher(admin);
    await evaluate("(async()=>{await loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(drawAdmin.authToken)+",3600);stopRemoteSync();showAdminTab('stage')})()");
    pendingAction="START_DRAW";
    await evaluate("window.confettiCalls=0;window.confetti=()=>confettiCalls++;void(window.drawTest=startLuckyDraw())");
    verify("draw has no victory before backend acknowledgement",await evaluate("drawTimer===null&&confettiCalls===0&&document.getElementById('drawButton').dataset.uiState==='loading'"));
    await evaluate("window.drawTest");pendingAction=null;
    await delay(3200);
    verify("draw reveals backend result and confetti",await evaluate("drawTimer===null&&confettiCalls===3&&document.getElementById('drawWinner').textContent.includes('Học sinh giả 1')"));
    await shot("stage-desktop",1280,900);
    await shot("stage-mobile",390,900);
  }
  results.checks=checks;results.fixture={students:395,classes:12,booths:11,records:rows.length};
  results.assets={icons:fs.statSync(baselineDir?'/private/tmp/fsevent-pass-lucide.js':path.join(root,'vendor/lucide.js')).size};
  fs.writeFileSync(path.join(root,"artifacts",outputName+"-metrics.json"),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  for(const s of tabs)s.close();
  chrome?.kill();
  for(const server of servers)server.close();
});
