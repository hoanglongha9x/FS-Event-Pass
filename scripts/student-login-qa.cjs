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
const outputName="student-login";
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
  events[0].name="Ngày hội Openday";
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
    if(req.method!=="POST"){res.writeHead(405,headers).end();return;}
    try {
      const body=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString("utf8"));
      const baseline=slow, currentLog=collect;
      if(baseline)await delay(700);
      if(body.action===pendingAction)await delay(450);
      if(apiFault===401){res.writeHead(401,{...headers,"Content-Type":"text/html"}).end("fixture permission denial");return;}
      let {result,metric}=profileBackend(body.action,()=>cloud.post(body.action,body));
      if(apiFault==="legacy" && ["GET_EVENT_VIEW","GET_EVENT_API_VERSION"].includes(body.action)){
        result={...result};delete result.studentAccessVersion;
      }
      if(apiFault==="public-unchanged" && body.action==="GET_EVENT_VIEW" && !body.studentSession){
        result={success:true,apiVersion:result.apiVersion,studentAccessVersion:result.studentAccessVersion,studentLoginEnabled:true,unchanged:true};
      }
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
  const checks=[], transport=[];
  const check=(name,result)=>{assert.equal(result,true,name);checks.push({name,status:"PASS"});};
  async function waitFor(page,expression){
    for(let i=0;i<200;i++){if(await page.run(expression))return;await delay(30);}
    throw Error("Mock website state timed out");
  }
  async function instrument(page){
    await page.run(`(()=>{
      window.safeTransport=[];const original=window.fetch;
      window.fetch=async function(url,options){
        const response=await original.apply(this,arguments);
        if(url===GOOGLE_SCRIPT_URL)window.safeTransport.push({action:JSON.parse(options.body).action,
          method:options.method,mode:options.mode,status:response.status,redirected:response.redirected});
        return response;
      };
    })()`);
  }
  const page=await client();await instrument(page);
  check("public Openday and year-linked login enabled",await page.run("!document.getElementById('studentLoginButton').disabled&&document.getElementById('studentLoginEvent').textContent==='Ngày hội Openday'"));
  check("POST version contract",await page.run("requestCloudAction('GET_EVENT_API_VERSION').then(r=>r.success&&r.studentAccessVersion==='student-event-access-v1'&&r.apiVersion==='event-pass-scoped-v1')"));
  const login=async(code,accessCode)=>{
    await page.run("document.getElementById('studentCodeInput').value="+JSON.stringify(code)+";document.getElementById('studentAccessInput').value="+JSON.stringify(accessCode)+";document.getElementById('studentLoginButton').click()");
    await waitFor(page,"!studentLoginBusy");
  };
  for(const [name,code,accessCode] of [
    ["wrong shared code",fixtureStudent.code,fixtureStudent.accessCode.toLowerCase()],
    ["unknown student", "MISSING-999",fixtureStudent.accessCode],
    ["student from other school year",rosterRow(396).code,fixtureStudent.accessCode]
  ]){
    await login(code,accessCode);
    check(name,await page.run("currentUser===null&&!!document.querySelector('.ui-toast[data-tone=error]')"));
  }
  ok(cloud.post("MANAGE_STUDENT_ACCOUNTS",{...btc,eventId:eventA,operation:"lock",codes:[fixtureStudent.code]}));
  await login(fixtureStudent.code,fixtureStudent.accessCode);
  check("locked account rejected",await page.run("currentUser===null"));
  ok(cloud.post("MANAGE_STUDENT_ACCOUNTS",{...btc,eventId:eventA,operation:"unlock",codes:[fixtureStudent.code]}));
  ok(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventB,events}}));
  check("inactive event rejected over website POST",await page.run("eventCall('LOGIN_STUDENT',"+JSON.stringify({eventId:eventA,code:fixtureStudent.code,accessCode:fixtureStudent.accessCode,studentAccessVersion})+",{}).then(()=>false,e=>e.code==='STUDENT_LOGIN_INVALID')"));
  await page.run("loadPublicEvent()");
  check("event without configured access keeps button disabled",await page.run("document.getElementById('studentLoginButton').disabled===true"));
  ok(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventA,events}}));
  ok(cloud.post("MANAGE_YEAR",{...btc,operation:"activate",schoolYear:"2027-2028"}));
  await page.run("loadPublicEvent()");
  check("wrong active school year keeps button disabled",await page.run("document.getElementById('studentLoginButton').disabled&&document.getElementById('studentLoginEvent').textContent.includes('Năm học')"));
  ok(cloud.post("MANAGE_YEAR",{...btc,operation:"activate",schoolYear:"2026-2027"}));
  await page.run("loadPublicEvent()");
  await login(fixtureStudent.code,fixtureStudent.accessCode);
  check("valid student signs in through website",await page.run("currentUser?.role==='student'&&currentUser.code==='FA0001'&&currentUser.schoolYear==='2026-2027'"));
  check("shared code cleared from field and absent from browser storage",await page.run("document.getElementById('studentAccessInput').value===''&&![...Object.values(sessionStorage),...Object.values(localStorage)].some(v=>v.includes("+JSON.stringify(fixtureStudent.accessCode)+"))"));
  check("own data only and no booth PIN",await page.run("eventCall('GET_EVENT_VIEW').then(r=>r.studentAccessVersion==='student-event-access-v1'&&typeof r.studentLoginEnabled==='boolean'&&r.records.filter(x=>x.type==='student').every(x=>x.id==='FA0001')&&r.records.filter(x=>x.type==='queue').every(x=>x.data.studentCode==='FA0001')&&r.records.find(x=>x.id==='booth-config').data.boothList.every(b=>!Object.hasOwn(b,'pin')))"));
  check("student cannot read admin roster",await page.run("eventCall('LIST_ROSTER').then(()=>false,e=>['AUTH_REQUIRED','FORBIDDEN'].includes(e.code))"));
  const savedSession=await page.run("eventAuth()");
  check("forged other student session denied",await page.run("eventCall('GET_EVENT_VIEW',{},"+JSON.stringify({studentSession:{...savedSession.studentSession,code:profiles[1].code}})+").then(()=>false,e=>e.code==='AUTH_REQUIRED')"));
  transport.push(...await page.run("safeTransport"));
  await page.cdp("Page.reload");
  await waitFor(page,"typeof currentUser!=='undefined'&&currentUser?.code==='FA0001'");
  await instrument(page);
  check("session restored after reload",await page.run("currentUser.role==='student'&&currentUser.studentSession.studentAccessVersion==='student-event-access-v1'"));
  await page.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");
  check("passport shows correct student without premature stamp",await page.run("document.getElementById('studentPassCode').textContent==='FA0001'&&document.querySelectorAll('.student-pass-stamp.is-complete').length===0"));
  check("student cannot self-complete",await page.run("eventCall('TEACHER_COMPLETE',{eventId:activeEvent().id,boothId:'robotics',ids:['fixture']}).then(()=>false,e=>['AUTH_REQUIRED','FORBIDDEN'].includes(e.code))"));
  const teacherPage=await client();await instrument(teacherPage);
  await teacherPage.run("document.querySelector('[data-role=admin]').click();document.getElementById('teacherEmailInput').value="+JSON.stringify(supervisor)+";validateTeacherEmail();document.getElementById('sendOtpButton').click()");
  await waitFor(teacherPage,"!teacherOtpSending&&teacherOtpEmail!==''");
  const otp=cloud.mail.at(-1).body.match(/\b\d{6}\b/)[0];
  await teacherPage.run("document.getElementById('teacherOtpInput').value="+JSON.stringify(otp)+";document.getElementById('verifyOtpButton').click()");
  await waitFor(teacherPage,"currentUser?.access?.role==='TEACHER'");
  await teacherPage.run("stopRemoteSync()");
  check("teacher OTP and assignments still work",await teacherPage.run("currentUser.role==='admin'&&!canOpenAdminTab('config')&&document.getElementById('teacherBoothSelect').options.length===7"));
  await teacherPage.run("document.getElementById('completeCurrentButton').click()");
  await waitFor(teacherPage,"!mutationBusy&&boothWaitingQueue(activeEvent().id,'robotics')[0]?.studentCode!=='FA0001'");
  await page.cdp("Page.bringToFront");
  check("stamp still absent before student sync",await page.run("document.querySelectorAll('.student-pass-stamp.is-complete').length===0"));
  await page.run("refreshEventNow()");
  check("stamp appears after teacher backend ACK and sync",await page.run("document.querySelectorAll('.student-pass-stamp.is-complete').length===1&&document.getElementById('studentPassCode').textContent==='FA0001'"));
  await page.run("window.firstConfirmedStamp=document.querySelector('.student-pass-stamp.is-complete');refreshEventNow()");
  check("unchanged read keeps same stamp",await page.run("window.firstConfirmedStamp===document.querySelector('.student-pass-stamp.is-complete')"));
  await page.cdp("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:true});await delay(260);
  fs.writeFileSync(path.join(root,"artifacts/student-login-pass-mobile.png"),Buffer.from((await page.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  await page.run("document.getElementById('studentPassClose').click()");
  cloud.advance(12*3600000+1);
  await page.run("refreshEventNow()");
  await waitFor(page,"currentUser===null&&!document.getElementById('studentLoginButton').disabled");
  check("expired session returns to login",await page.run("currentUser===null&&document.getElementById('studentPassButton').hidden"));
  await login(fixtureStudent.code,fixtureStudent.accessCode);
  check("student signs in again after expiry",await page.run("currentUser?.code==='FA0001'"));
  const logoutSession=await page.run("eventAuth()");
  await page.run("logout()");
  check("logout clears local session",await page.run("currentUser===null&&!sessionStorage.getItem(STUDENT_SESSION_KEY)"));
  check("logout revokes server session over POST",await page.run("eventCall('GET_EVENT_VIEW',{},"+JSON.stringify(logoutSession)+").then(()=>false,e=>e.code==='AUTH_REQUIRED')"));
  await page.run("loadPublicEvent()");
  apiFault="legacy";await page.run("loadPublicEvent()");
  check("legacy backend version rejected",await page.run("document.getElementById('studentLoginButton').disabled&&document.getElementById('studentLoginEvent').textContent.includes('student-event-access-v1')"));
  apiFault="public-unchanged";await page.run("loadPublicEvent()");
  check("incomplete public unchanged response rejected",await page.run("document.getElementById('studentLoginButton').disabled&&publicEventCacheSnapshot===null"));
  apiFault=401;await page.run("loadPublicEvent()");
  check("HTTP 401 distinguished from old API",await page.run("document.getElementById('studentLoginButton').disabled&&document.getElementById('studentLoginEvent').textContent.includes('HTTP 401')"));
  apiFault=null;await page.run("loadPublicEvent()");
  check("valid backend recovers login button without bypass",await page.run("!document.getElementById('studentLoginButton').disabled&&document.getElementById('studentLoginEvent').textContent==='Ngày hội Openday'"));
  await page.cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.run("window.scrollTo(0,0);document.querySelector('.ui-toast-close')?.click()");await delay(220);
  fs.writeFileSync(path.join(root,"artifacts/student-login-openday-mobile.png"),Buffer.from((await page.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  transport.push(...await page.run("safeTransport"),...await teacherPage.run("safeTransport"));
  for(const action of ["GET_EVENT_API_VERSION","GET_EVENT_VIEW","LOGIN_STUDENT","LOGOUT_STUDENT"]){
    check(action+" used POST/cors and followed JSON redirect",transport.some(row=>row.action===action&&row.method==='POST'&&row.mode==='cors'&&row.redirected&&row.status===200));
  }
  fs.writeFileSync(path.join(root,"artifacts/student-login-browser-results.json"),JSON.stringify({environment:"Chrome localhost, mocked Apps Script and Sheets, external HTTPS blocked",fixture:{students:395,classes:12,booths:11,records:2374},checks,transport},null,2));
  console.log(JSON.stringify({checks:checks.length,passed:checks.length,actions:[...new Set(transport.map(row=>row.action))]}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  for(const socket of tabs)socket.close();
  chrome?.kill();
  for(const item of servers)item.close();
});
