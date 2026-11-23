/* Event configuration screens. Backend grants and acknowledgements are authoritative. */
const eventAdminState = {deleteState:null,deleteRead:null,deleteError:null,deleteEpoch:0,user:null, tab:"events", eventId:"", cache:new Map(), pending:new Map(),
  yearChoices:new Map(), eventDrafts:new Map(), boothDrafts:new Map(), staffDrafts:new Map(), openBooths:new Map(), renderedBoothEvent:"", eventKey:"", boothKey:"", assignmentKey:"", rosterLoadedAt:0};
const EVENT_ICON_LABELS = {bot:"Robot", "flask-conical":"Thí nghiệm", cpu:"Vi mạch", box:"Khối 3D",
  "heart-handshake":"Văn hóa", leaf:"Môi trường", sparkles:"Sáng tạo", brain:"Trí tuệ nhân tạo",
  microscope:"Kính hiển vi", atom:"Khoa học", rocket:"Tên lửa", palette:"Mỹ thuật", music:"Âm nhạc",
  "circuit-board":"Điện tử", globe:"Thế giới", telescope:"Thiên văn"};

function resetEventAdministration(){
  eventAdminState.user=null;eventAdminState.eventId="";eventAdminState.tab="events";
  invalidateEventDeleteState();
  for(const key of ["cache","pending","yearChoices","eventDrafts","boothDrafts","staffDrafts","openBooths"])eventAdminState[key].clear();
  eventAdminState.renderedBoothEvent="";
  eventAdminState.eventKey="";eventAdminState.boothKey="";eventAdminState.assignmentKey="";eventAdminState.rosterLoadedAt=0;
  $("managedEventStatus").textContent="";$("staffTeacherName").value="";$("staffEmail").value="";
  $("staffBooth").replaceChildren();$("staffTeacher").replaceChildren();$("managedEventName").value="";
  $("managedEventDate").value="";$("managedEventDescription").value="";
}
function managedEventId(){return eventAdminState.eventId||activeEvent().id;}
function managedEventSetup(){return eventAdminState.cache.get(managedEventId());}
function managedBooths(){return managedEventSetup()?.booths||(managedEventId()===activeEvent().id?BOOTHS:[]);}
function managedYearContext(){return managedEventSetup()||rosterDesk;}
function noteRosterLoaded(){eventAdminState.rosterLoadedAt=Date.now();}

function showConfigSection(name){
  const eventsAllowed=hasPermission("events")||hasPermission("assignments");
  const studentsAllowed=hasPermission("roster")||hasPermission("accounts");
  if((name==="events"&&!eventsAllowed)||(name==="students"&&!studentsAllowed))return;
  eventAdminState.tab=name;
  $("configEventsView").hidden=name!=="events";$("configStudentsView").hidden=name!=="students";
  for(const [id,value,allowed] of [["configEventsTab","events",eventsAllowed],["configStudentsTab","students",studentsAllowed]]){
    $(id).hidden=!allowed;$(id).setAttribute("aria-selected",String(name===value));
    $(id).tabIndex=name===value?0:-1;
  }
  if(name==="students"&&(!rosterDesk||Date.now()-eventAdminState.rosterLoadedAt>30000))void loadRoster(rosterDesk?.schoolYear,rosterDesk?.eventId);
  if(name==="events")renderEventAdministration();
}

function selectManagedEvent(id){
  if(!EVENTS.some(event=>event.id===id)||!(hasPermission("events")||hasPermission("assignments")))return;
  eventAdminState.staffDrafts.set(managedEventId(),{email:$("staffEmail").value,name:$("staffTeacherName").value,
    editing:$("staffAssignmentForm").dataset.editing,ids:[...$("staffBooth").querySelectorAll("input:checked")].map(input=>input.value)});
  const draft=eventAdminState.staffDrafts.get(id);
  eventAdminState.openBooths.set(managedEventId(),new Set([...$("adminBoothConfig").querySelectorAll("details[open]")].map(node=>node.dataset.boothId)));
  $("staffEmail").value=draft?.email||"";$("staffTeacherName").value=draft?.name||"";
  delete $("staffAssignmentForm").dataset.contextEvent;
  if(draft?.editing)$("staffAssignmentForm").dataset.editing=draft.editing;else delete $("staffAssignmentForm").dataset.editing;
  $("staffAssignmentSubmit").textContent=draft?.editing?"Cập nhật phân công":"Cấp phân công";
  $("staffBooth").replaceChildren();$("staffAssignmentList").replaceChildren();
  eventAdminState.eventId=id;eventAdminState.eventKey="";eventAdminState.boothKey="";eventAdminState.assignmentKey="";
  renderEventAdministration();
}

