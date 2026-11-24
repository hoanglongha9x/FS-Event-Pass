/* BTC-only draft geometry. API authorization remains in EventImages.gs. No completion writes. */
(() => {
  "use strict";
  const G=window.FSchoolPassportLayout;
  window.createPassportLayoutEditor=function(getElement,context,changed,say){
    const mode=getElement("eventPassportMode"),capacity=getElement("eventPassportCapacity"),positions=getElement("eventPassportPositions"),guide=getElement("eventPassportGuide");
    const tools=getElement("eventPassportLayoutTools"), controls=getElement("eventPassportLayoutControls"), mapping=getElement("eventPassportMapping");
    let states={},pages={desktop:0,mobile:0};
    const node=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;return el;};
    const device=kind=>kind==="passportMobile"?"mobile":"desktop";
    function state(kind=context().kind){
      if(!states[kind])states[kind]={layout:G.adapt(context().images?.[kind]?.layout,context().booths),undo:[],dirty:false};
      return states[kind];
    }
    function asset(kind){return context().asset(kind)||{width:kind==="passportMobile"?3:16,height:kind==="passportMobile"?4:9};}
    function normalized(kind){
      const layout=G.clone(state(kind).layout),image=asset(kind);
      layout.layoutVersion=G.version;
      layout.safeArea=G.areaOf(layout,image);
      if(image.layout?.profileTemplate)layout.profileTemplate=image.layout.profileTemplate;else delete layout.profileTemplate;
      if(layout.mode==="template"){
        layout.capacity=(layout.slots||[]).length;
        layout.assignments=G.bind(context().booths,layout.slots||[],layout.assignments);
      }
      return {layoutVersion:layout.layoutVersion,mode:layout.mode,safeArea:layout.safeArea,
        ...(layout.profileTemplate?{profileTemplate:layout.profileTemplate}:{}),
        ...(layout.mode==="template"?{capacity:layout.capacity,slots:layout.slots,assignments:layout.assignments}:{})};
    }
    function remember(kind){const s=state(kind);s.undo.push(G.clone(s.layout));if(s.undo.length>20)s.undo.shift();}
    function edit(mutator,redraw=true){
      const c=context();if(!c.supported||c.busy)return;
      remember(c.kind);mutator(state().layout);state().dirty=true;changed();if(redraw)renderControls();
    }
    function getLayout(kind){
      if(!context().supported)throw Error("BTC cần backend hỗ trợ passport-responsive-v1, passport-profile-v1 và passport-layout-v2 trước khi lưu bố trí.");
      const layout=normalized(kind),image=asset(kind),issue=layout.mode==="template"?G.validateSlots(layout.slots,image,layout.safeArea):G.validateArea(layout.safeArea,image);
      if(issue)throw Error(issue);
      return layout;
    }
    function renderControls(){
      const c=context(),layout=normalized(c.kind),template=layout.mode==="template";
      controls.disabled=!c.supported;mode.value=layout.mode||"auto";capacity.value=layout.slots?.length||Math.min(12,Math.max(1,c.booths.length));
      tools.hidden=!template;positions.hidden=!template;
      for(const key of ["x","y","width","height"])getElement("eventPassportSafe"+key[0].toUpperCase()+key.slice(1)).value=layout.safeArea[key];
      const issue=template?G.validateSlots(layout.slots,asset(c.kind),layout.safeArea):G.validateArea(layout.safeArea,asset(c.kind));
      guide.textContent=!c.supported?"Chưa có passport-layout-v2: chỉ xem trước, không giả lập trạng thái đã lưu.":issue||
        (template?`${c.booths.length} gian hàng / ${layout.slots.length} slot · ${Math.max(1,Math.ceil(c.booths.length/layout.slots.length))} trang. Kéo dấu hoặc nhập tọa độ; vị trí được dùng lại ở mỗi trang.`:"Vòng tròn tự động chỉ nằm trong vùng an toàn; tự chia trang để giữ kích thước dễ đọc.");
      getElement("eventPassportUndo").disabled=!state().undo.length||!c.supported;
      getElement("eventPassportRestoreLayout").disabled=!c.images?.[c.kind]?.canRestoreLayout||!c.supported;
      positions.replaceChildren(...(template?layout.slots||[]:[]).map(slot=>{
        const group=node("fieldset"),legend=node("legend",slot.slotId);group.append(legend);
        for(const [key,title] of [["x","X (%)"],["y","Y (%)"],["size","Đường kính (%)"]]){
          const label=node("label",title),input=node("input");input.type="number";input.min="0";input.max="100";input.step="0.1";input.value=slot[key];input.dataset.slotId=slot.slotId;input.dataset.coordinate=key;
          input.addEventListener("change",()=>edit(l=>{l.slots.find(s=>s.slotId===slot.slotId)[key]=input.value===""?null:Number(input.value);}));
          label.append(input);group.append(label);
        }
        return group;
      }));
      mapping.textContent=template?(layout.assignments||[]).map(a=>`${c.booths.find(b=>b.id===a.boothId)?.name||a.boothId} → trang ${a.page}, ${a.slotId}`).join("; "):"";
      renderAll();
    }
    function generate(){
      const c=context();if(!c.supported||c.busy)return;
      try{
        const amount=Number(capacity.value);if(!Number.isInteger(amount)||amount<1||amount>80)throw Error("Chọn từ 1 đến 80 slot thực tế.");
        const layout=normalized(c.kind),slots=G.generate(amount,asset(c.kind),layout.safeArea,device(c.kind));
        edit(l=>{l.mode="template";l.slots=slots;l.capacity=slots.length;l.assignments=G.bind(c.booths,slots);});
      }catch(error){say(error.message);}
    }
    function render(marks,frame,viewDevice){
      const c=context(),kind=viewDevice==="mobile"?"passportMobile":"passport",own=!!c.asset(kind),image=own?asset(kind):asset("passport"),
        layout=viewDevice==="mobile"&&!own?{mode:"auto"}:normalized(kind),width=viewDevice==="mobile"?250:900;
      const plan=G.plan({booths:c.booths,asset:image,layout,width,device:viewDevice});
      const page=Math.min(pages[viewDevice]||0,Math.max(0,plan.pages.length-1));pages[viewDevice]=page;
      frame.style.setProperty("--preview-image-ratio",image.width+" / "+image.height);
      marks.classList.add("is-template-preview");
      marks.replaceChildren(...(plan.pages[page]||[]).map(item=>{
        const marker=node("span");marker.className="event-preview-seal";marker.title=c.booths.find(b=>b.id===item.boothId)?.name||"";
        marker.dataset.boothId=item.boothId;marker.dataset.slotId=item.slotId||"";
        marker.style.left=item.x+"%";marker.style.top=item.y+"%";
        marker.style.width=item.sizePx/width*100+"%";
        if(plan.mode==="template"&&own&&kind===c.kind&&c.supported){
          marker.tabIndex=0;marker.setAttribute("role","button");marker.setAttribute("aria-label",marker.title+" · "+item.slotId+". Kéo để di chuyển, phím mũi tên để tinh chỉnh.");
          marker.classList.add("is-draggable");
          const handle=node("span");handle.className="passport-resize-handle";handle.title="Kéo để đổi đường kính";marker.append(handle);
          attachDrag(marker,handle,frame,item.slotId,kind);
        }
        return marker;
      }));
      let safe=frame.querySelector?.(".passport-safe-overlay");
      if(!safe){safe=node("div");safe.className="passport-safe-overlay";safe.setAttribute("aria-hidden","true");frame.append(safe);}
      safe.style.left=plan.area.x+"%";safe.style.top=plan.area.y+"%";safe.style.width=plan.area.width+"%";safe.style.height=plan.area.height+"%";
      frame.dataset.page=String(page+1);frame.dataset.pages=String(plan.pages.length);
      return plan;
    }
    function attachDrag(marker,handle,frame,slotId,kind){
      function move(l,x,y,size){
        const s=l.slots.find(s=>s.slotId===slotId),image=asset(kind),a=G.areaOf(l,image),rx=size/2,ry=rx*image.width/image.height;
        s.x=Math.max(a.x+rx,Math.min(a.x+a.width-rx,x));s.y=Math.max(a.y+ry,Math.min(a.y+a.height-ry,y));s.size=size;
        return G.validateSlots(l.slots,image,a);
      }
      marker.addEventListener("pointerdown",event=>{
        if(event.button!==0||context().busy)return;event.preventDefault();
        const resizing=event.target===handle,rect=frame.getBoundingClientRect(),s=state(kind),before=G.clone(s.layout),start=normalized(kind).slots.find(slot=>slot.slotId===slotId);
        const pointerId=event.pointerId;marker.setPointerCapture(pointerId);
        let valid=G.clone(before),issue="";
        const onMove=e=>{
          if(e.pointerId!==pointerId)return;
          const candidate=G.clone(before),dx=(e.clientX-event.clientX)/rect.width*100,dy=(e.clientY-event.clientY)/rect.height*100;
          const maxSize=Math.min(65,2*Math.min(start.x-normalized(kind).safeArea.x,normalized(kind).safeArea.x+normalized(kind).safeArea.width-start.x),
            2*Math.min(start.y-normalized(kind).safeArea.y,normalized(kind).safeArea.y+normalized(kind).safeArea.height-start.y)*rect.height/rect.width);
          const size=resizing?Math.max(4,Math.min(maxSize,start.size+dx*2)):start.size;
          issue=move(candidate,start.x+(resizing?0:dx),start.y+(resizing?0:dy),size);
          if(issue){say(issue);return;}
          valid=candidate;const slot=candidate.slots.find(s=>s.slotId===slotId);
          marker.style.left=slot.x+"%";marker.style.top=slot.y+"%";marker.style.width=Math.min(size,(kind==="passportMobile"?90:100)/(kind==="passportMobile"?250:900)*100)+"%";
        };
        const finish=e=>{
          if(e.pointerId!==pointerId)return;
          marker.removeEventListener("pointermove",onMove);marker.removeEventListener("pointerup",finish);marker.removeEventListener("pointercancel",cancel);
          if(JSON.stringify(valid)!==JSON.stringify(before)){remember(kind);s.layout=valid;s.dirty=true;changed();say("Đã cập nhật bản nháp tọa độ. Nhấn Lưu để ghi nhận.");}else if(issue)say(issue);
          renderControls();
        };
        const cancel=e=>{valid=before;finish(e);};
        marker.addEventListener("pointermove",onMove);marker.addEventListener("pointerup",finish);marker.addEventListener("pointercancel",cancel);
      });
      marker.addEventListener("keydown",event=>{
        const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;
        event.preventDefault();const candidate=G.clone(state(kind).layout),slot=candidate.slots.find(s=>s.slotId===slotId),issue=move(candidate,slot.x+delta[0]*(event.shiftKey?2:.2),slot.y+delta[1]*(event.shiftKey?2:.2),slot.size);
        if(issue){say(issue);return;}remember(kind);state(kind).layout=candidate;state(kind).dirty=true;changed();renderControls();
        frame.querySelector?.('.event-preview-seal[data-slot-id="'+slotId+'"]')?.focus();
      });
    }
    function renderAll(){
      const mobile=getElement("eventPassportPreview").dataset.previewMode==="mobile",d=mobile?"mobile":"desktop";
      const plan=render(getElement("eventPassportMarks"),getElement("eventPassportPreview"),d);
      const pager=getElement("eventPassportPages");pager.hidden=plan.pages.length<2;
      getElement("eventPassportPageStatus").textContent=`Trang ${pages[d]+1} / ${Math.max(1,plan.pages.length)}`;
      getElement("eventPassportPrevious").disabled=pages[d]===0;getElement("eventPassportNext").disabled=pages[d]>=plan.pages.length-1;
      getElement("eventPassportPageWarning").textContent=plan.message;
      if(getElement("eventImageViewer").open){
        render(getElement("eventImageViewerMarks"),getElement("eventImageViewerCanvas"),d);
        getElement("eventImageViewerPageStatus").textContent=getElement("eventPassportPageStatus").textContent;
        getElement("eventImageViewerPrevious").disabled=pages[d]===0;getElement("eventImageViewerNext").disabled=pages[d]>=plan.pages.length-1;
      }
    }
    mode.addEventListener("change",()=>{
      const value=mode.value;edit(l=>{l.mode=value;if(value==="template"&&!l.slots?.length){l.slots=[];l.capacity=0;}});
    });
    getElement("eventPassportGenerate").addEventListener("click",generate);
    for(const key of ["x","y","width","height"])getElement("eventPassportSafe"+key[0].toUpperCase()+key.slice(1)).addEventListener("change",event=>{
      const value=event.target.value===""?null:Number(event.target.value);edit(l=>{l.safeArea={...G.areaOf(l,asset(context().kind)),[key]:value};});
    });
    getElement("eventPassportUndo").addEventListener("click",()=>{
      const s=state();if(!context().supported||!s.undo.length)return;s.layout=s.undo.pop();s.dirty=true;changed();renderControls();
    });
    for(const prefix of ["eventPassport","eventImageViewer"])for(const [suffix,delta] of [["Previous",-1],["Next",1]])getElement(prefix+suffix).addEventListener("click",()=>{
      const d=getElement("eventPassportPreview").dataset.previewMode==="mobile"?"mobile":"desktop";pages[d]=Math.max(0,pages[d]+delta);renderAll();
    });
    return {getLayout,renderAll,renderControls,generate,hasDirty:()=>Object.values(states).some(s=>s.dirty),snapshot:()=>G.clone(states),
      reset:(images,saved)=>{states=saved?G.clone(saved):{};pages={desktop:0,mobile:0};renderControls();},
      committed:(kind,layout)=>{states[kind]={layout:G.adapt(layout,context().booths),undo:[],dirty:false};},
      isDirty:kind=>state(kind).dirty};
  };
})();
