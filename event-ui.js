/* Presentation helpers inspired by Lucian #001, #039, #044, #070 and #083.
 * Lucian attribution and MIT notice are retained in lucian-ui.css.
 * This module never sends requests or decides whether an operation succeeded.
 */
(() => {
  "use strict";
  const actionIcons = {
    studentLoginButton:"log-in", sendOtpButton:"mail", verifyOtpButton:"shield-check",
    refreshEventButton:"refresh-cw", eventArchiveButton:"history", studentPassButton:"ticket",
    completeCurrentButton:"circle-check", skipCurrentButton:"circle-arrow-right",
    completeGroupButton:"users-round", drawQueueButton:"ticket-plus", cancelQueueButton:"circle-x",
    drawButton:"trophy", rosterRefresh:"refresh-cw", rosterAdd:"user-plus", yearCreate:"calendar-plus",
    yearActivate:"calendar-check", yearClose:"archive", rosterImportConfirm:"file-check",
    rosterImportCancel:"x", rosterRevokeSession:"key-round", rosterLock:"lock-keyhole",
    rosterStudentAccessToggle:"key-round", eventImagesReload:"refresh-cw",
    eventPassportExpand:"expand", eventPassportSave:"save",
    eventPassportDefault:"image",
    eventPassportRestore:"history", eventImageViewerClose:"x", studentPassClose:"x",
    eventArchiveClose:"x", rosterEditCancel:"x", submitReviewButton:"send", submitFavoriteVoteButton:"heart",
    refreshCrowdAdviceButton:"sparkles", "teacher-mobile-menu-btn":"menu"
  };
  const fieldIcons = {
    studentCodeInput:"badge", studentAccessInput:"key-round", teacherEmailInput:"mail",
    teacherOtpInput:"shield-check", activeEventSelect:"calendar-days", configEventYear:"calendar-range",
    staffEvent:"calendar-days", staffBooth:"store", staffEmail:"graduation-cap", rosterYear:"calendar-range",
    rosterEvent:"calendar-days", rosterFile:"file-up", eventPassportFile:"image-up",
    eventImagesSelect:"images", rosterEditCode:"badge", rosterEditName:"user-round", rosterEditClass:"school"
  };
  const labelIcons = [
    [/^Thu hồi/,"user-minus"], [/^Khôi phục/,"history"], [/^Lưu|^Bổ sung|^Cập nhật/,"save"],
    [/^Thêm|^Tạo/,"plus"], [/^Xóa/,"trash-2"], [/^Sửa/,"pencil"], [/^Hủy|^Đóng/,"x"],
    [/^Quản lý/,"user-cog"], [/^Gọi lại/,"rotate-ccw"], [/^Xem trước/,"expand"], [/^Cấp phân công/,"user-check"],
    [/^Kích hoạt/,"zap"], [/^Chọn hoạt động/,"calendar-check"], [/^Đóng năm/,"archive"],
    [/^Thay ảnh/,"image-up"], [/^Vào trạm/,"store"], [/^Làm mới/,"refresh-cw"],
    [/^Quay|^QUAY/,"trophy"], [/^Mở khóa/,"lock-keyhole-open"], [/^Khóa/,"lock-keyhole"]
  ];
  const escape = value => String(value ?? "").replace(/[&<>"']/g, ch =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const frame = callback => (window.requestAnimationFrame || (fn => setTimeout(fn,16)))(callback);
  let lastButton = null, queuedFrame = false, toastTimer = null, visibleToast = null;
  const roots = new Set(), notifications = [];
  const toastDurations = {success:4200, info:5000, warning:7500, error:12000};

  function icon(name, className="ui-icon") {
    const node=document.createElement("i");
    node.setAttribute("data-lucide",name);
    node.setAttribute("aria-hidden","true");
    node.className=className;
    return node;
  }
  function render(root=document) {
    const library=window.lucide;
    if (!library?.createElement) return;
    const placeholders=[...(root.matches?.("i[data-lucide]")?[root]:[]),...root.querySelectorAll("i[data-lucide]")];
    for (const node of placeholders) {
      const name=node.getAttribute("data-lucide");
      const key=name.replace(/(^|-)([a-z0-9])/g,(_,dash,letter)=>letter.toUpperCase());
      const definition=library.icons[key] || library.icons.CircleHelp;
      const attrs=Object.fromEntries([...node.attributes].map(attr=>[attr.name,attr.value]));
      const svg=library.createElement(definition, {...attrs, class:"lucide "+(attrs.class||""), "aria-hidden":"true", focusable:"false"});
      node.replaceWith(svg);
    }
  }
  function decorate(root=document) {
    const buttons=[...(root.matches?.("button")?[root]:[]),...root.querySelectorAll("button")];
    for (const button of buttons) {
      if (button.hasAttribute("data-rating") || button.querySelector("svg,[data-lucide]")) continue;
      const name=actionIcons[button.id] || labelIcons.find(([pattern])=>pattern.test(button.textContent.trim()))?.[1];
      if (name) {
        const glyph=icon(name,"ui-action-icon ui-icon-small");
        if (/^[×✕]$/.test(button.textContent.trim()) && button.hasAttribute("aria-label")) button.replaceChildren(glyph);
        else button.prepend(glyph);
      }
    }
    for (const label of root.querySelectorAll("label")) {
      if (label.querySelector(".ui-label-caption")) continue;
      const control=label.htmlFor || label.querySelector("input,select")?.id;
      const name=fieldIcons[control];
      const text=[...label.childNodes].find(child=>child.nodeType===3 && child.textContent.trim());
      if (!name || !text) continue;
      const caption=document.createElement("span");
      caption.className="ui-label-caption";
      caption.append(icon(name,"ui-icon-small"), document.createTextNode(text.textContent.trim()));
      text.replaceWith(caption);
    }
    render(root);
  }
  function schedule(root=document) {
    if (!root.querySelectorAll || root.namespaceURI==="http://www.w3.org/2000/svg") return;
    roots.add(root);
    if (queuedFrame) return;
    queuedFrame=true;
    frame(()=>{
      queuedFrame=false;
      const pending=[...roots];roots.clear();
      for (const node of pending) if (node.isConnected !== false) decorate(node);
    });
  }
  function begin(button=lastButton || document.activeElement) {
    if (!button?.matches?.("button") || button.isConnected===false) return null;
    const handle={button, closed:false, ariaBusy:button.getAttribute("aria-busy")};
    button.uiFeedback=handle;
    button.dataset.uiState="loading";
    button.setAttribute("aria-busy","true");
    lastButton=null;
    return handle;
  }
  function end(handle, state="idle") {
    if (!handle || handle.closed) return;
    handle.closed=true;
    const {button}=handle;
    if (handle.ariaBusy===null) button.removeAttribute("aria-busy");
    else button.setAttribute("aria-busy",handle.ariaBusy);
    button.dataset.uiState=state;
    if (state!=="idle") setTimeout(()=>{
      if(button.uiFeedback===handle && button.dataset.uiState===state)delete button.dataset.uiState;
    },1600);
  }
  function closeToast() {
    clearTimeout(toastTimer);
    if (!visibleToast) return;
    const old=visibleToast;visibleToast=null;
    old.classList.add("ui-toast-leave");
    setTimeout(()=>{
      old.remove();
      nextToast();
    },180);
  }
  function armToast() {
    clearTimeout(toastTimer);
    if (visibleToast) toastTimer=setTimeout(closeToast,toastDurations[visibleToast.dataset.tone]);
  }
  function nextToast() {
    if (visibleToast || !notifications.length) return;
    const {message, tone, name}=notifications.shift();
    const toast=document.createElement("div");
    toast.className="ui-toast";
    toast.dataset.tone=tone;
    toast.setAttribute("role",tone==="error"?"alert":"status");
    toast.innerHTML='<span class="ui-toast-icon"><i data-lucide="'+name+'" aria-hidden="true"></i></span>'+
      '<span class="ui-toast-message">'+escape(message)+'</span>'+
      '<button type="button" class="ui-toast-close" aria-label="Đóng thông báo"><i data-lucide="x" aria-hidden="true"></i></button>';
    document.getElementById("toastStack").appendChild(toast);
    toast.querySelector("button").addEventListener("click",closeToast);
    toast.addEventListener("pointerenter",()=>clearTimeout(toastTimer));
    toast.addEventListener("pointerleave",armToast);
    toast.addEventListener("focusin",()=>clearTimeout(toastTimer));
    toast.addEventListener("focusout",armToast);
    visibleToast=toast;
    render(toast);
    armToast();
  }
  function notify(message, name="info", tone="info") {
    const scanner=document.getElementById("qrScannerModal"),scannerStatus=document.getElementById("qrScannerStatus");
    if(scanner&&!scanner.classList.contains("hidden")&&scannerStatus){
      scannerStatus.textContent=String(message);return;
    }
    if (!toastDurations[tone]) {
      tone=["shield-x","wifi-off","circle-x"].includes(name)?"error":
        ["check","circle-check","save"].includes(name)?"success":name==="triangle-alert"?"warning":"info";
    }
    name={success:"circle-check",error:"circle-alert",warning:"triangle-alert",info:"info"}[tone];
    if (visibleToast?.querySelector(".ui-toast-message")?.textContent===String(message)) { armToast(); return; }
    clearTimeout(toastTimer);
    document.getElementById("toastStack").replaceChildren();
    visibleToast=null;
    notifications.splice(0,notifications.length,{message,tone,name});
    nextToast();
  }

  function status(node, text, kind="idle") {
    if(!node || (node.dataset.statusText===text && node.dataset.statusKind===kind))return;
    node.dataset.statusText=text;node.dataset.statusKind=kind;
    node.className="ui-sync";
    node.setAttribute("role","status");
    node.innerHTML='<i data-lucide="'+({ok:"cloud-check",loading:"refresh-cw",error:"wifi-off",idle:"cloud"}[kind]||"cloud")+
      '" class="ui-icon-small" aria-hidden="true"></i><span>'+escape(text)+'</span>';
    render(node);
  }

  document.addEventListener("click",event=>{
    lastButton=event.target.closest?.("button") || null;
  },true);
  document.addEventListener("submit",event=>{
    lastButton=event.submitter || lastButton;
  },true);
  const modalIds=["stationQrModal","qrScannerModal","favoriteVoteModal","reviewModal","boothModal"];
  const openers=new Map();
  function activeModal() {
    return modalIds.map(id=>document.getElementById(id)).find(node=>node && !node.classList.contains("hidden"));
  }
  function focusable(node) {
    return [...node.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]
      .filter(item=>item.getClientRects().length);
  }
  document.addEventListener("keydown",event=>{
    if(document.querySelector("dialog[open]"))return;
    const modal=activeModal();if(!modal)return;
    if(event.key==="Escape"){
      if(modal.id==="qrScannerModal")return; // Existing handler releases the camera.
      event.preventDefault();
      if(modal.id==="stationQrModal" && typeof window.closeStationQr==="function")void window.closeStationQr();
      else if(modal.id==="boothModal" && typeof window.closeBoothModal==="function")window.closeBoothModal();
      else if(modal.id==="reviewModal" && typeof window.closeReviewModal==="function")window.closeReviewModal();
      else{modal.classList.add("hidden");modal.classList.remove("flex");}
    }else if(event.key==="Tab"){
      const controls=focusable(modal), first=controls[0], last=controls.at(-1);
      if(event.shiftKey && (document.activeElement===first || !modal.contains(document.activeElement))){
        event.preventDefault();last?.focus();
      }else if(!event.shiftKey && document.activeElement===last){
        event.preventDefault();first?.focus();
      }
    }
  });
  if(typeof MutationObserver!=="undefined"){
    for(const id of modalIds){
      const node=document.getElementById(id);if(!node)continue;
      if(!node.querySelector('[role="dialog"]')){
        node.setAttribute("role","dialog");node.setAttribute("aria-modal","true");
      }
      const heading=node.querySelector("h2,#stationQrTitle");
      if(heading){if(!heading.id)heading.id=id+"Heading";node.setAttribute("aria-labelledby",heading.id);}
      let visible=!node.classList.contains("hidden");
      new MutationObserver(()=>{
        const next=!node.classList.contains("hidden");if(next===visible)return;
        visible=next;
        if(next){
          openers.set(node,document.activeElement);
          frame(()=>{if(!node.classList.contains("hidden"))focusable(node)[0]?.focus();});
        }else{
          const opener=openers.get(node);
          if(opener?.isConnected && opener.getClientRects().length)opener.focus();
          openers.delete(node);
        }
      }).observe(node,{attributes:true,attributeFilter:["class"]});
    }
  }
  if (typeof MutationObserver!=="undefined") {
    const observer=new MutationObserver(records=>{
      for(const record of records){
        if(record.target.nodeName==="BUTTON")schedule(record.target);
        for(const node of record.addedNodes)if(node.nodeType===1)schedule(node);
      }
    });
    observer.observe(document.body,{childList:true,subtree:true});
  }
  window.FSchoolUi={render:decorate,begin,end,notify,icon,status};
  decorate();
})();