function loadManagedEvent(id,force=false){
  if(!(hasPermission("events")||hasPermission("assignments"))||!id)return Promise.resolve();
  if(!force&&eventAdminState.pending.has(id))return eventAdminState.pending.get(id);
  if(!force&&eventAdminState.cache.has(id))return Promise.resolve(eventAdminState.cache.get(id));
  const user=currentUser;
  $("managedEventStatus").textContent="Đang tải cấu hình sự kiện…";
  const promise=(async()=>{
    try{
      const result=await eventCall("GET_EVENT_SETUP",{eventId:id});
      if(result.adminSetupVersion!=="event-admin-setup-v2"||result.eventId!==id||result.event?.id!==id||
        (hasPermission("events")&&result.imageApiVersion!=="event-images-v3")||
        !Array.isArray(result.booths)||!Array.isArray(result.years)||!Array.isArray(result.assignments)||!Array.isArray(result.teachers)){
        throw eventApiVersionError("GET_EVENT_SETUP","chưa hỗ trợ cấu hình riêng theo sự kiện. BTC cần cập nhật backend.");
      }
      if(user!==currentUser||eventAdminState.user!==user||eventAdminState.pending.get(id)!==promise)return;
      result.loadedAt=Date.now();eventAdminState.cache.set(id,result);
      acknowledgeManagedYears(result.years,result.schoolYearsRevision);
      if(managedEventId()===id){
        $("managedEventStatus").textContent="";
        renderEventAdministration();
      }
      return result;
    }catch(error){
      if(user===currentUser&&managedEventId()===id){
        $("managedEventStatus").textContent=error.code==="METHOD_NOT_ALLOWED"?"Apps Script /exec chưa có GET_EVENT_SETUP. BTC cần cập nhật đầy đủ backend.":error.message;
      }
    }finally{if(eventAdminState.pending.get(id)===promise)eventAdminState.pending.delete(id);}
  })();
  eventAdminState.pending.set(id,promise);return promise;
}

function renderEventAdministration(selectedId){
  if(currentUser?.role!=="admin")return;
  if(eventAdminState.user!==currentUser){resetEventAdministration();eventAdminState.user=currentUser;}
  const eventsAllowed=hasPermission("events")||hasPermission("assignments");
  if(selectedId&&EVENTS.some(event=>event.id===selectedId))eventAdminState.eventId=selectedId;
  if(!EVENTS.some(event=>event.id===managedEventId()))eventAdminState.eventId=activeEvent().id;
  const id=managedEventId(),setup=eventAdminState.cache.get(id),event=setup?.event||EVENTS.find(item=>item.id===id);
  const studentsAllowed=hasPermission("roster")||hasPermission("accounts");
  if(!eventsAllowed)eventAdminState.tab="students";
  if(!studentsAllowed)eventAdminState.tab="events";
  $("configEventsTab").hidden=!eventsAllowed;$("configStudentsTab").hidden=!studentsAllowed;
  $("configEventsView").hidden=eventAdminState.tab!=="events";$("configStudentsView").hidden=eventAdminState.tab!=="students";
  for(const element of ["configContextStatus","managedEventStatus","managedEventReload"])$(element).hidden=eventAdminState.tab!=="events";
  for(const [button,tab] of [["configEventsTab","events"],["configStudentsTab","students"]]){
    $(button).setAttribute("aria-selected",String(eventAdminState.tab===tab));$(button).tabIndex=eventAdminState.tab===tab?0:-1;
  }
  $("studentRosterCard").hidden=!studentsAllowed;
  if(eventAdminState.tab==="students"){
    if(!rosterDesk)void loadRoster();return;
  }
  if(!eventsAllowed)return;
  $("eventConfigCard").hidden=!hasPermission("events");$("boothConfigCard").hidden=!hasPermission("events");
  $("staffAssignmentCard").hidden=!hasPermission("assignments");
  $("configContextStatus").textContent="Đang cấu hình: "+(event?.name||"Chưa chọn")+" · Sự kiện hoạt động: "+activeEvent().name;
  const readonly=event?.archived||setup?.years?.some(year=>year.id===event?.schoolYear&&year.status==="closed");
  $("managedBoothEditor").disabled=!setup||readonly;
  $("managedEventEditor").disabled=!setup||readonly;
  $("staffAssignmentFields").disabled=!setup||readonly;
  if(hasPermission("events")){
    renderManagedEventCards(id);renderManagedBoothCards();
  }
  if(hasPermission("assignments")){
    setDeskOptions("staffEvent",EVENTS.map(item=>({value:item.id,label:item.name+(item.archived?" · Lưu trữ":"")})),id);
    if(setup)renderManagedAssignments(setup);
  }
  const imageEvents=EVENTS.map(item=>item.id===id&&setup?{...item,images:setup.event.images}:item);
  eventImages.syncAdmin(imageEvents,managedBooths(),hasPermission("events"),id,!!setup&&!readonly);
  $("eventImageStorageStatus").textContent=!setup?"":!setup.imageStorage?.folderConfigured?
    "Chưa cấu hình FS_EVENT_IMAGE_FOLDER_ID trong Script Properties. Chọn thư mục Drive riêng chỉ chứa artwork.":
    !setup.imageStorage.publicDeliveryEnabled?"Đã có Folder ID. API ảnh học sinh chưa bật: BTC cần kiểm tra FS_EVENT_PUBLIC_IMAGES; không cần công khai thư mục Drive.":
    "Đã có cấu hình lưu và phân phối ảnh phiếu. Ảnh hiển thị sau khi backend xác nhận lưu thành công.";
  if(!setup)void loadManagedEvent(id);
  renderIcons($("adminConfigPanel"));
}

