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
const outputName="upgrade";
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
  const checks=[];
  const check=(name,result)=>{assert.equal(result,true,name);checks.push({name,status:"PASS"});};
  async function waitFor(page,expression){
    for(let i=0;i<250;i++){
      try{if(await page.run(expression))return;}catch(error){
        if(!/Inspected target navigated|Execution context was destroyed|Cannot find context/.test(error.message))throw error;
      }
      await delay(30);
    }
    throw Error("Mock browser timed out: "+expression.replace(/"[^\"]*"/g,'"…"').slice(0,90));
  }
  const legacyUpload={mime:"image/png",content:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2QAAAAASUVORK5CYII="};
  const themeA=ok(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId:eventA,kind:"theme",operation:"upload",expectedRevision:"",upload:legacyUpload,publishApproved:true})).images.theme.version;
  const page=await client();
  await page.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  await page.run("showAdminTab('config');stopRemoteSync()");
  await waitFor(page,"!!managedEventSetup()");
  check("configuration opens event screen without roster request",!calls.includes("LIST_ROSTER"));
  check("staging fixture does not point at production",await page.run("GOOGLE_SCRIPT_URL.startsWith('http://127.0.0.1:')"));
  const shot=async(name,width,height=1050,target=page)=>{
    await target.cdp("Page.bringToFront");
    await target.cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<700});
    await target.run("window.scrollTo(0,0)");await delay(240);
    check(name+" no horizontal page overflow",await target.run("document.documentElement.scrollWidth===document.documentElement.clientWidth"));
    if(name.startsWith("events-")){
      const layout=await target.run("(()=>{const ids=['eventConfigCard','staffAssignmentCard','eventImagesCard'];return ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width}})})()");
      if(width===1280)check("desktop columns balanced and aligned",Math.abs(layout[0].y-layout[1].y)<2&&Math.abs(layout[0].width-layout[1].width)<4&&layout[1].x>layout[0].x);
      else check("mobile/tablet order "+width,layout[0].y<layout[1].y&&layout[1].y<layout[2].y&&Math.abs(layout[0].x-layout[1].x)<2);
      check("passport editor columns "+width,await target.run("(()=>{const a=document.querySelector('.passport-image-upload').getBoundingClientRect(),b=document.querySelector('.passport-image-layout').getBoundingClientRect();return "+(width===1280?"Math.abs(a.y-b.y)<2&&b.x>a.x":"b.y>a.y&&Math.abs(a.x-b.x)<2")+"})()"));
    }
    fs.writeFileSync(path.join(root,"artifacts/simplify-"+name+".png"),Buffer.from((await target.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  };
  // Synthetic artwork: no names, codes, faces or real school records.
  async function chooseImage(kind,label,color,save=true,options={}){
    const prefix="eventPassport";
    await page.run(`(()=>{
      const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=700;
      const ctx=canvas.getContext('2d');ctx.fillStyle=${JSON.stringify(color)};ctx.fillRect(0,0,1200,700);
      ctx.strokeStyle='#67e8f9';ctx.lineWidth=4;for(let i=0;i<10;i++){ctx.beginPath();ctx.moveTo(i*160,0);ctx.lineTo(i*160-400,700);ctx.stroke();}
      ctx.fillStyle='#ffffff66';ctx.font='bold 26px sans-serif';ctx.fillText(${JSON.stringify(label)},28,655);
      ctx.font='18px sans-serif';ctx.fillText('ARTWORK THU NGHIEM - KHONG CO DU LIEU CA NHAN',28,686);
      const options=${JSON.stringify(options)};
      if(options.noise){
        const pixels=ctx.createImageData(1200,700);let seed=123456;
        for(let i=0;i<pixels.data.length;i+=4){for(let j=0;j<3;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i+j]=seed>>>24;}pixels.data[i+3]=255;}
        ctx.putImageData(pixels,0,0);
      }
      if(options.alpha)ctx.clearRect(0,0,80,80);
      const mime=options.mime||'image/png';
      const bytes=Uint8Array.from(atob(canvas.toDataURL(mime,.92).split(',')[1]),c=>c.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([bytes],options.name||'fixture.'+mime.split('/')[1],{type:mime}));
      const input=document.getElementById(${JSON.stringify(prefix+"File")});input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor(page,"document.getElementById('eventImagesStatus').textContent.includes('sẵn sàng')");
    if(!save)return await page.run("document.getElementById('eventPassportImagePreview').src");
    await page.run("document.getElementById('"+prefix+"Save').click()");
    await waitFor(page,"document.getElementById('eventImagesStatus').textContent.includes('Đã lưu')&&!document.getElementById('eventImagesSelect').disabled");
    await waitFor(page,"!remoteBusy");
    return await page.run("EVENTS.find(e=>e.id===managedEventId()).images."+kind+".version");
  }
  const passportA=await chooseImage("passport","STEM PASSPORT QA","#123178");
  check("theme UI and approval checkboxes removed",await page.run("!document.querySelector('[id^=eventTheme]')&&!document.querySelector('#eventImagesForm input[type=checkbox]')"));
  check("legacy theme metadata preserved",cloud.post("GET_EVENT_SETUP",{...btc,eventId:eventA}).event.images.theme.version===themeA);
  check("private Drive files read back before success",cloud.imageFiles.size===2);
  // New editor generates unique slot IDs, then persists explicit booth/page mappings.
  await page.run("document.getElementById('eventPassportAdvanced').open=true;document.getElementById('eventPassportMode').value='template';document.getElementById('eventPassportMode').dispatchEvent(new Event('change'));document.getElementById('eventPassportCapacity').value='11';document.getElementById('eventPassportGenerate').click();document.getElementById('eventPassportSave').click()");
  await waitFor(page,"document.getElementById('eventImagesStatus').textContent.includes('Đã lưu')&&!document.getElementById('eventImagesSelect').disabled");
  check("template coordinates persisted for all booths",await page.run("EVENTS.find(e=>e.id===managedEventId()).images.passport.layout.slots.length===11"));
  const beforeB=cloud.post("GET_EVENT_SETUP",{...btc,eventId:eventB});
  const boothsB=Array.from({length:15},(_,i)=>({id:"open-"+i,name:"Gian Openday "+(i+1),location:"Khu thử "+i,topic:"Khám phá",pin:String(9000+i),icon:i%2?"microscope":"brain"}));
  ok(cloud.post("SAVE_EVENT_BOOTHS",{...btc,eventId:eventA,targetEventId:eventB,expectedBoothRevision:beforeB.boothRevision,booths:boothsB}));
  await chooseImage("passport","UNSAVED PASSPORT DRAFT","#62345b",false);
  await page.run("document.getElementById('managedEventName').value='Bản nháp STEM';document.getElementById('managedEventName').dispatchEvent(new Event('input'));selectManagedEvent("+JSON.stringify(eventB)+")");
  await waitFor(page,"managedEventSetup()?.eventId==="+JSON.stringify(eventB));
  check("selection synchronized across event/staff/image controls",await page.run("['activeEventSelect','staffEvent','eventImagesSelect'].every(id=>document.getElementById(id).value===managedEventId())"));
  check("Openday starts with its own default preview",await page.run("document.getElementById('eventPassportImagePreview').hidden&&document.getElementById('eventPassportEmpty').textContent.includes('Openday')"));
  const passportB=await chooseImage("passport","OPENDAY PASSPORT QA","#9b3e24");
  check("event artwork versions never reused",new Set([themeA,passportA,passportB]).size===3);
  await page.run("document.querySelector('[data-booth-id=\"open-0\"]').open=true;document.getElementById('boothIcon-open-0').value='rocket';document.getElementById('boothIcon-open-0').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('managedSaveBooth-open-0').click()");
  await waitFor(page,"!mutationBusy&&managedEventSetup().booths[0].icon==='rocket'");
  check("icon saved for selected event only",cloud.post("GET_EVENT_SETUP",{...btc,eventId:eventB}).booths[0].icon==="rocket"&&cloud.post("GET_EVENT_SETUP",{...btc,eventId:eventA}).booths[0].icon==="bot");
  await page.run("document.getElementById('staffEmail').value="+JSON.stringify(supervisor)+";document.getElementById('staffTeacherName').value='Giáo viên thử';document.querySelectorAll('#staffBooth input').forEach((input,i)=>input.checked=i<10);document.getElementById('staffAssignmentSubmit').click()");
  await waitFor(page,"!rosterMutationBusy&&managedEventSetup().assignments.filter(r=>r.email==="+JSON.stringify(supervisor)+"&&r.enabled).length===10");
  check("multi-booth grant acknowledged from backend",cloud.post("LIST_EVENT_ASSIGNMENTS",{...btc,eventId:eventB}).assignments.length===10);
  await page.run("document.querySelector('#staffAssignmentList button').click();document.querySelectorAll('#staffBooth input').forEach((input,i)=>input.checked=i<6);document.getElementById('staffAssignmentSubmit').click()");
  await waitFor(page,"!rosterMutationBusy&&managedEventSetup().assignments.filter(r=>r.enabled).length===6");
  check("edit replaces only chosen teacher's event assignments",cloud.post("LIST_EVENT_ASSIGNMENTS",{...btc,eventId:eventA}).assignments.length===7);
  await page.run("document.getElementById('staffTeacher').value="+JSON.stringify(supervisor)+";document.getElementById('staffTeacher').dispatchEvent(new Event('change'))");
  check("teacher picker restores that teacher's active assignments",await page.run("document.querySelectorAll('#staffBooth input:checked').length===6&&document.getElementById('staffAssignmentSubmit').textContent==='Cập nhật phân công'"));
  await page.run("selectManagedEvent("+JSON.stringify(eventA)+")");await waitFor(page,"document.getElementById('eventImagesSelect').value==="+JSON.stringify(eventA));
  check("event draft and correct artwork restored",await page.run("document.getElementById('managedEventName').value==='Bản nháp STEM'&&EVENTS.find(e=>e.id===managedEventId()).images.theme.version==="+JSON.stringify(themeA)));
  check("unsaved passport draft survives event switch",await page.run("!document.getElementById('eventPassportImagePreview').hidden"));
  await page.run("selectManagedEvent("+JSON.stringify(eventB)+");showConfigSection('students')");
  await waitFor(page,"!!rosterDesk");
  const rosterReads=calls.filter(action=>action==="LIST_ROSTER").length;
  await page.run("document.getElementById('rosterSearch').value='giả';showConfigSection('events');showConfigSection('students')");
  check("subtabs preserve search and avoid duplicate roster read",await page.run("document.getElementById('rosterSearch').value==='giả'")&&calls.filter(action=>action==="LIST_ROSTER").length===rosterReads);
  await shot("students-desktop",1280,950);await shot("students-mobile",390,950);
  await page.run("showConfigSection('events')");
  for(const width of [1280,768,390,320])await shot("events-"+width,width,width===1280?1450:1100);
  for(const [name,id,width] of [["images-desktop","eventImagesCard",1280],["assignments-mobile","staffAssignmentCard",390],["images-mobile","eventImagesCard",390]]){
    await page.cdp("Emulation.setDeviceMetricsOverride",{width,height:1050,deviceScaleFactor:1,mobile:width<700});
    await page.run("document.getElementById("+JSON.stringify(id)+").scrollIntoView({block:'start'})");await delay(240);
    fs.writeFileSync(path.join(root,"artifacts/simplify-"+name+".png"),Buffer.from((await page.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  }
  // Reset the passport and restore its previous version without deleting Drive files.
  await page.run("document.getElementById('eventPassportDefault').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&!EVENTS.find(e=>e.id===managedEventId()).images.passport?.version");
  check("passport default preserves legacy theme and files",cloud.post("GET_EVENT_SETUP",{...btc,eventId:eventA}).event.images.theme.version===themeA&&cloud.imageFiles.size===3);
  await page.run("document.getElementById('eventPassportRestore').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&EVENTS.find(e=>e.id===managedEventId()).images.passport?.version==="+JSON.stringify(passportB));
  const another=await client();
  await another.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  await another.run("showAdminTab('config');selectManagedEvent("+JSON.stringify(eventB)+");stopRemoteSync()");
  await waitFor(another,"managedEventSetup()?.eventId==="+JSON.stringify(eventB));
  check("another browser loads the saved event images",await another.run("managedEventSetup().event.images.passport.version==="+JSON.stringify(passportB)));
  // Student A sees artwork through GET/JSON from the app, never a Drive grant.
  const studentPage=await client();
  await studentPage.run("document.getElementById('studentCodeInput').value="+JSON.stringify(fixtureStudent.code)+";document.getElementById('studentAccessInput').value="+JSON.stringify(fixtureStudent.accessCode)+";document.getElementById('studentLoginButton').click()");
  await waitFor(studentPage,"currentUser?.code==='FA0001'");
  await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");
  await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  check("full passport artwork with no premature stamps",await studentPage.run("document.getElementById('studentPassDialog').style.getPropertyValue('--event-artwork')===''&&document.getElementById('studentPassArtwork').style.getPropertyValue('--event-artwork')!==''&&!document.getElementById('studentPassCanvas').contains(document.querySelector('.student-pass-profile'))&&document.querySelectorAll('.student-pass-stamp.is-complete').length===0"));
  const teacherPage=await client();
  await teacherPage.run("loginAdmin("+JSON.stringify(supervisor)+","+JSON.stringify(teacher.authToken)+",3600)");
  await teacherPage.run("stopRemoteSync();document.getElementById('completeCurrentButton').click()");
  await waitFor(teacherPage,"!mutationBusy&&boothWaitingQueue(activeEvent().id,'robotics')[0]?.studentCode!=='FA0001'");
  await studentPage.cdp("Page.bringToFront");await waitFor(studentPage,"!remoteBusy");await studentPage.run("refreshEventNow()");
  await waitFor(studentPage,"document.querySelectorAll('.student-pass-stamp.is-complete').length===1");
  check("official completion adds one stamp with correct icon",await studentPage.run("document.querySelectorAll('.student-pass-stamp.is-complete').length===1&&document.querySelector('.student-pass-stamp.is-complete [data-lucide]').getAttribute('data-lucide')==='bot'"));
  for(const width of [1280,768,390,320]){
    await shot("passport-"+width,width,950,studentPage);
    check("round stamps "+width,await studentPage.run("[...document.querySelectorAll('.student-pass-stamp')].every(n=>Math.abs(n.getBoundingClientRect().width-n.getBoundingClientRect().height)<1)"));
  }
  await studentPage.run("window.qaReloadMarker=true");
  await studentPage.cdp("Page.reload");await waitFor(studentPage,"!window.qaReloadMarker&&document.readyState==='complete'&&typeof currentUser!=='undefined'&&currentUser?.code==='FA0001'");
  await studentPage.run("document.getElementById('studentPassButton').click();stopRemoteSync()");
  check("reload keeps official progress",await studentPage.run("document.querySelectorAll('.student-pass-stamp.is-complete').length===1"));
  const aImages=cloud.post("GET_EVENT_SETUP",{...btc,eventId:eventA}).event.images;
  const aDefault=ok(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId:eventA,kind:"passport",operation:"default",expectedRevision:aImages.revision}));
  await waitFor(studentPage,"!remoteBusy");await studentPage.run("refreshEventNow()");
  await waitFor(studentPage,"!document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  check("missing passport uses fallback even with a legacy theme",await studentPage.run("document.querySelectorAll('.student-pass-stamp.is-complete').length===1&&EVENTS.find(e=>e.id===activeEvent().id).images.theme.version==="+JSON.stringify(themeA)));
  ok(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId:eventA,kind:"passport",operation:"restore",expectedRevision:aDefault.images.revision}));
  await waitFor(studentPage,"!remoteBusy");await studentPage.run("refreshEventNow()");
  await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  check("restoring passport keeps the official stamp",await studentPage.run("document.querySelectorAll('.student-pass-stamp.is-complete').length===1"));
  await studentPage.run("document.getElementById('studentPassClose').click()");
  await page.cdp("Page.bringToFront");await page.run("document.getElementById('managedEventActivate').click()");
  await waitFor(page,"!mutationBusy&&activeEvent().id==="+JSON.stringify(eventB));
  check("event switch ACK contains correct booths",await page.run("BOOTHS.length===15&&BOOTHS[0].icon==='rocket'"));
  const [openLogin]=studentLogins(cloud,btc,[profiles[0].code],eventB);
  await studentPage.run("logout();loadPublicEvent()");await waitFor(studentPage,"!document.getElementById('studentLoginButton').disabled");
  await studentPage.run("document.getElementById('studentCodeInput').value="+JSON.stringify(openLogin.code)+";document.getElementById('studentAccessInput').value="+JSON.stringify(openLogin.accessCode)+";document.getElementById('studentLoginButton').click()");
  await waitFor(studentPage,"currentUser?.studentSession.eventId==="+JSON.stringify(eventB));
  await studentPage.run("document.getElementById('studentPassButton').click();stopRemoteSync()");
  await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  check("Openday passport has its own 15 booths and no STEM stamp",await studentPage.run("document.querySelectorAll('.student-pass-stamp').length===15&&document.querySelectorAll('.student-pass-stamp.is-complete').length===0&&document.querySelector('[data-booth-id=\"open-0\"] .student-pass-stamp').children.length===0"));
  await shot("openday-pass-mobile",390,950,studentPage);
  await page.cdp("Page.bringToFront");
  await page.cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  check("reduced motion preserved",await page.run("getComputedStyle(document.getElementById('managedEventReload')).transitionDuration==='0s'"));
  await page.cdp("Emulation.setEmulatedMedia",{features:[]});
  await page.run("document.getElementById('configEventsTab').focus()");
  await page.cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
  check("keyboard switches configuration subtab",await page.run("!document.getElementById('configStudentsView').hidden&&document.activeElement.id==='configStudentsTab'"));
  await page.run("showConfigSection('events')");
  await page.cdp("Emulation.setDeviceMetricsOverride",{width:390,height:950,deviceScaleFactor:1,mobile:true});
  const rect=await page.run("(()=>{const r=document.getElementById('configStudentsTab').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await page.cdp("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[rect]});await page.cdp("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  check("touch switches configuration subtab",await page.run("!document.getElementById('configStudentsView').hidden"));
  await page.run("showConfigSection('events');stopRemoteSync()");
  const formats=[];
  for(const scenario of [
    {label:"PNG opaque",mime:"image/png",expected:"image/png"},
    {label:"JPEG with mismatched filename",mime:"image/jpeg",name:"fixture.png",expected:"image/jpeg"},
    {label:"WebP opaque",mime:"image/webp",expected:"image/png"},
    {label:"WebP transparent",mime:"image/webp",alpha:true,expected:"image/png"},
    {label:"large opaque PNG",mime:"image/png",noise:true,expected:"image/jpeg"},
    {label:"large transparent PNG",mime:"image/png",noise:true,alpha:true,expected:"image/png",resized:true}
  ]){
    const version=await chooseImage("passport","FORMAT QA","#235f91",true,scenario);
    const bytes=[...cloud.imageFiles.values()].at(-1).getBytes();
    const info=cloud.context.eventImageDimensions_(bytes);
    const saved=ok(cloud.post("PREVIEW_EVENT_IMAGE",{...btc,eventId:eventB,kind:"passport",version}));
    await waitFor(page,"!document.getElementById('eventPassportImagePreview').hidden");
    const decoded=await page.run("(async()=>{const img=document.getElementById('eventPassportImagePreview');await img.decode();const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return {width:img.naturalWidth,alpha:ctx.getImageData(0,0,1,1).data[3]}})()");
    check("Drive-compatible output: "+scenario.label,info.mime===scenario.expected&&bytes.length<=1024*1024&&
      Buffer.from(saved.content,"base64").equals(Buffer.from(bytes))&&(!scenario.alpha||decoded.alpha===0)&&(!scenario.resized||decoded.width<1200));
    formats.push({input:scenario.label,mime:info.mime,bytes:bytes.length,width:info.width,height:info.height,transparent:decoded.alpha<255,status:"PASS"});
  }
  fs.writeFileSync(path.join(root,"artifacts/passport-image-format-results.json"),JSON.stringify({environment:"Chrome localhost with mocked Drive; no real Drive preview tested",formats},null,2));
  const imageBeforeFailure=await page.run("managedEventSetup().event.images.passport.version");
  await chooseImage("passport","WRITE FAILURE QA","#145a82",false);apiFault="image-denied";
  const writesBeforeFailure=calls.filter(action=>action==="SAVE_EVENT_IMAGE").length;
  await page.run("document.getElementById('eventPassportSave').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&document.getElementById('eventImagesStatus').textContent.includes('Lỗi ghi ảnh giả lập')");
  check("failed image write never reports success or retries",calls.filter(action=>action==="SAVE_EVENT_IMAGE").length===writesBeforeFailure+1&&await page.run("managedEventSetup().event.images.passport.version==="+JSON.stringify(imageBeforeFailure)));
  apiFault="image-metadata";
  await page.run("document.getElementById('eventPassportSave').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&document.getElementById('eventImagesStatus').textContent.includes('Chưa đối chiếu')");
  check("committed write with malformed response requires reconciliation",await page.run("managedEventSetup().event.images.passport.version==="+JSON.stringify(imageBeforeFailure)));
  apiFault=null;
  const actualVersion=cloud.post("GET_EVENT_SETUP",{...btc,eventId:eventB}).event.images.passport.version;
  const beforeReloadWrites=calls.filter(action=>action==="SAVE_EVENT_IMAGE").length;
  await page.run("document.getElementById('eventImagesReload').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&managedEventSetup().event.images.passport.version==="+JSON.stringify(actualVersion));
  check("reload reconciles without repeating the write",calls.filter(action=>action==="SAVE_EVENT_IMAGE").length===beforeReloadWrites);
  // Exercise the actual website controls and native confirmation dialogs.
  await page.run("document.getElementById('newEventName').value='Sự kiện tạo nhầm QA';document.getElementById('newEventDate').value='Ngày thử';addEvent()");
  await waitFor(page,"!mutationBusy&&managedEventSetup()?.event.name==='Sự kiện tạo nhầm QA'");
  const mistakenId=await page.run("managedEventId()");
  const anotherBtcImage=ok(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId:mistakenId,kind:"passport",operation:"upload",expectedRevision:"",upload:legacyUpload}));
  const setupReads=calls.filter(action=>action==="GET_EVENT_SETUP").length,viewReads=calls.filter(action=>action==="GET_EVENT_VIEW").length;
  await page.run("stopRemoteSync();document.getElementById('eventImagesReload').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&managedEventSetup().event.images.passport?.version==="+JSON.stringify(anotherBtcImage.images.passport.version));
  check("reload inactive selected event reads only its own setup",calls.filter(action=>action==="GET_EVENT_SETUP").length===setupReads+1&&calls.filter(action=>action==="GET_EVENT_VIEW").length===viewReads);
  await page.run("archiveManagedEvent("+JSON.stringify(mistakenId)+")");
  await waitFor(page,"!mutationBusy&&EVENTS.find(e=>e.id==="+JSON.stringify(mistakenId)+").archived&&eventDeleteEligibility(EVENTS.find(e=>e.id==="+JSON.stringify(mistakenId)+")).canDelete");
  check("archived empty event delete enabled and light red",await page.run("(()=>{const b=document.querySelector('[data-delete-event=\""+mistakenId+"\"]');return !b.disabled&&getComputedStyle(b).color==='rgb(180, 35, 50)'})()"));
  check("active event has visible exact reason",await page.run("document.getElementById('delete-reason-"+eventB+"').textContent==='Vui lòng ngừng kích hoạt sự kiện trước khi xóa'"));
  check("event with history has visible dependency reason",await page.run("document.getElementById('delete-reason-"+eventA+"').textContent.includes('lịch sử')&&document.querySelector('[data-delete-event=\""+eventA+"\"]').disabled"));
  for(const width of [1280,390,320]){
    await page.cdp("Emulation.setDeviceMetricsOverride",{width,height:1100,deviceScaleFactor:1,mobile:width<700});
    await page.run("document.getElementById('eventConfigCards').scrollIntoView({block:'start'})");await delay(180);
    check("event delete reasons fit "+width,await page.run("document.documentElement.scrollWidth===document.documentElement.clientWidth"));
    fs.writeFileSync(path.join(root,"artifacts/event-delete-buttons-"+width+".png"),Buffer.from((await page.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  }
  const deleteClick="document.querySelector('[data-managed-event=\""+mistakenId+"\"]').closest('.managed-event-row').querySelector('.managed-event-actions button:last-child').click()";
  const callsBeforeCancel=calls.filter(action=>action==="MANAGE_EVENT").length;
  page.nextDialog(false);await page.run(deleteClick);
  check("cancel event deletion sends no write",calls.filter(action=>action==="MANAGE_EVENT").length===callsBeforeCancel&&await page.run("EVENTS.some(e=>e.id==="+JSON.stringify(mistakenId)+")"));
  await page.run(deleteClick);await waitFor(page,"!rosterMutationBusy&&!EVENTS.some(e=>e.id==="+JSON.stringify(mistakenId)+")");
  check("deleted event hidden from all normal selectors",await page.run("['activeEventSelect','staffEvent','eventImagesSelect'].every(id=>![...document.getElementById(id).options].some(o=>o.value==="+JSON.stringify(mistakenId)+"))"));
  check("soft-deleted event remains restorable",await page.run("appState.eventConfig.deletedEvents.some(e=>e.id==="+JSON.stringify(mistakenId)+")&&!!document.querySelector('.managed-deleted-events button')"));
  check("deleting selected event selects a valid remaining event",await page.run("managedEventId()!=="+JSON.stringify(mistakenId)+"&&EVENTS.some(e=>e.id===managedEventId())"));
  await another.run("window.qaDeleteReloadMarker=true");await another.cdp("Page.reload");
  await waitFor(another,"!window.qaDeleteReloadMarker&&document.readyState==='complete'&&currentUser?.role==='admin'");
  await another.run("showAdminTab('config');stopRemoteSync()");await waitFor(another,"!!currentEventDeleteState()");
  check("reload does not resurrect soft-deleted event",await another.run("!EVENTS.some(e=>e.id==="+JSON.stringify(mistakenId)+")&&currentEventDeleteState().events.find(e=>e.eventId==="+JSON.stringify(mistakenId)+").canRestore"));
  await waitFor(page,"!!currentEventDeleteState()&&!document.querySelector('.managed-deleted-events button').disabled");
  await page.run("document.querySelector('.managed-deleted-events').open=true;document.querySelector('.managed-deleted-events button').click()");
  await waitFor(page,"!rosterMutationBusy&&EVENTS.some(e=>e.id==="+JSON.stringify(mistakenId)+")");
  check("restore does not activate the event",await page.run("activeEvent().id==="+JSON.stringify(eventB)+"&&!appState.eventConfig.deletedEvents.length"));
  const beforeBlocked=cloud.metrics.writes;
  await page.run("deleteEvent("+JSON.stringify(eventA)+")");
  await waitFor(page,"!rosterMutationBusy");
  check("business history blocks deletion with clear error",await page.run("EVENTS.some(e=>e.id==="+JSON.stringify(eventA)+")&&document.querySelector('.ui-toast-message').textContent.includes('không thể xóa')")&&cloud.metrics.writes===beforeBlocked);
  check("active event delete button disabled",await page.run("document.querySelector('[data-managed-event=\""+eventB+"\"]').closest('.managed-event-row').querySelector('.managed-event-actions button:last-child').disabled"));
  await page.run("selectManagedEvent("+JSON.stringify(eventB)+")");await waitFor(page,"managedEventSetup()?.eventId==="+JSON.stringify(eventB));
  const row="[...document.querySelectorAll('#staffAssignmentList .staff-assignment-row')].find(n=>n.dataset.boothId==='open-0'&&n.dataset.email==="+JSON.stringify(supervisor)+")";
  check("active assignment cannot be deleted",await page.run(row+".querySelectorAll('button')[2].disabled"));
  await page.run(row+".querySelectorAll('button')[1].click()");await waitFor(page,"!rosterMutationBusy&&managedEventSetup().assignments.find(r=>r.boothId==='open-0').enabled===false");
  check("revoked assignment delete is now enabled",await page.run("!"+row+".querySelectorAll('button')[2].disabled"));
  const assignmentWrites=calls.filter(action=>action==="DELETE_EVENT_ASSIGNMENT").length;
  await page.run(row+".querySelectorAll('button')[2].click()");
  await waitFor(page,"!rosterMutationBusy&&!managedEventSetup().assignments.some(r=>r.boothId==='open-0')");
  check("one assignment deletion sends one write",calls.filter(action=>action==="DELETE_EVENT_ASSIGNMENT").length===assignmentWrites+1);
  check("other assignments survive",cloud.post("LIST_EVENT_ASSIGNMENTS",{...btc,eventId:eventA}).assignments.length===7&&cloud.post("LIST_EVENT_ASSIGNMENTS",{...btc,eventId:eventB}).assignments.length===5);
  await teacherPage.run("refreshEventNow();stopRemoteSync()");await waitFor(teacherPage,"!remoteBusy");
  check("teacher's revoked booth stays inaccessible",await teacherPage.run("!canManageFrontBooth('open-0')&&canManageFrontBooth('open-1')"));
  check("native confirmation dialogs used",page.dialogs.filter(type=>type==="confirm").length>=6);
  await shot("deletions-desktop",1280,1100);
  for(const width of [390,320]){
    await page.cdp("Emulation.setDeviceMetricsOverride",{width,height:1050,deviceScaleFactor:1,mobile:true});
    await page.run("document.getElementById('staffAssignmentCard').scrollIntoView({block:'start'})");await delay(150);
    check("assignment controls fit "+width,await page.run("document.documentElement.scrollWidth===document.documentElement.clientWidth"));
    fs.writeFileSync(path.join(root,"artifacts/simplify-deletions-"+width+".png"),Buffer.from((await page.cdp("Page.captureScreenshot",{format:"png"})).data,"base64"));
  }
  const stats={checks,fixture:{students:395,classes:12,boothsA:11,boothsB:15},externalServices:"BLOCKED; Sheets, Drive, MailApp are mocks",actions:[...new Set(calls)]};
  fs.writeFileSync(path.join(root,"artifacts/event-delete-browser-results.json"),JSON.stringify(stats,null,2));
  console.log(JSON.stringify({checks:checks.length,passed:checks.length}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  for(const socket of tabs)socket.close();
  chrome?.kill();
  for(const item of servers)item.close();
});
