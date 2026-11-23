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
const beforeDir=process.env.FS_STAMP14_BASELINE_DIR||"/private/tmp/fs-stamp-14-before";
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
  const fileVersions={},metrics=[];
  async function choose(kind,width,height,label,save=false){
    await page.run("document.getElementById('eventPassportVariant').value="+JSON.stringify(kind)+";document.getElementById('eventPassportVariant').dispatchEvent(new Event('change'))");
    await page.run(`(()=>{
      const canvas=document.createElement('canvas');canvas.width=${width};canvas.height=${height};const ctx=canvas.getContext('2d');
      const gradient=ctx.createLinearGradient(0,0,${width},${height});gradient.addColorStop(0,'#051b62');gradient.addColorStop(.6,'#126c9b');gradient.addColorStop(1,'#ad398f');ctx.fillStyle=gradient;ctx.fillRect(0,0,${width},${height});
      ctx.strokeStyle='#60d6fd55';ctx.lineWidth=2;for(let i=0;i<20;i++){ctx.beginPath();ctx.moveTo(i*120,0);ctx.lineTo(i*120-500,${height});ctx.stroke();}
      ctx.fillStyle='#ffffff';ctx.font='bold ${width<1000?48:56}px sans-serif';ctx.fillText(${JSON.stringify(label)},${width*.06},${height*.09});
      ctx.font='${width<1000?22:24}px sans-serif';ctx.fillText('ARTWORK THU NGHIEM - KHONG CO THONG TIN CA NHAN',${width*.06},${height*.14});
      const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
      const data=new DataTransfer();data.items.add(new File([bytes],'artwork-test.png',{type:'image/png'}));
      const input=document.getElementById('eventPassportFile');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor(page,"document.getElementById('eventImagesStatus').textContent.includes('sẵn sàng')");
    if(save){await page.run("document.getElementById('eventPassportSave').click()");await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&document.getElementById('eventImagesStatus').textContent.includes('Đã lưu')");}
    return await page.run("document.getElementById('eventPassportImagePreview').src");
  }
  const desktopDraft=await choose('passport',1200,700,'DESKTOP - LOGO THU NGHIEM');
  const writesBefore=calls.filter(action=>action==='SAVE_EVENT_IMAGE').length;
  const mobileDraft=await choose('passportMobile',900,1500,'MOBILE - LOGO THU');
  check('choosing both images does not write before save',calls.filter(action=>action==='SAVE_EVENT_IMAGE').length===writesBefore);
  await page.run("document.getElementById('eventPassportPreviewDesktop').click()");
  check('desktop unsaved preview retained while editing Mobile',await page.run("document.getElementById('eventPassportImagePreview').src==="+JSON.stringify(desktopDraft)));
  await page.run("document.getElementById('eventPassportPreviewMobile').click()");
  check('mobile unsaved preview uses its own portrait image',await page.run("document.getElementById('eventPassportImagePreview').src==="+JSON.stringify(mobileDraft)));
  await page.run("document.getElementById('eventPassportExpand').click()");
  check('expanded Mobile preview includes all configured circles',await page.run("document.getElementById('eventImageViewer').open&&document.getElementById('eventImageViewerCanvas').dataset.previewMode==='mobile'&&document.getElementById('eventImageViewerMarks').children.length===11"));
  check('BTC Mobile preview uses blank compact rings',await page.run("[...document.querySelectorAll('#eventImageViewerMarks span')].every(n=>!n.children.length&&!n.textContent&&n.getBoundingClientRect().width<=90)"));
  fs.writeFileSync(path.join(root,'artifacts/stamp14-preview-mobile.png'),Buffer.from((await page.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportPreviewDesktop').click();document.getElementById('eventPassportExpand').click()");
  check('BTC Desktop preview uses blank compact rings',await page.run("document.getElementById('eventImageViewerCanvas').dataset.previewMode==='desktop'&&[...document.querySelectorAll('#eventImageViewerMarks span')].every(n=>!n.children.length&&!n.textContent&&n.getBoundingClientRect().width<=100)"));
  await page.run("document.getElementById('eventImageViewerClose').click();document.getElementById('eventPassportPreviewMobile').click();document.getElementById('eventPassportSave').click()");
  await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&!!managedEventSetup().event.images.passportMobile?.version");
  fileVersions.mobile=await page.run("managedEventSetup().event.images.passportMobile.version");
  await page.run("document.getElementById('eventPassportVariant').value='passport';document.getElementById('eventPassportVariant').dispatchEvent(new Event('change'))");
  check('saving Mobile does not discard the Desktop draft',await page.run("!managedEventSetup().event.images.passport?.version&&!document.getElementById('eventPassportImagePreview').hidden"));
  await page.run("document.getElementById('eventPassportSave').click()");await waitFor(page,"!document.getElementById('eventImagesSelect').disabled&&!!managedEventSetup().event.images.passport?.version");
  fileVersions.desktop=await page.run("managedEventSetup().event.images.passport.version");
  check('saving Desktop preserves the Mobile version',await page.run("managedEventSetup().event.images.passportMobile.version==="+JSON.stringify(fileVersions.mobile)));
  const studentPage=await client();
  await studentPage.run("document.getElementById('studentCodeInput').value="+JSON.stringify(fixtureStudent.code)+";document.getElementById('studentAccessInput').value="+JSON.stringify(fixtureStudent.accessCode)+";document.getElementById('studentLoginButton').click()");
  await waitFor(studentPage,"currentUser?.role==='student'");
  await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");
  await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  check('waiting entries never create completion stamps',await studentPage.run("document.querySelectorAll('#studentPassDialog .is-complete').length===0"));
  const queueId=eventA+'::robotics::'+profiles[0].code;
  const beforeInfo=calls.length;
  await studentPage.run("(()=>{const b=document.querySelector('[data-booth-id=robotics] button');b.focus();b.click()})()");
  check('blank seal selection before backend ACK does not create a stamp',calls.length===beforeInfo&&await studentPage.run("!document.getElementById('studentPassStampDetails').hidden&&document.getElementById('studentPassStampTime').hidden&&document.querySelectorAll('#studentPassDialog .is-complete').length===0"));
  ok(cloud.post('TEACHER_COMPLETE',{...teacher,eventId:eventA,boothId:'robotics',ids:[queueId]}));
  await studentPage.run('refreshEventNow()');await waitFor(studentPage,"document.querySelectorAll('#studentPassDialog .is-complete').length===1");
  check('only official completion adds one stamp',await studentPage.run("document.querySelector('#studentPassDialog .is-complete').closest('[data-booth-id]').dataset.boothId==='robotics'"));
  check('backend confirmation refreshes selected details and preserves keyboard focus',await studentPage.run("document.activeElement.matches('[data-booth-id=robotics] button.is-complete')&&!document.getElementById('studentPassStampTime').hidden&&!!document.getElementById('studentPassStampTime').dateTime"));
  await studentPage.run("document.getElementById('studentPassStampDetailsClose').click()");
  const originalPassRows=JSON.stringify(cloud.sheets.get('WorkflowState').rows.filter(r=>r[0]!=='config'));
  // Capture the old layout against the same fake image, profile and backend state.
  if(baselineAvailable){
    const old=await client(app+'/before/index.html');
    const restoreSession=await studentPage.run("sessionStorage.getItem(STUDENT_SESSION_KEY)");
    await old.run("sessionStorage.setItem(STUDENT_SESSION_KEY,"+JSON.stringify(restoreSession)+");restoreAppSession()");
    await waitFor(old,"currentUser?.role==='student'");await old.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");
    await waitFor(old,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
    for(const width of [390,1280]){await old.cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<700});await delay(100);fs.writeFileSync(path.join(root,'artifacts/stamp14-before-'+width+'.png'),Buffer.from((await old.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));}
    await old.run('stopRemoteSync()');
  }
  const allBooths=Array.from({length:20},(_,i)=>i===0?{...originalBooths[0],name:'Robotics và công nghệ tự động'}:{id:'layout-'+i,name:i===1?'Trải nghiệm trí tuệ nhân tạo và thiết kế giải pháp sáng tạo cho thế giới tương lai':i===2?'TênRấtDàiKhôngCóKhoảngTrắngChoGianHàngThửNghiệm':'Gian trải nghiệm '+(i+1),location:'Phòng thử',pin:String(7000+i),icon:i%2?'brain':'box',color:'blue'});
  await studentPage.cdp("Page.bringToFront");
  await delay(100);await waitFor(studentPage,"!remoteBusy");await studentPage.run("stopRemoteSync()");
  for(const count of [2,6,10,15,20]){
    ok(cloud.post('SAVE_EVENT_BOOTHS',{...btc,eventId:eventA,booths:allBooths.slice(0,count)}));
    await studentPage.run('refreshEventNow();stopRemoteSync()');
    try{await waitFor(studentPage,'!remoteBusy&&document.querySelectorAll("#studentPassBooths > li").length==='+count);}catch(error){console.error(JSON.stringify({stage:'layout-count',count,state:await studentPage.run("({role:currentUser?.role,remoteBusy,booths:BOOTHS.length,dom:document.getElementById('studentPassBooths').children.length,dialog:document.getElementById('studentPassDialog').open,activePanel:document.getElementById('studentApp').classList.contains('hidden'),badge:document.getElementById('remoteSyncBadge').textContent})")}));throw error;}
    for(const width of [320,375,390,430,1280]){
      await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<700});
      await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')&&Math.abs(document.getElementById('studentPassArtwork').clientWidth/document.getElementById('studentPassArtwork').clientHeight-"+(width<768?900/1500:1200/700)+")<.01");await delay(80);
      const m=await studentPage.run(`(()=>{
        const d=document.getElementById('studentPassDialog'),body=document.querySelector('.student-pass-body'),a=document.getElementById('studentPassArtwork'),c=document.getElementById('studentPassCanvas'),p=document.querySelector('.student-pass-profile'),close=document.getElementById('studentPassClose');
        body.scrollTop=0;
        const r=n=>{const x=n.getBoundingClientRect();return {x:x.x,y:x.y,w:x.width,h:x.height,bottom:x.bottom,right:x.right}};
        const circles=[...document.querySelectorAll('#studentPassBooths .student-pass-stamp')];
        return {dialog:r(d),profile:r(p),canvas:r(c),art:r(a),close:r(close),overflow:Math.max(d.scrollWidth-d.clientWidth,body.scrollWidth-body.clientWidth),innerScroll:body.scrollHeight>body.clientHeight,
          circlesRound:circles.every(n=>Math.abs(n.getBoundingClientRect().width-n.getBoundingClientRect().height)<1),circleContentFits:circles.every(n=>n.scrollHeight<=n.clientHeight+2&&n.scrollWidth<=n.clientWidth+2),
          noCards:[...document.querySelectorAll('#studentPassBooths >li')].every(n=>getComputedStyle(n).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(n).boxShadow==='none'),
          completed:document.querySelectorAll('#studentPassDialog .is-complete').length,
          ratio:getComputedStyle(a).aspectRatio,background:getComputedStyle(a).backgroundSize,infoOutside:!c.contains(p),dialogBackground:getComputedStyle(d).backgroundImage};
      })()`);
      metrics.push({count,width,...m});
      check('dialog fits and no horizontal overflow '+count+'/'+width,m.dialog.x>=-1&&m.dialog.right<=width+1&&m.dialog.y>=-1&&m.dialog.bottom<=901&&m.overflow<=1);
      check('round stamps, readable content, no rectangular card '+count+'/'+width,m.circlesRound&&m.circleContentFits&&m.noCards);
      check('profile does not overlap artwork '+count+'/'+width,m.infoOutside&&m.profile.bottom<=m.canvas.y+1&&m.dialogBackground==='none');
      const expectedRatio=width<768?900/1500:1200/700;
      check('full uncropped image correct device ratio '+count+'/'+width,Math.abs(m.art.w/m.art.h-expectedRatio)<.01&&m.background==='contain');
      check('one official stamp preserved '+count+'/'+width,m.completed===1);
      const seal=await studentPage.run("(()=>{const seals=[...document.querySelectorAll('#studentPassBooths .student-pass-stamp')],done=seals.find(n=>n.classList.contains('is-complete'));return {sizes:seals.map(n=>n.getBoundingClientRect().width),text:done.textContent,children:done.children.length,icons:done.querySelectorAll('[data-lucide]').length,empty:seals.filter(n=>!n.classList.contains('is-complete')).every(n=>n.children.length===0&&n.textContent===''),double:seals.every(n=>getComputedStyle(n,'::before').borderRadius==='50%'),dash:seals.filter(n=>!n.classList.contains('is-complete')).every(n=>getComputedStyle(n).borderTopStyle==='dashed')}})()");
      metrics[metrics.length-1].stampDiameters=seal.sizes;
      check('compact stamp diameter '+count+'/'+width,seal.sizes.every(size=>size>=(width<768?70:80)&&size<=(width<768?90:100)));
      check('completed stamp contains only configured icon and exact label '+count+'/'+width,seal.text==='HOÀN THÀNH'&&seal.children===2&&seal.icons===1);
      check('unfinished rings have no visible content; double borders '+count+'/'+width,seal.empty&&seal.double&&seal.dash);
      check('label stays clear of circular borders '+count+'/'+width,await studentPage.run("(()=>{const b=document.querySelector('#studentPassBooths button.is-complete'),s=b.querySelector('.student-pass-state');return s.getBoundingClientRect().width<=b.getBoundingClientRect().width*"+(width<768?.78:.84)+"})()"));
      await studentPage.run("document.querySelector('.student-pass-body').scrollTop=99999");await delay(20);
      const close=await studentPage.run("(()=>{const r=document.getElementById('studentPassClose').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom}})()");
      check('close stays visible after internal scroll '+count+'/'+width,close.y>=0&&close.bottom<=900&&close.w>=44&&close.h>=44);
      const last=await studentPage.run("(()=>{const n=document.querySelector('#studentPassBooths > li:last-child .student-pass-stamp'),r=n.getBoundingClientRect(),b=document.querySelector('.student-pass-body').getBoundingClientRect();return {y:r.y,bottom:r.bottom,bodyY:b.y,bodyBottom:b.bottom}})()");
      check('last stamp reachable by internal scroll '+count+'/'+width,last.y>=last.bodyY-1&&last.bottom<=last.bodyBottom+1);
      await studentPage.run("document.querySelector('.student-pass-body').scrollTop=0");
      if(count===6||count===20)fs.writeFileSync(path.join(root,'artifacts/stamp14-'+count+'-'+width+'.png'),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
  }
  await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await studentPage.cdp("Page.bringToFront");await delay(80);await waitFor(studentPage,"!remoteBusy");await studentPage.run("stopRemoteSync()");
  const callsBeforeSelection=calls.length;
  await studentPage.run("document.querySelector('#studentPassBooths button:not(.is-complete)').click()");
  await waitFor(studentPage,"!document.getElementById('studentPassStampDetails').hidden");
  check('selecting blank ring opens separate name without completing',calls.length===callsBeforeSelection&&await studentPage.run("(()=>{const p=document.getElementById('studentPassStampDetails'),a=document.getElementById('studentPassCanvas');return !a.contains(p)&&!!document.getElementById('studentPassStampName').textContent&&document.getElementById('studentPassStampTime').hidden&&document.querySelectorAll('#studentPassDialog .is-complete').length===1})()"));
  await studentPage.run("document.querySelector('#studentPassBooths button.is-complete').click()");
  check('completed detail shows name and time outside artwork',await studentPage.run("(()=>{const p=document.getElementById('studentPassStampDetails'),d=document.getElementById('studentPassStampTime');return !p.hidden&&document.getElementById('studentPassStampName').textContent==='Robotics và công nghệ tự động'&&!d.hidden&&!!d.dateTime&&p.getBoundingClientRect().bottom<=document.querySelector('.student-pass-body').getBoundingClientRect().top+1})()"));
  fs.writeFileSync(path.join(root,'artifacts/stamp14-detail-mobile.png'),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await studentPage.run("document.getElementById('studentPassStampDetailsClose').click()");
  check('closing detail restores focus to selected seal',await studentPage.run("document.getElementById('studentPassStampDetails').hidden&&document.activeElement.matches('#studentPassBooths button.is-complete')"));
  await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await waitFor(studentPage,"!document.getElementById('studentPassStampDetails').hidden");
  check('keyboard Enter selects a read-only seal',calls.length===callsBeforeSelection&&await studentPage.run("document.querySelectorAll('#studentPassDialog .is-complete').length===1"));
  await studentPage.run("document.getElementById('studentPassStampDetailsClose').click()");
  check('layout and images never alter workflow rows',JSON.stringify(cloud.sheets.get('WorkflowState').rows.filter(r=>r[0]!=='config'))===originalPassRows);
  ok(cloud.post('SAVE_EVENT_BOOTHS',{...btc,eventId:eventA,booths:allBooths.slice(0,2)}));
  const layoutImages=ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images;
  ok(cloud.post('SAVE_EVENT_IMAGE',{...btc,eventId:eventA,kind:'passport',operation:'layout',expectedRevision:layoutImages.revision,layout:{mode:'template',capacity:2,slots:[{boothId:allBooths[0].id,x:28,y:55,size:26},{boothId:allBooths[1].id,x:72,y:55,size:26}]}}));
  await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,"!remoteBusy&&document.getElementById('studentPassBooths').classList.contains('has-template')");
  check('valid desktop template keeps compact positions without horizontal panning',await studentPage.run("document.getElementById('studentPassCanvas').scrollWidth===document.getElementById('studentPassCanvas').clientWidth&&[...document.querySelectorAll('#studentPassBooths button')].every(n=>Math.abs(n.getBoundingClientRect().width-96)<1)&&document.querySelectorAll('#studentPassDialog .is-complete').length===1"));
  fs.writeFileSync(path.join(root,'artifacts/stamp14-template-1280.png'),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  ok(cloud.post('SAVE_EVENT_BOOTHS',{...btc,eventId:eventA,booths:allBooths}));
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,'!remoteBusy');
  check('new booths missing template positions fall back to all 20 readable circles',await studentPage.run("!document.getElementById('studentPassBooths').classList.contains('has-template')&&document.getElementById('studentPassBooths').children.length===20"));
  const currentImages=ok(cloud.post('GET_EVENT_SETUP',{...btc,eventId:eventA})).event.images;
  ok(cloud.post('SAVE_EVENT_IMAGE',{...btc,eventId:eventA,kind:'passportMobile',operation:'default',expectedRevision:currentImages.revision}));
  await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,"!remoteBusy&&document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  check('no Mobile image falls back to full Desktop image',await studentPage.run("(()=>{const r=document.getElementById('studentPassArtwork').getBoundingClientRect();return Math.abs(r.width/r.height-1200/700)<.01&&document.querySelectorAll('#studentPassDialog .is-complete').length===1})()"));
  fs.writeFileSync(path.join(root,'artifacts/stamp14-mobile-desktop-fallback.png'),Buffer.from((await studentPage.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await studentPage.run('stopRemoteSync()');
  await page.run('loadManagedEvent('+JSON.stringify(eventA)+',true)');await waitFor(page,'!managedEventSetup().event.images.passportMobile?.version');
  await page.run("document.getElementById('eventPassportVariant').value='passportMobile';document.getElementById('eventPassportVariant').dispatchEvent(new Event('change'));document.getElementById('eventPassportRestore').click()");
  await waitFor(page,'!document.getElementById("eventImagesSelect").disabled&&!!managedEventSetup().event.images.passportMobile?.version');
  check('Mobile restore keeps Desktop and official stamp data',await page.run('managedEventSetup().event.images.passport.version==='+JSON.stringify(fileVersions.desktop))&&JSON.stringify(cloud.sheets.get('WorkflowState').rows.filter(r=>r[0]!=='config'))===originalPassRows);
  await studentPage.run('refreshEventNow();stopRemoteSync()');await waitFor(studentPage,'!remoteBusy');
  await studentPage.run("document.getElementById('studentPassClose').click();window.qaPassReload=true");await studentPage.cdp('Page.reload');
  await waitFor(studentPage,"!window.qaPassReload&&document.readyState==='complete'&&currentUser?.role==='student'");
  await studentPage.run("openStudentEvent(activeEvent().id);stopRemoteSync();document.getElementById('studentPassButton').click()");await waitFor(studentPage,"document.getElementById('studentPassDialog').classList.contains('has-artwork')");
  check('reload restores responsive image and official progress',await studentPage.run("document.querySelectorAll('#studentPassDialog .is-complete').length===1&&document.querySelectorAll('#studentPassBooths >li').length===20"));
  await studentPage.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-reduced-transparency',value:'reduce'}]});
  check('reduced motion keeps stamps static',await studentPage.run("getComputedStyle(document.querySelector('#studentPassDialog .is-complete')).animationName==='none'"));
  for(const [width,height] of [[320,568],[375,667]]){
    await studentPage.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    const compact=await studentPage.run("(()=>{const d=document.getElementById('studentPassDialog').getBoundingClientRect(),c=document.getElementById('studentPassClose').getBoundingClientRect(),b=document.querySelector('.student-pass-body');return {bottom:d.bottom,closeBottom:c.bottom,scroll:b.scrollHeight>b.clientHeight}})()");
    check('compact phone modal and close fit '+width+'x'+height,compact.bottom<=height+1&&compact.closeBottom<=height&&compact.scroll);
  }
  await studentPage.run("document.getElementById('studentPassClose').focus()");
  await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await waitFor(studentPage,"document.activeElement.classList.contains('student-pass-body')");
  check('keyboard Tab reaches the scrollable passport content',await studentPage.run("document.activeElement.classList.contains('student-pass-body')"));
  await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'PageDown',code:'PageDown',windowsVirtualKeyCode:34});
  await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'PageDown',code:'PageDown',windowsVirtualKeyCode:34});
  await waitFor(studentPage,"document.querySelector('.student-pass-body').scrollTop>0");
  check('keyboard PageDown scrolls inside the modal',await studentPage.run("document.querySelector('.student-pass-body').scrollTop>0"));
  await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await studentPage.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor(studentPage,"!document.getElementById('studentPassDialog').open&&document.activeElement.id==='studentPassButton'");
  check('Escape closes passport and restores keyboard focus',await studentPage.run("document.activeElement.id==='studentPassButton'"));
  apiFault='variants-missing';await page.run('loadManagedEvent('+JSON.stringify(eventA)+',true)');
  await waitFor(page,"!managedEventSetup().event.images.passportVariantsVersion");
  check('old backend disables Mobile option and explains update; Desktop remains usable',await page.run("document.querySelector('#eventPassportVariant option[value=passportMobile]').disabled&&!document.querySelector('#eventPassportVariant option[value=passport]').disabled&&document.getElementById('eventPassportVariant').value==='passport'&&document.getElementById('eventPassportVariantStatus').textContent.includes('passport-responsive-v1')"));
  const oldWrites=calls.filter(a=>a==='SAVE_EVENT_IMAGE').length;
  await page.run("document.getElementById('eventPassportVariant').value='passportMobile';document.getElementById('eventPassportVariant').dispatchEvent(new Event('change'))");
  check('forcing Mobile selection on old backend sends no write',calls.filter(a=>a==='SAVE_EVENT_IMAGE').length===oldWrites&&await page.run("document.getElementById('eventPassportVariant').value==='passport'"));
  apiFault=null;
  const stats={checks,metrics,baselineScreenshots:baselineAvailable,fixture:{students:395,classes:12,counts:[2,6,10,15,20]},externalServices:'BLOCKED; all HTTPS blocked and Drive/Sheets/MailApp mocked'};
  fs.writeFileSync(path.join(root,'artifacts/stamp14-browser-results.json'),JSON.stringify(stats,null,2));
  console.log(JSON.stringify({checks:checks.length,passed:checks.length}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{for(const socket of tabs)socket.close();chrome?.kill();for(const item of servers)item.close();});