function eventDeleteContextKey(){
  return JSON.stringify([activeEvent().id,EVENTS.map(event=>[event.id,event.eventRevision,event.archived]),
    (appState.eventConfig.deletedEvents||[]).map(event=>[event.id,event.eventRevision])]);
}
function invalidateEventDeleteState(){
  eventAdminState.deleteState=null;eventAdminState.deleteRead=null;eventAdminState.deleteError=null;eventAdminState.deleteEpoch++;
}
function currentEventDeleteState(){
  const state=eventAdminState.deleteState;
  return state?.user===currentUser&&state.key===eventDeleteContextKey()?state:null;
}
function eventDeleteEligibility(event){
  if(!hasPermission("events"))return {canDelete:false,reasonCode:"FORBIDDEN",reason:"Chỉ BTC có quyền events được xóa sự kiện."};
  if(event.id===activeEvent().id)return {canDelete:false,reasonCode:"EVENT_ACTIVE",reason:"Vui lòng ngừng kích hoạt sự kiện trước khi xóa"};
  const row=currentEventDeleteState()?.events.find(item=>item.eventId===event.id);
  if(row)return row;
  const error=eventAdminState.deleteError;
  return {canDelete:false,reasonCode:error?.key===eventDeleteContextKey()?error.code:"CHECK_PENDING",
    reason:error?.key===eventDeleteContextKey()?error.message:"Đang kiểm tra quyền và dữ liệu phụ thuộc trên backend…"};
}
function loadEventDeleteState(force=false){
  if(!hasPermission("events"))return Promise.resolve();
  const user=currentUser,key=eventDeleteContextKey(),epoch=eventAdminState.deleteEpoch;
  if(eventAdminState.deleteRead?.user===user&&eventAdminState.deleteRead.key===key)return eventAdminState.deleteRead.promise;
  if(!force&&currentEventDeleteState())return Promise.resolve(currentEventDeleteState());
  if(!force&&eventAdminState.deleteError?.key===key)return Promise.resolve();
  const promise=(async()=>{
    try{
      const result=await eventCall("GET_EVENT_DELETE_STATE");
      const ids=new Set();
      if(result.eventDeleteVersion!=="event-delete-v1"||!Array.isArray(result.events)||result.events.some(row=>
        !row||typeof row.eventId!=="string"||!/^[a-z0-9][a-z0-9-]{0,119}$/.test(row.eventId)||ids.has(row.eventId)||!ids.add(row.eventId)||
        typeof row.name!=="string"||typeof row.eventRevision!=="string"||!row.eventRevision||typeof row.reason!=="string"||
        typeof row.active!=="boolean"||typeof row.deleted!=="boolean"||typeof row.canRestore!=="boolean"||
        !["READY","EVENT_ACTIVE","EVENT_HAS_DEPENDENCIES","EVENT_DELETED"].includes(row.reasonCode)||
        (row.reasonCode!=="READY"&&!row.reason)||row.active!==(row.eventId===result.activeEventId)||
        row.canDelete!==(!row.active&&!row.deleted&&row.reasonCode==="READY")||row.canRestore!==(row.deleted&&!row.active))||
        !EVENTS.every(event=>ids.has(event.id))){
        throw eventApiVersionError("GET_EVENT_DELETE_STATE","chưa trả đúng hợp đồng event-delete-v1. BTC cần cập nhật deployment.");
      }
      if(result.activeEventId!==activeEvent().id){const error=new Error("Sự kiện hoạt động đã thay đổi. Bấm Làm mới dữ liệu ở đầu trang trước khi xóa.");error.code="ACTIVE_EVENT_CHANGED";throw error;}
      if(user!==currentUser||key!==eventDeleteContextKey()||epoch!==eventAdminState.deleteEpoch)return;
      eventAdminState.deleteState={user,key,events:result.events,eventDeleteVersion:result.eventDeleteVersion};eventAdminState.deleteError=null;
      return eventAdminState.deleteState;
    }catch(error){
      if(user===currentUser&&key===eventDeleteContextKey()&&epoch===eventAdminState.deleteEpoch){
        if(error.code==="AUTH_REQUIRED"){clearCurrentSession();return;}
        eventAdminState.deleteState=null;
        eventAdminState.deleteError={key,code:error.code||"DELETE_CHECK_FAILED",message:error.code==="METHOD_NOT_ALLOWED"?
          "Apps Script /exec chưa hỗ trợ GET_EVENT_DELETE_STATE. BTC cần cập nhật deployment để xóa mềm.":error.message};
      }
    }finally{
      if(eventAdminState.deleteRead?.promise===promise)eventAdminState.deleteRead=null;
      if(user===currentUser&&epoch===eventAdminState.deleteEpoch&&activeAdminTab==="config"){
        renderManagedEventCards(managedEventId());renderIcons($("eventConfigCards"));
      }
    }
  })();
  eventAdminState.deleteRead={user,key,promise};return promise;
}
function diagnoseEventDelete(){
  return {deploymentSuffix:new URL(GOOGLE_SCRIPT_URL).pathname.split("/").at(-2)?.slice(-8),
    hasEventsPermission:hasPermission("events"),eventDeleteVersion:currentEventDeleteState()?.eventDeleteVersion||"",
    adminSetupVersion:managedEventSetup()?.adminSetupVersion||"",imageApiVersion:managedEventSetup()?.imageApiVersion||"",
    events:EVENTS.map(event=>{const state=eventDeleteEligibility(event);return {eventId:event.id,archived:event.archived,
      canDelete:state.canDelete,reasonCode:state.reasonCode,reason:state.reason};})};
}

