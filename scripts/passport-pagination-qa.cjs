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
const beforeDir="/private/tmp/fs-layout16-before";
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
      if(apiFault==="layout-missing"&&body.action==="GET_EVENT_SETUP"&&result.event?.images)delete result.event.images.passportLayoutVersion;
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

  const G=(()=>{const c=vm.createContext({window:{}});vm.runInContext(fs.readFileSync('passport-layout.js','utf8'),c);return c.window.FSchoolPassportLayout;})();
  const allBooths=Array.from({length:20},(_,i)=>i<booths.length?booths[i]:{...booths[0],id:'layout-extra-'+i,name:'Gian hàng thử '+(i+1),icon:i%2?'brain':'box',pin:String(8500+i)});
  ok(cloud.post('SAVE_EVENT_BOOTHS',{...btc,booths:allBooths.slice(0,15)}));
  const page=await client();
  await page.run('loginAdmin('+JSON.stringify(admin)+','+JSON.stringify(btc.authToken)+',3600)');
  await page.run("showAdminTab('config');stopRemoteSync()");await waitFor(page,'!!managedEventSetup()');
  async function choose(kind,path,name){
    await page.run('document.getElementById("eventPassportVariant").value='+JSON.stringify(kind)+';document.getElementById("eventPassportVariant").dispatchEvent(new Event("change"))');
    await page.run(`(async()=>{const blob=await fetch(${JSON.stringify(path)}).then(r=>r.blob()),data=new DataTransfer();data.items.add(new File([blob],${JSON.stringify(name)},{type:'image/png'}));const input=document.getElementById('eventPassportFile');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(page,"document.getElementById('eventImagesStatus').textContent.includes('sẵn sàng')");
    await page.run("document.getElementById('eventPassportSave').click()");
    await waitFor(page,'!document.getElementById("eventImagesSelect").disabled&&managedEventSetup().event.images.'+kind+'?.version');
    check('POST/redirect/JSON stores '+kind,!!ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images[kind]?.version);
  }
  await choose('passport','/profile-reference-desktop.png','FPT_Open_STEM_Day_Ngang_HoTen_Lop.png');
  await choose('passportMobile','/profile-reference-mobile.png','FPT_Open_STEM_Day_Doc_393x852_DPR3_HoTen_Lop.png');
  async function saveLayout(kind,amount){
    await page.run('document.getElementById("eventPassportVariant").value='+JSON.stringify(kind)+';document.getElementById("eventPassportVariant").dispatchEvent(new Event("change"));document.getElementById("eventPassportAdvanced").open=true;document.getElementById("eventPassportMode").value="template";document.getElementById("eventPassportMode").dispatchEvent(new Event("change"));document.getElementById("eventPassportCapacity").value='+amount+';document.getElementById("eventPassportGenerate").click()');
    check(kind+' draft has actual number of slots',await page.run('document.querySelectorAll("#eventPassportPositions fieldset").length==='+amount));
    await page.run("document.getElementById('eventPassportSave').click()");
    await waitFor(page,'!document.getElementById("eventImagesSelect").disabled&&managedEventSetup().event.images.'+kind+'?.layout?.capacity==='+amount);
    check(kind+' saved capability is genuine',ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images.passportLayoutVersion==='passport-layout-v2');
  }
  await saveLayout('passport',12);await saveLayout('passportMobile',6);
  const savedLayouts=ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images;
  check('independent Desktop/Mobile slot geometry',savedLayouts.passport.layout.capacity===12&&savedLayouts.passportMobile.layout.capacity===6&&savedLayouts.passport.layout.slots[0].x!==savedLayouts.passportMobile.layout.slots[0].x);
  await page.run("document.getElementById('eventPassportPreviewDesktop').click();document.getElementById('eventPassportExpand').click()");
  await waitFor(page,"document.getElementById('eventImageViewer').open&&document.querySelector('#eventImageViewerMarks .is-draggable')");
  const getFirst=()=>page.run("(()=>{const m=document.querySelector('#eventImageViewerMarks .is-draggable'),r=m.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const originalX=await page.run("document.querySelector('#eventPassportPositions [data-coordinate=x]').value");
  const position=await getFirst();
  await page.cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:position.x,y:position.y,button:'left',clickCount:1});
  await page.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:position.x+5,y:position.y,button:'left',buttons:1});
  await page.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:position.x+5,y:position.y,button:'left',clickCount:1});
  check('real pointer drag updates normalized X',await page.run("document.querySelector('#eventPassportPositions [data-coordinate=x]').value!=="+JSON.stringify(originalX)));
  await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportUndo').click()");
  check('undo restores previous draft geometry',await page.run("document.querySelector('#eventPassportPositions [data-coordinate=x]').value==="+JSON.stringify(originalX)));
  await page.run("document.querySelector('#eventPassportPositions [data-coordinate=size]').value=9.2;document.querySelector('#eventPassportPositions [data-coordinate=size]').dispatchEvent(new Event('change'))");
  check('numeric diameter updates preview draft',await page.run("Number(document.querySelector('#eventPassportPositions [data-coordinate=size]').value)===9.2"));
  await page.run("document.getElementById('eventPassportSave').click()");
  await waitFor(page,'!document.getElementById("eventImagesSelect").disabled&&managedEventSetup().event.images.passport.layout.slots[0].size===9.2');
  check('saving Desktop edit preserves Mobile mapping',JSON.stringify(ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images.passportMobile.layout)===JSON.stringify(savedLayouts.passportMobile.layout));
  const queueBefore=JSON.stringify(cloud.sheets.get('WorkflowState').rows.filter(r=>r[0]!=='config'));
  await page.run("document.getElementById('eventPassportRestoreLayout').click()");
  await waitFor(page,'!document.getElementById("eventImagesSelect").disabled&&managedEventSetup().event.images.passport.layout.slots[0].size!==9.2');
  check('server restores prior layout without changing completion',JSON.stringify(cloud.sheets.get('WorkflowState').rows.filter(r=>r[0]!=='config'))===queueBefore);
  await page.run("document.getElementById('eventPassportAdvanced').open=true;document.getElementById('eventPassportExpand').click()");
  await delay(60);
  fs.writeFileSync(path.join(root,'artifacts/layout16-admin-desktop.png'),Buffer.from((await page.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportPreviewMobile').click();document.getElementById('eventPassportExpand').click()");
  await delay(60);
  const mobileX=await page.run("document.querySelector('#eventPassportPositions [data-coordinate=x]').value");
  const touch=await page.run("(()=>{const r=document.querySelector('#eventImageViewerMarks .is-draggable').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await page.cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  await page.cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...touch,id:0}]});
  await page.cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touch.x+4,y:touch.y,id:0}]});
  await page.cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  check('touch drag changes only Mobile draft',await page.run("document.querySelector('#eventPassportPositions [data-coordinate=x]').value!=="+JSON.stringify(mobileX)));
  await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportUndo').click();document.getElementById('eventPassportExpand').click()");
  await page.cdp('Emulation.setTouchEmulationEnabled',{enabled:false});
  const keyX=await page.run("document.querySelector('#eventPassportPositions [data-coordinate=x]').value");
  await page.run("document.querySelector('#eventImageViewerMarks .is-draggable').focus()");
  await page.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await page.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  check('keyboard refines Mobile slot and keeps focus inside viewer',await page.run("document.getElementById('eventImageViewer').contains(document.activeElement)&&document.querySelector('#eventPassportPositions [data-coordinate=x]').value!=="+JSON.stringify(keyX)));
  await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportUndo').click();document.getElementById('eventPassportExpand').click()");
  fs.writeFileSync(path.join(root,'artifacts/layout16-admin-mobile.png'),Buffer.from((await page.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportPreviewDesktop').click()");
  // Restoring one profile must not overwrite its ACK with the other device's draft.
  await page.run("document.getElementById('eventPassportPreviewMobile').click();document.getElementById('eventPassportProfileTemplate').value='';document.getElementById('eventPassportProfileTemplate').dispatchEvent(new Event('change'));document.getElementById('eventPassportPreviewDesktop').click();document.getElementById('eventPassportProfileTemplate').value='';document.getElementById('eventPassportProfileTemplate').dispatchEvent(new Event('change'));document.getElementById('eventPassportSave').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&!managedEventSetup().event.images.passport.layout.profileTemplate");
  await page.run("document.getElementById('eventPassportRestoreLayout').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&managedEventSetup().event.images.passport.layout.profileTemplate==='open-stem-landscape-v1'");
  check('restored Desktop profile comes from ACK while Mobile is dirty',await page.run("document.getElementById('eventPassportProfileTemplate').value==='open-stem-landscape-v1'"));
  await page.run("document.getElementById('eventPassportPreviewMobile').click()");
  check('Desktop restore preserves unsaved Mobile profile independently',await page.run("document.getElementById('eventPassportProfileTemplate').value===''&&managedEventSetup().event.images.passportMobile.layout.profileTemplate==='open-stem-portrait-v1'"));
  await page.run("document.getElementById('eventImagesReload').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&document.getElementById('eventPassportProfileTemplate').value==='open-stem-portrait-v1'");
  await page.run("document.getElementById('eventPassportPreviewDesktop').click()");
  const imageHash=()=>JSON.stringify([...cloud.imageFiles.values()].map(blob=>crypto.createHash('sha256').update(Buffer.from(blob.getBytes())).digest('hex'))),beforeHash=imageHash();
  // A real resize handle changes diameter; out-of-bound drag is clamped inside safe area.
  await page.run("document.getElementById('eventPassportAdvanced').open=true;document.getElementById('eventPassportExpand').click()");
  const handle=await page.run("(()=>{const r=document.querySelector('#eventImageViewerMarks .passport-resize-handle').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const sizeBefore=await page.run("document.querySelector('#eventPassportPositions [data-coordinate=size]').value");
  await page.cdp('Input.dispatchMouseEvent',{type:'mousePressed',...handle,button:'left',clickCount:1});
  await page.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x-5,y:handle.y,button:'left',buttons:1});
  await page.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x-5,y:handle.y,button:'left',clickCount:1});
  check('resize handle adjusts diameter',await page.run("document.querySelector('#eventPassportPositions [data-coordinate=size]').value!=="+JSON.stringify(sizeBefore)));
  await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportUndo').click()");
  await page.run("window.paginationReloadMarker=true");await page.cdp('Page.reload');
  await waitFor(page,"!window.paginationReloadMarker&&typeof currentUser!=='undefined'&&currentUser?.role==='admin'");
  await page.run("showAdminTab('config');stopRemoteSync()");await waitFor(page,'!!managedEventSetup()');
  check('reload reads saved layout from backend',await page.run("managedEventSetup().event.images.passport.layout.capacity===12&&managedEventSetup().event.images.passportMobile.layout.capacity===6"));
  // Before screenshot: same image/data with the previous source files.
  if(baselineAvailable){
    const old=await client(app+'/before/index.html');
    await old.run('document.getElementById("studentCodeInput").value='+JSON.stringify(fixtureStudent.code)+';document.getElementById("studentAccessInput").value='+JSON.stringify(fixtureStudent.accessCode)+';document.getElementById("studentLoginButton").click()');await waitFor(old,"currentUser?.role==='student'");
    await old.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");
    await waitFor(old,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
    for(const width of [1280,390]){await old.cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<700});await delay(120);fs.writeFileSync(path.join(root,'artifacts/layout16-before-'+width+'.png'),Buffer.from((await old.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));}
  }
  const studentPage=await client();
  await studentPage.run('document.getElementById("studentCodeInput").value='+JSON.stringify(fixtureStudent.code)+';document.getElementById("studentAccessInput").value='+JSON.stringify(fixtureStudent.accessCode)+';document.getElementById("studentLoginButton").click()');await waitFor(studentPage,"currentUser?.role==='student'");
  await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  const metrics=[];
  for(const [width,height] of [[1280,900],[430,932],[390,844],[375,812],[320,700]]){
    await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});await delay(100);
    await studentPage.run("while(!document.getElementById('studentPassPrevious').disabled)document.getElementById('studentPassPrevious').click()");
    const expected=width>=768?[12,3]:[6,6,3];
    for(let i=0;i<expected.length;i++){
      const m=await studentPage.run(`(()=>{const c=document.getElementById('studentPassCanvas'),a=document.getElementById('studentPassArtwork'),r=c.getBoundingClientRect(),ar=a.getBoundingClientRect(),visible=[...document.querySelectorAll('#studentPassBooths>li')].filter(n=>!n.hidden).map(n=>{const s=n.querySelector('button'),x=s.getBoundingClientRect();return{id:n.dataset.boothId,x:x.x-r.x,y:x.y-r.y,w:x.width,h:x.height,done:s.classList.contains('is-complete')}});return{w:r.width,h:r.height,artH:ar.height,visible,overflow:document.getElementById('studentPassDialog').scrollWidth-document.getElementById('studentPassDialog').clientWidth,page:document.getElementById('studentPassPageStatus').textContent}})()`);
      check('page count '+width+'/'+(i+1),m.visible.length===expected[i]);
      check('no tail or distortion '+width+'/'+(i+1),Math.abs(m.h-m.artH)<3&&Math.abs(m.w/m.h-(width>=768?2098/749:1179/2556))<.015&&m.overflow<=1);
      check('all circles inside safe area '+width+'/'+(i+1),m.visible.every(s=>s.x>=0&&s.y>=m.h*(width>=768?.40:.36)-2&&s.x+s.w<=m.w+1&&s.y+s.h<=m.h+1&&Math.abs(s.w-s.h)<1&&s.w>=(width>=768?79:69)));
      check('no fake completion '+width+'/'+(i+1),m.visible.every(s=>!s.done));metrics.push({width,...m});
      fs.writeFileSync(path.join(root,`artifacts/layout16-after-${width}-page${i+1}.png`),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
      await studentPage.run("document.getElementById('studentPassNext').click()");
    }
  }
  const lastBooth=allBooths[14];
  const studentAuth=await studentPage.run('eventAuth()');
  const joined=ok(cloud.post('JOIN_QUEUE',{...studentAuth,eventId:eventA,boothId:lastBooth.id,pin:lastBooth.pin}));
  const qid=joined.record.id;
  const denied=cloud.post('TEACHER_COMPLETE',{...studentAuth,eventId:eventA,boothId:lastBooth.id,ids:[qid]});check('student cannot self-stamp',!denied.success);
  ok(cloud.post('TEACHER_COMPLETE',{...btc,eventId:eventA,boothId:lastBooth.id,ids:[qid]}));
  check('completion waits for authenticated snapshot',await studentPage.run("document.querySelectorAll('#studentPassDialog .is-complete').length===0"));
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,"document.querySelectorAll('#studentPassDialog .is-complete').length===1");
  check('page 3 retains exact completed boothId',await studentPage.run("document.querySelector('#studentPassBooths .is-complete').parentElement.dataset.boothId==="+JSON.stringify(lastBooth.id)));
  await studentPage.run("window.paginationReloadMarker=true");await studentPage.cdp('Page.reload');await waitFor(studentPage,"!window.paginationReloadMarker&&typeof currentUser!=='undefined'&&currentUser?.role==='student'");
  await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");await waitFor(studentPage,"document.querySelectorAll('#studentPassDialog .is-complete').length===1");
  check('reload preserves backend-confirmed stamp',await studentPage.run("document.querySelector('#studentPassBooths .is-complete').parentElement.dataset.boothId==="+JSON.stringify(lastBooth.id)));
  for(const [width,height,label] of [[1280,900,'desktop'],[390,844,'mobile']]){
    await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});await delay(100);
    await studentPage.run("document.getElementById('studentPassNext').click();document.getElementById('studentPassNext').click()");
    fs.writeFileSync(path.join(root,'artifacts/layout16-confirmed-'+label+'.png'),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  // Actual auto renderer, all required booth counts. Existing templates remain a read-only configuration.
  for(const count of [2,6,10,11,12,15,20]){
    ok(cloud.post('SAVE_EVENT_BOOTHS',{...btc,booths:allBooths.slice(0,count)}));
    for(const kind of ['passport','passportMobile']){
      const info=ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images;
      const old=info[kind].layout;
      ok(cloud.post('SAVE_EVENT_IMAGE',{...btc,eventId:eventA,kind,operation:'layout',expectedRevision:info.revision,layout:{layoutVersion:G.version,mode:'auto',safeArea:old.safeArea,profileTemplate:old.profileTemplate}}));
    }
    await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,'!remoteBusy');
    for(const width of [1280,430,390,375,320]){
      await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<700});await delay(60);
      const m=await studentPage.run(`(()=>{const c=document.getElementById('studentPassCanvas'),r=c.getBoundingClientRect(),list=[...document.querySelectorAll('#studentPassBooths>li')],seen=list.filter(n=>!n.hidden).map(n=>{const x=n.getBoundingClientRect();return{x:x.x-r.x,y:x.y-r.y,w:x.width,h:x.height}});return{w:r.width,h:r.height,total:list.length,visible:seen,ratio:r.width/r.height,overflow:document.getElementById('studentPassDialog').scrollWidth-document.getElementById('studentPassDialog').clientWidth}})()`);
      check('auto bounded circles '+count+'/'+width,m.total===count&&m.visible.length>0&&m.overflow<=1&&m.visible.every(s=>s.x>=0&&s.y>=0&&s.x+s.w<=m.w+1&&s.y+s.h<=m.h+1&&Math.abs(s.w-s.h)<1));
    }
  }
  check('geometry never modifies image bytes',beforeHash===imageHash());
  await page.run("loadManagedEvent("+JSON.stringify(eventA)+",true)");
  await page.run("document.getElementById('eventPassportVariant').value='passport';document.getElementById('eventPassportVariant').dispatchEvent(new Event('change'));document.getElementById('eventPassportMode').value='template';document.getElementById('eventPassportMode').dispatchEvent(new Event('change'));document.getElementById('eventPassportCapacity').value=12;document.getElementById('eventPassportGenerate').click();document.getElementById('eventPassportMode').value='auto';document.getElementById('eventPassportMode').dispatchEvent(new Event('change'));document.getElementById('eventPassportSave').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&document.getElementById('eventImagesStatus').textContent.includes('Đã lưu')");
  check('template to auto save ACK excludes obsolete slots',ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images.passport.layout.slots===undefined);
  // A supported old backend must not be presented as having stored a v2 draft.
  apiFault='layout-missing';
  await page.run("refreshEventNow();stopRemoteSync()");await waitFor(page,'!remoteBusy');
  await page.run("selectManagedEvent("+JSON.stringify(eventB)+")");await waitFor(page,'managedEventSetup()?.event?.id==='+JSON.stringify(eventB));
  await page.run("selectManagedEvent("+JSON.stringify(eventA)+")");await waitFor(page,'managedEventSetup()?.event?.id==='+JSON.stringify(eventA));
  await page.run("loadManagedEvent("+JSON.stringify(eventA)+",true)");
  check('missing layout capability disables new controls',await page.run("document.getElementById('eventPassportLayoutControls').disabled&&document.getElementById('eventPassportGuide').textContent.includes('passport-layout-v2')"));
  apiFault=null;
  const teacherPage=await client();await teacherPage.run('loginAdmin('+JSON.stringify(supervisor)+','+JSON.stringify(teacher.authToken)+',3600)');
  check('teacher cannot edit layouts',await teacherPage.run("document.getElementById('eventImagesCard').hidden"));
  check('teacher direct API cannot change layouts',!cloud.post('SAVE_EVENT_IMAGE',{...teacher,eventId:eventA,kind:'passport',operation:'layout',expectedRevision:ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images.revision,layout:{mode:'auto'}}).success);
  fs.writeFileSync(path.join(root,'artifacts/layout16-browser-results.json'),JSON.stringify({checks,metrics,environment:'Chrome localhost, real frontend POST/302/JSON; fake Sheets/Drive/MailApp; HTTPS blocked',fixture:{students:395,classes:12,booths:[2,6,10,11,12,15,20]},limits:['Safari/iPhone and Android hardware not tested','No staging/production deployment']},null,2));
  console.log(JSON.stringify({checks:checks.length,passed:checks.length}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{for(const socket of tabs)socket.close();chrome?.kill();for(const item of servers)item.close();});