function renderManagedEventCards(id){
  const event=EVENTS.find(item=>item.id===id),setup=managedEventSetup();
  const optionsKey=JSON.stringify(EVENTS.map(item=>[item.id,item.name,item.archived]));
  if($("activeEventSelect").dataset.optionsKey!==optionsKey){
    setDeskOptions("activeEventSelect",EVENTS.map(item=>({value:item.id,label:item.name+(item.archived?" · Lưu trữ":"")})),id);
    $("activeEventSelect").dataset.optionsKey=optionsKey;
  }
  $("activeEventSelect").value=id;
  renderConfigSchoolYears();
  const key=JSON.stringify([id,event?.name,event?.date,event?.description,event?.schoolYear]);
  if(eventAdminState.eventKey!==key){
    eventAdminState.eventKey=key;
    const draft=eventAdminState.eventDrafts.get(id)||event||{};
    $("managedEventName").value=draft.name||"";$("managedEventDate").value=draft.date||"";
    $("managedEventDescription").value=draft.description||"";
    $("managedEventYear").textContent=event?.schoolYear||"Chưa liên kết năm học";
  }
  const deleteState=currentEventDeleteState();
  const deleted=deleteState?deleteState.events.filter(event=>event.deleted).map(event=>({...event,id:event.eventId})):(appState.eventConfig.deletedEvents||[]);
  const statuses=EVENTS.map(event=>eventDeleteEligibility(event));
  const listKey=JSON.stringify([EVENTS,deleted,statuses,!!deleteState]);
  if($("eventConfigCards").dataset.listKey!==listKey){
    $("eventConfigCards").dataset.listKey=listKey;
    $("eventConfigCards").innerHTML=EVENTS.map((item,index)=>{
      const state=statuses[index],reasonId="delete-reason-"+item.id;
      return `<div class="managed-event-row has-delete-status"><button type="button" data-managed-event="${escapeHTML(item.id)}" aria-pressed="${item.id===id}">${icon("calendar-days")}<span>${escapeHTML(item.name)}<small>${escapeHTML(item.schoolYear||"Chưa liên kết năm học")} · ${item.archived?"Lưu trữ":item.id===activeEvent().id?"Đang hoạt động":"Chưa mở"}<br>ID: ${escapeHTML(item.id)}</small></span></button><span class="managed-event-actions">${!item.archived&&item.id!==activeEvent().id?`<button type="button" onclick="archiveManagedEvent('${escapeHTML(item.id)}')" aria-label="Lưu trữ ${escapeHTML(item.name)}">${icon("archive")}</button>`:""}<button type="button" class="event-delete-button" data-delete-event="${escapeHTML(item.id)}" onclick="deleteEvent('${escapeHTML(item.id)}')" ${state.canDelete?"":"disabled"} ${state.reason?`aria-describedby="${reasonId}" title="${escapeHTML(state.reason)}"`:""}>${icon("trash-2")}Xóa</button></span>${state.reason?`<p id="${reasonId}" class="event-delete-reason" role="status">${escapeHTML(state.reason)}</p>`:""}</div>`;
    }).join("")+
      (deleted.length?`<details class="managed-deleted-events"><summary>Sự kiện đã xóa (${deleted.length})</summary>${deleted.map(item=>`<div class="managed-event-row"><span>${escapeHTML(item.name)}<small>${escapeHTML(item.schoolYear)} · ID: ${escapeHTML(item.id)}</small></span><button type="button" ${!deleteState?.events.find(event=>event.eventId===item.id)?.canRestore?'disabled':''} onclick="manageEventRemoval('${escapeHTML(item.id)}','restore')">${icon("rotate-ccw")}Khôi phục</button></div>`).join("")}</details>`:"");
  }
  $("eventConfigCards").querySelectorAll("[data-managed-event]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.managedEvent===id)));
  if(hasPermission("events")&&!deleteState)void loadEventDeleteState();
}

function renderManagedBoothCards(){
  const booths=managedBooths(),id=managedEventId(),key=JSON.stringify([id,booths]);
  if(eventAdminState.boothKey===key)return;
  const focusedId=document.activeElement?.id;
  if(eventAdminState.renderedBoothEvent===id)eventAdminState.openBooths.set(id,new Set([...$("adminBoothConfig").querySelectorAll("details[open]")].map(node=>node.dataset.boothId)));
  const opened=eventAdminState.openBooths.get(id)||new Set();eventAdminState.renderedBoothEvent=id;
  eventAdminState.boothKey=key;
  $("adminBoothConfig").innerHTML=`<button type="button" onclick="addBooth()" class="managed-add-booth">${icon("plus")}Thêm gian hàng</button>`+booths.map(booth=>{
    const field=(prefix,label,max,value)=>`<label>${label}<input id="${prefix}-${escapeHTML(booth.id)}" maxlength="${max}" value="${escapeHTML(value||"")}"></label>`;
    return `<article class="managed-booth"><details data-booth-id="${escapeHTML(booth.id)}" ${opened.has(booth.id)?"open":""}><summary class="managed-booth-heading">${icon(booth.icon||"store")}<strong>${escapeHTML(booth.name)}</strong></summary>`+
      field("boothName","Tên gian hàng",80,booth.name)+field("boothLocation","Vị trí",100,booth.location)+field("boothTopic","Chủ đề",120,booth.topic)+field("boothPin","PIN (4 số)",4,booth.pin)+
      `<label>Biểu tượng gian hàng<select id="boothIcon-${escapeHTML(booth.id)}">${Object.entries(EVENT_ICON_LABELS).map(([name,label])=>`<option value="${name}" ${name===booth.icon?"selected":""}>${label}</option>`).join("")}</select></label><div class="managed-booth-actions"><button id="managedSaveBooth-${escapeHTML(booth.id)}" type="button" onclick="saveBoothSettings('${escapeHTML(booth.id)}')">${icon("save")}Lưu</button><button type="button" onclick="showStationQr('${escapeHTML(booth.id)}')">${icon("qr-code")}QR / In</button><button type="button" onclick="deleteBooth('${escapeHTML(booth.id)}')" aria-label="Xóa gian ${escapeHTML(booth.name)}">${icon("trash-2")}</button></div></details></article>`;
  }).join("");
  const drafts=eventAdminState.boothDrafts.get(id);
  if(drafts)for(const [control,value] of drafts){const node=document.getElementById(control);if(node)node.value=value;}
  renderIcons($("adminBoothConfig"));
  if(focusedId)document.getElementById(focusedId)?.focus({preventScroll:true});
}

function rememberManagedBoothDraft(event){
  const node=event.target;if(!node?.id)return;
  const id=managedEventId(),draft=eventAdminState.boothDrafts.get(id)||new Map();
  draft.set(node.id,node.value);eventAdminState.boothDrafts.set(id,draft);
}
function acknowledgeManagedBooths(change,request){
  const id=request.targetEventId||request.eventId;
  if(change.targetEventId!==undefined&&change.targetEventId!==id)return;
  const setup=eventAdminState.cache.get(id);
  if(setup){setup.booths=change.booths;setup.boothRevision=change.boothRevision||setup.boothRevision;}
  eventAdminState.boothKey="";
}
function acknowledgeManagedImages(id,images){
  const event=EVENTS.find(item=>item.id===id);if(event)event.images=images;
  const setup=eventAdminState.cache.get(id);if(setup)setup.event.images=images;
}
function acknowledgeManagedEventConfig(){
  for(const event of EVENTS){const setup=eventAdminState.cache.get(event.id);if(setup)setup.event={...event};}
  eventAdminState.eventKey="";
}

function renderManagedAssignments(setup){
  const key=JSON.stringify([setup.eventId,setup.booths,setup.assignments,setup.teachers]);
  if(eventAdminState.assignmentKey===key)return;eventAdminState.assignmentKey=key;
  const chosen=new Set($("staffAssignmentForm").dataset.contextEvent===setup.eventId?
    [...$("staffBooth").querySelectorAll("input:checked")].map(input=>input.value):eventAdminState.staffDrafts.get(setup.eventId)?.ids||[]);
  $("staffAssignmentForm").dataset.contextEvent=setup.eventId;
  $("staffBooth").replaceChildren(...setup.booths.map(booth=>{
    const label=document.createElement("label"),input=document.createElement("input"),text=document.createElement("span");
    input.type="checkbox";input.value=booth.id;input.checked=chosen.has(booth.id);text.textContent=booth.name;
    label.append(input,window.FSchoolUi.icon(booth.icon||"store","ui-icon-small"),text);return label;
  }));
  setDeskOptions("staffTeacher",(setup.teachers||[]).map(item=>({value:item.email,label:item.name?item.name+" · "+item.email:item.email})), $("staffEmail").value,"Nhập giáo viên mới");
  const rows=setup.assignments||[],names=new Map(setup.booths.map(booth=>[booth.id,booth.name]));
  $("staffAssignmentList").replaceChildren(...rows.map(row=>{
    const line=document.createElement("div"),label=document.createElement("div"),actions=document.createElement("div");
    const edit=document.createElement("button"),revoke=document.createElement("button"),remove=document.createElement("button");
    line.className="staff-assignment-row";line.dataset.boothId=row.boothId;line.dataset.email=row.email;
    label.textContent=(row.name||row.email)+" · "+row.email+" · "+setup.event.name+" · "+
      (names.get(row.boothId)||row.boothId)+" · "+(row.enabled?"Đang cấp quyền":"Đã thu hồi");
    const readonly=setup.event.archived||setup.years.some(year=>year.id===setup.event.schoolYear&&year.status==="closed");
    edit.type="button";edit.textContent="Sửa";edit.disabled=readonly;
    edit.addEventListener("click",()=>{
      $("staffTeacher").value=row.email;$("staffEmail").value=row.email;$("staffTeacherName").value=row.name||"";
      $("staffAssignmentForm").dataset.editing=row.email;$("staffAssignmentSubmit").textContent="Cập nhật phân công";
      $("staffBooth").querySelectorAll("input").forEach(input=>{input.checked=rows.some(item=>item.email===row.email&&item.enabled&&item.boothId===input.value)});
      $("staffEmail").focus();
    });
    revoke.type="button";revoke.textContent="Thu hồi";revoke.disabled=readonly||!row.enabled;
    revoke.addEventListener("click",()=>{if(confirm("Thu hồi quyền của "+row.email+" tại "+(names.get(row.boothId)||row.boothId)+" trong "+setup.event.name+"?"))void submitManagedAssignment(false,[row.boothId],row.email);});
    remove.type="button";remove.textContent="Xóa";remove.disabled=row.enabled;
    if(row.enabled)remove.title="Thu hồi phân công này trước khi xóa";
    remove.addEventListener("click",()=>void removeManagedAssignment(row,setup));
    actions.className="staff-assignment-actions";actions.append(edit,revoke,remove);line.append(label,actions);return line;
  }));
  if(!rows.length)$("staffAssignmentList").textContent="Chưa có phân công trong sự kiện này.";
}

async function archiveManagedEvent(id){
  if(!hasPermission("events")||id===activeEvent().id||!confirm("Lưu trữ sự kiện "+id+"? Dữ liệu nghiệp vụ được giữ nguyên."))return;
  await performEventAction("SAVE_EVENT_CONFIG",{managedEventId:id,config:{activeEventId:activeEvent().id,events:EVENTS.map(event=>event.id===id?{...event,archived:true}:event)}},"Đã lưu trữ sự kiện.");
}

async function manageEventRemoval(id,operation){
  if(!hasPermission("events")||rosterMutationBusy||mutationBusy)return;
  const user=currentUser;
  if(!currentEventDeleteState())await loadEventDeleteState();
  if(user!==currentUser||!hasPermission("events")||rosterMutationBusy||mutationBusy)return;
  const target=currentEventDeleteState()?.events.find(event=>event.eventId===id);
  const state=operation==="delete"?eventDeleteEligibility({id}):{canDelete:target?.canRestore,reason:target?.reason};
  if(!target||!state.canDelete){showToast(state.reason||"Chưa xác nhận được khả năng xóa/khôi phục. Nạp lại danh sách hoặc cập nhật backend.","triangle-alert");return;}
  if(!confirm((operation==="delete"?"Xóa mềm":"Khôi phục")+" sự kiện “"+target.name+"” · ID: "+id+" · "+(target.schoolYear||"Chưa liên kết năm")+"? Dữ liệu và file Drive được giữ nguyên."))return;
  let committed=false;
  await mutateRoster("MANAGE_EVENT",{eventId:id,operation,confirmed:true,expectedRevision:target.eventRevision},result=>{
    if(result.eventId!==id||!Array.isArray(result.config?.events))throw new Error("Chưa đối chiếu được kết quả. Nạp lại danh sách trước khi gửi lại.");
    committed=true;invalidateEventDeleteState();
    remoteViewRevision++;appliedViewRevision="";
    appState.eventConfig=result.config;applyEventConfiguration(result.config);
    eventAdminState.cache.delete(id);eventAdminState.pending.delete(id);
    if(operation==="delete"&&managedEventId()===id)eventAdminState.eventId=activeEvent().id;
    acknowledgeManagedEventConfig();renderEventAdministration();renderIcons();
    showToast(operation==="delete"?"Đã xóa mềm sự kiện. Có thể khôi phục trong Sự kiện đã xóa.":"Đã khôi phục sự kiện; chưa tự kích hoạt.","circle-check");
    void refreshEventNow();
  });
  if(!committed)await loadEventDeleteState(true);
}

async function removeManagedAssignment(row,setup){
  if(!hasPermission("assignments")||row.enabled||rosterMutationBusy)return;
  const booth=setup.booths.find(item=>item.id===row.boothId);
  if(!confirm("Xóa mềm phân công đã thu hồi của "+row.email+" tại "+(booth?.name||row.boothId)+" · "+setup.event.name+"? Các phân công khác và lịch sử xác nhận được giữ nguyên."))return;
  await mutateRoster("DELETE_EVENT_ASSIGNMENT",{eventId:setup.eventId,boothId:row.boothId,email:row.email,confirmed:true,
    expectedAssignmentRevision:setup.assignmentRevision},result=>{
    if(eventAdminState.cache.get(setup.eventId)!==setup)return;
    setup.assignments=result.assignments;setup.assignmentRevision=result.assignmentRevision;
    if(managedEventId()===setup.eventId){eventAdminState.assignmentKey="";renderManagedAssignments(setup);renderIcons();}
    showToast("Đã xóa mềm phân công đã thu hồi.","circle-check");
  });
}

async function submitManagedAssignment(enabled=true,selectedIds,email){
  const setup=managedEventSetup();if(!setup||rosterMutationBusy)return;
  const eventId=setup.eventId,ids=selectedIds||[...$("staffBooth").querySelectorAll("input:checked")].map(input=>input.value);
  if(!ids.length){showToast("Chọn ít nhất một gian hàng.","triangle-alert");return;}
  const address=email||$("staffEmail").value;
  const name=!email||email===$("staffEmail").value?$("staffTeacherName").value:setup.assignments.find(row=>row.email===email)?.name||"";
  await mutateRoster("SET_EVENT_ASSIGNMENT",{eventId,boothIds:ids,email:address,name,enabled,
    ...(enabled?{replace:$("staffAssignmentForm").dataset.editing===address}:{}),expectedAssignmentRevision:setup.assignmentRevision},result=>{
    if(eventAdminState.cache.get(eventId)!==setup)return;
    setup.assignments=result.assignments;setup.assignmentRevision=result.assignmentRevision;
    setup.teachers=[...new Map([...setup.teachers,...result.assignments.map(row=>({email:row.email,name:row.name||""}))].map(row=>[row.email,row])).values()];
    if(managedEventId()===eventId){
      delete $("staffAssignmentForm").dataset.editing;$("staffAssignmentSubmit").textContent="Cấp phân công";
      eventAdminState.assignmentKey="";renderManagedAssignments(setup);
    }
    showToast(enabled?"Đã cập nhật phân công.":"Đã thu hồi phân công.","check");
  });
}

function acknowledgeManagedYears(years,revision){
  if(!Array.isArray(years)||typeof revision!=="string")return;
  for(const setup of eventAdminState.cache.values()){setup.years=years;setup.schoolYearsRevision=revision;}
  if(rosterDesk){rosterDesk.years=years;rosterDesk.schoolYearsRevision=revision;}
}
function renderManagedActivationControls(){
  const event=EVENTS.find(item=>item.id===managedEventId()),setup=managedEventSetup(),yearId=$("configEventYear").value;
  const year=setup?.years?.find(item=>item.id===yearId),compatible=setup?.eventActivationVersion==="event-activation-v1"&&!!setup.schoolYearsRevision&&!!setup.event?.eventRevision;
  const available=hasPermission("events")&&compatible&&year&&["open","active"].includes(year.status)&&!mutationBusy;
  const linked=!!event?.schoolYear,alreadyActive=event?.id===activeEvent().id&&linked;
  $("managedEventActivate").disabled=!available||event?.archived||alreadyActive||year?.status!=="active";
  $("managedEventLink").disabled=!available||event?.archived||linked;
  $("managedEventReopen").hidden=!event?.archived;$("managedEventReopen").disabled=!available||!event?.archived;
  const label=alreadyActive?"Đang là sự kiện hoạt động":"Kích hoạt sự kiện";
  if($("managedEventActivate").dataset.activationKey!==label){
    $("managedEventActivate").dataset.activationKey=label;
    $("managedEventActivate").innerHTML=icon(alreadyActive?"circle-check":"zap")+label;
  }
  const activeYear=setup?.years?.find(item=>item.status==="active")?.id||"Chưa chọn";
  $("configYearStatus").textContent=!setup?"Đang tải cấu hình sự kiện và danh sách năm học…":!compatible?"Apps Script /exec cần hỗ trợ event-activation-v1. BTC cập nhật đủ backend trước khi liên kết/kích hoạt.":
    event?.archived?"Sự kiện đã lưu trữ. "+(!year?"Chọn năm học đã tạo và chưa đóng trước khi mở lại.":year.status==="closed"?"Năm học đã đóng; không thể mở lại hoặc kích hoạt tại đây.":"Mở lại có xác nhận trong tùy chọn bên dưới; không tự kích hoạt."):
    year?.status==="closed"?"Năm học đã đóng; không được liên kết hoặc kích hoạt.":!year?"Chọn năm học có trong Quản lý học sinh; năm học liên kết phải tồn tại và chưa đóng.":
    "Năm học đang hoạt động: "+activeYear+". "+(year&&year.status!=="active"?"Có thể lưu liên kết; kích hoạt năm học tại Quản lý học sinh trước khi mở sự kiện.":linked?"Sự kiện đã liên kết: "+event.schoolYear+".":"Chọn năm học đã tạo để liên kết và kích hoạt.");
}
async function configureManagedEvent(operation){
  if(!hasPermission("events")||mutationBusy)return false;
  const user=currentUser,id=managedEventId(),event=EVENTS.find(item=>item.id===id),setup=managedEventSetup(),schoolYearId=$("configEventYear").value;
  if(!event||setup?.eventActivationVersion!=="event-activation-v1"||!setup?.schoolYearsRevision){showToast("Cần cập nhật backend hỗ trợ event-activation-v1.","triangle-alert");return false;}
  const year=setup.years.find(item=>item.id===schoolYearId);
  if(!year||!["open","active"].includes(year.status)){showToast("Chọn năm học đã tạo và chưa đóng.","triangle-alert");return false;}
  if(event.archived&&operation!=="reopen"){showToast("Mở lại sự kiện lưu trữ có xác nhận trước khi kích hoạt.","triangle-alert");return false;}
  const switched=id!==activeEvent().id,legacy=!event.schoolYear;
  if(operation==="activate"&&year.status!=="active"){showToast("Kích hoạt năm học tại Quản lý học sinh trước.","triangle-alert");return false;}
  if(operation==="reopen"||legacy||(operation==="activate"&&switched)){
    const text=(operation==="activate"?"Kích hoạt":operation==="reopen"?"Mở lại, chưa kích hoạt":"Lưu liên kết")+" sự kiện “"+event.name+"” · ID: "+id+" · Năm học "+schoolYearId+"? "+
      (operation==="activate"&&switched?"Thay thế sự kiện đang hoạt động “"+activeEvent().name+"” · ID: "+activeEvent().id+". ":"")+
      (legacy?"BTC xác nhận đã đối chiếu hồ sơ và sự kiện thuộc đúng năm học này. ":"")+"Lịch sử được giữ nguyên.";
    if(!confirm(text))return false;
  }
  $("activeEventSelect").disabled=true;$("configEventYear").disabled=true;
  try{
    return await performEventAction("CONFIGURE_EVENT_ACTIVATION",{eventId:id,managedEventId:id,schoolYearId,operation,
      eventActivationVersion:"event-activation-v1",expectedRevision:setup.event.eventRevision,expectedYearsRevision:setup.schoolYearsRevision,
      expectedActiveEventId:activeEvent().id,confirmedSwitch:operation==="activate"&&switched,confirmedReopen:operation==="reopen",confirmLegacyYear:legacy},
      operation==="activate"?"Đã liên kết năm học và kích hoạt sự kiện.":operation==="link"?"Đã lưu liên kết năm học; chưa kích hoạt.":"Đã mở lại sự kiện; chưa kích hoạt.");
  }finally{if(user===currentUser){$("activeEventSelect").disabled=false;renderConfigSchoolYears();}}
}

async function saveManagedEventDetails(event){
  event.preventDefault();const id=managedEventId(),selected=EVENTS.find(item=>item.id===id);if(!selected)return;
  const draftAtStart=eventAdminState.eventDrafts.get(id);
  const name=$("managedEventName").value.trim(),date=$("managedEventDate").value.trim(),description=$("managedEventDescription").value.trim();
  if(!name||!date){showToast("Nhập tên và thời gian sự kiện.","triangle-alert");return;}
  const schoolYear=selected.schoolYear||"";
  const events=EVENTS.map(item=>item.id===id?{...item,name,date,description,schoolYear}:item);
  if(await performEventAction("SAVE_EVENT_CONFIG",{managedEventId:id,config:{activeEventId:activeEvent().id,events}},"Đã lưu thông tin sự kiện.")&&eventAdminState.eventDrafts.get(id)===draftAtStart)eventAdminState.eventDrafts.delete(id);
}

function initializeEventAdministration(){
  $("configEventsTab").addEventListener("click",()=>showConfigSection("events"));
  $("configStudentsTab").addEventListener("click",()=>showConfigSection("students"));
  $("configSubnav").addEventListener("keydown",event=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    const buttons=[$("configEventsTab"),$("configStudentsTab")].filter(button=>!button.hidden);
    const next=event.key==="Home"?buttons[0]:event.key==="End"?buttons.at(-1):buttons.find(button=>button!==document.activeElement)||buttons[0];
    event.preventDefault();next.focus();next.click();
  });
  $("activeEventSelect").addEventListener("change",()=>selectManagedEvent($("activeEventSelect").value));
  $("configEventYear").addEventListener("change",()=>{eventAdminState.yearChoices.set(managedEventId(),$("configEventYear").value);renderManagedActivationControls();});
  $("staffEvent").addEventListener("change",()=>selectManagedEvent($("staffEvent").value));
  $("managedEventReload").addEventListener("click",()=>{void loadManagedEvent(managedEventId(),true);void loadEventDeleteState(true);});
  $("eventConfigCards").addEventListener("click",event=>{const button=event.target.closest?.("[data-managed-event]");if(button)selectManagedEvent(button.dataset.managedEvent);});
  $("managedEventForm").addEventListener("submit",event=>void saveManagedEventDetails(event));
  for(const id of ["managedEventName","managedEventDate","managedEventDescription"])$(id).addEventListener("input",()=>eventAdminState.eventDrafts.set(managedEventId(),{
    name:$("managedEventName").value,date:$("managedEventDate").value,description:$("managedEventDescription").value}));
  $("adminBoothConfig").addEventListener("input",rememberManagedBoothDraft);
  $("adminBoothConfig").addEventListener("change",rememberManagedBoothDraft);
  $("staffTeacher").addEventListener("change",()=>{
    const setup=managedEventSetup(),teacher=setup?.teachers.find(item=>item.email===$("staffTeacher").value);
    $("staffEmail").value=teacher?.email||"";$("staffTeacherName").value=teacher?.name||"";
    const assigned=setup?.assignments.filter(row=>row.email===teacher?.email&&row.enabled)||[];
    $("staffBooth").querySelectorAll("input").forEach(input=>{input.checked=assigned.some(row=>row.boothId===input.value)});
    if(assigned.length)$("staffAssignmentForm").dataset.editing=teacher.email;
    else delete $("staffAssignmentForm").dataset.editing;
    $("staffAssignmentSubmit").textContent=assigned.length?"Cập nhật phân công":"Cấp phân công";
  });
  $("staffEmail").addEventListener("input",()=>{
    if($("staffAssignmentForm").dataset.editing!==$("staffEmail").value){
      delete $("staffAssignmentForm").dataset.editing;$("staffAssignmentSubmit").textContent="Cấp phân công";
    }
  });
  $("staffAssignmentForm").addEventListener("submit",event=>{event.preventDefault();void submitManagedAssignment();});
}
