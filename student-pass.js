(() => {
  "use strict";

  const completionTime = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short"
  });
  function projectPass(snapshot, session) {
    if (!snapshot?.success || snapshot.access?.role !== "STUDENT" || !session?.code ||
        snapshot.profile?.code !== session.code || !Array.isArray(snapshot.records)) return null;

    const eventConfig = snapshot.records.find(record => record?.type === "config" && record.id === "event-config")?.data;
    const event = Array.isArray(eventConfig?.events) && eventConfig.events.find(item => item?.id === eventConfig.activeEventId);
    if (!event || event.id !== session.eventId) return null;

    const boothConfig = snapshot.records.find(record => record?.type === "config" && record.id === "booth-config")?.data;
    if (boothConfig?.eventId && boothConfig.eventId !== event.id) return null;
    const configuredBooths = boothConfig?.boothList;
    if (!Array.isArray(configuredBooths)) return null;

    // Ticket numbers are scoped to each booth. An authenticated event snapshot is the only source of stamps.
    const entries = new Map();
    for (const record of snapshot.records) {
      const item = record?.data;
      if (record?.type !== "queue" || item?.eventId !== event.id || item.studentCode !== session.code) continue;
      const updated = Date.parse(record.updatedAt || item.updatedAt) || 0;
      if (!entries.has(item.boothId) || updated >= entries.get(item.boothId).updated) {
        entries.set(item.boothId, { item, updated });
      }
    }

    const booths = new Map();
    for (const booth of configuredBooths) {
      if (!booth?.id || !booth.name || booths.has(booth.id)) continue;
      const item = entries.get(booth.id)?.item;
      const completed = item?.status === "completed";
      const ticket = item?.ticketNo;
      booths.set(booth.id, {
        id: booth.id,
        name: booth.name,
        icon: booth.icon,
        completed,
        completedAt: completed && Number.isFinite(Date.parse(item.completedAt)) ? item.completedAt : null,
        ticket: completed && Number.isSafeInteger(ticket) && ticket > 0 ? ticket : null
      });
    }

    return {
      eventId: event.id, eventName: event.name, code: session.code,
      name: snapshot.profile.name, className: snapshot.profile.className,
      artwork: event.images?.passport,
      mobileArtwork: event.images?.passportMobile,
      booths: [...booths.values()]
    };
  }

  function makeElement(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = value;
    return node;
  }

  // Geometry of the two BTC-supplied artworks. Values remain authenticated HTML, never pixels in Drive.
  const profileTemplates = Object.freeze({
    "open-stem-landscape-v1": {width:2098,height:749,header:40,name:[240,50,447,90],className:[135,171,552,90]},
    "open-stem-portrait-v1": {width:1179,height:2556,header:36,name:[405,500,684,131],className:[259,696,832,124]}
  });
  const placements = new WeakMap();
  function profileTemplate(asset) {
    const template = profileTemplates[asset?.layout?.profileTemplate];
    return template && asset.width > 0 && asset.height > 0 &&
      Math.abs(asset.width / asset.height / (template.width / template.height) - 1) <= .015 ? template : null;
  }
  function createArtProfile(parent) {
    const overlay=makeElement("div","passport-art-profile"),name=makeElement("span","passport-art-name"),
      className=makeElement("span","passport-art-class");
    name.append(makeElement("span"));className.append(makeElement("span"));
    overlay.hidden=true;overlay.setAttribute("role","group");overlay.setAttribute("aria-label","Thông tin học sinh trên phiếu");
    overlay.append(name,className);parent.append(overlay);
    return {overlay,name,className};
  }
  function placeArtProfile(target, asset, identity, done=()=>{}) {
    const ticket={},template=profileTemplate(asset),root=target.overlay;
    placements.set(root,ticket);root.hidden=!template;
    for(const key of ["name","className"]){
      const box=target[key],text=box.children[0];
      text.textContent=template?String(identity?.[key]||""):"";
      box.setAttribute("aria-label",(key==="name"?"Họ và tên: ":"Lớp: ")+text.textContent);
      if(!template)continue;
      const [x,y,width,height]=template[key];
      for(const [prop,value] of [["left",x/template.width],["top",y/template.height],["width",width/template.width],["height",height/template.height]])box.style.setProperty(prop,value*100+"%");
    }
    if(!template){done(false);return;}
    root.style.setProperty("--profile-image-ratio",asset.width+" / "+asset.height);
    const fit=()=>{
      if(placements.get(root)!==ticket||root.hidden)return;
      let readable=true,fits=true;
      for(const key of ["name","className"]){
        const box=target[key],text=box.children[0];
        if(!box.clientWidth||!box.clientHeight){readable=false;fits=false;continue;}
        let size=Math.max(8.5,Math.floor(Math.min(20,box.clientHeight*(key==="name"?.52:.65))*2)/2);
        while(size>=8.5){
          text.style.fontSize=size+"px";
          if(text.scrollWidth<=box.clientWidth+1&&text.getBoundingClientRect().height<=box.clientHeight+1)break;
          size-=.5;
        }
        if(size<8.5)fits=false;
        if(size<12)readable=false;
      }
      root.hidden=!fits;
      root.setAttribute("aria-hidden",String(!readable));
      done(readable&&fits);
    };
    (window.requestAnimationFrame||((fn)=>setTimeout(fn,0)))(fit);
  }
  window.FSchoolPassArtwork = {profileTemplate,createArtProfile,placeArtProfile,
    uploadTemplate: name=>({
      "fpt_open_stem_day_ngang_hoten_lop.png":"open-stem-landscape-v1",
      "fpt_open_stem_day_doc_393x852_dpr3_hoten_lop.png":"open-stem-portrait-v1"
    })[String(name||"").toLowerCase()]||""};

  function boothStamp(booth, animate, select) {
    const card = makeElement("li", "student-pass-booth");
    card.dataset.boothId = booth.id;
    const circle = makeElement("button", "student-pass-stamp");
    circle.type = "button";
    circle.title = booth.name;
    circle.setAttribute("aria-label", booth.name + (booth.completed ? ". Đã hoàn thành." : ". Chưa hoàn thành.") + " Xem thông tin gian hàng.");
    circle.setAttribute("aria-controls", "studentPassStampDetails");
    circle.setAttribute("aria-expanded", "false");
    if (booth.completed) {
      circle.classList.add("is-complete");
      if (animate) circle.classList.add("animate-stampPop");
      const glyph = makeElement("i", "student-pass-stamp-icon");
      glyph.setAttribute("data-lucide", booth.icon || "badge-check");
      glyph.setAttribute("aria-hidden", "true");
      circle.append(glyph, makeElement("span", "student-pass-state", "HOÀN THÀNH"));
    }
    circle.addEventListener("click", () => select(booth.id));
    card.append(circle);
    return card;
  }

  window.createStudentExperiencePass = function (getElement, renderIcons, backdrop) {
    const button = getElement("studentPassButton");
    const dialog = getElement("studentPassDialog");
    const count = getElement("studentPassCount");
    const progress = getElement("studentPassProgress");
    const sync = getElement("studentPassSync");
    const grid = getElement("studentPassBooths");
    const canvas = getElement("studentPassCanvas");
    const art = getElement("studentPassArtwork");
    const artProfile=createArtProfile(canvas),profileBlock=getElement("studentPassName").closest(".student-pass-profile");
    const imageStatus = getElement("studentPassImageStatus");
    const panHint = getElement("studentPassPanHint");
    const details = getElement("studentPassStampDetails"), detailName = getElement("studentPassStampName"),
      detailState = getElement("studentPassStampState"), detailTime = getElement("studentPassStampTime");
    const profile = [getElement("studentPassEvent"), getElement("studentPassName"),
      getElement("studentPassClass"), getElement("studentPassCode")];
    const animated = new Set();
    const pending = new Set();
    let pass = null, artworkLoaded = false, selectedArtwork = null, selectedBoothId = "";

    function renderStampDetails() {
      const booth = pass?.booths.find(item => item.id === selectedBoothId);
      details.hidden = !booth;
      detailName.textContent = booth?.name || "";
      detailState.textContent = booth ? (booth.completed ? "Đã được xác nhận hoàn thành" : "Chưa được xác nhận hoàn thành") : "";
      detailTime.hidden = !booth?.completedAt;
      detailTime.textContent = booth?.completedAt ? completionTime.format(new Date(booth.completedAt)) : "";
      detailTime.dateTime = booth?.completedAt || "";
      for (const card of grid.children) {
        const circle = card.children[0], chosen = !!booth && card.dataset.boothId === booth.id;
        circle.classList.toggle("is-selected", chosen);
        circle.setAttribute("aria-expanded", String(chosen));
      }
    }
    function selectStamp(boothId) {
      if (!pass?.booths.some(booth => booth.id === boothId)) return;
      selectedBoothId = boothId;
      renderStampDetails();
    }
    function clearStampSelection() { selectedBoothId = ""; renderStampDetails(); }
    getElement("studentPassStampDetailsClose").addEventListener("click", () => {
      const id = selectedBoothId;
      clearStampSelection();
      [...grid.children].find(card => card.dataset.boothId === id)?.children[0]?.focus();
    });

    function responsiveArtwork() {
      const mobile = window.matchMedia && window.matchMedia("(max-width:767px)").matches;
      return mobile && pass?.mobileArtwork?.version ? {kind:"passportMobile", asset:pass.mobileArtwork} :
        {kind:"passport", asset:pass?.artwork};
    }

    function setSyncPending(value) {
      sync.hidden = !pass || !value;
    }

    function reset() {
      pass = null;
      artworkLoaded = false;
      selectedArtwork = null;
      animated.clear();
      pending.clear();
      button.hidden = true;
      if (dialog.open) dialog.close();
      count.textContent = "";
      progress.textContent = "";
      profile.forEach(node => { node.textContent = ""; });
      grid.replaceChildren();
      clearStampSelection();
      applyTemplate(false);
      backdrop(art, "", "passport");
      dialog.classList.remove("has-artwork");imageStatus.hidden=true;
      canvas.classList.remove("has-artwork");art.hidden=true;
      canvas.style.removeProperty("--pass-art-header");
      placeArtProfile(artProfile,null,null);
      profileBlock.classList.remove("has-art-profile");
      backdrop(grid, "", "passport");
      setSyncPending(false);
    }

    function applyTemplate(loaded) {
      const artwork = selectedArtwork?.asset;
      const slots = new Map((artwork?.layout?.slots || []).map(slot => [slot.boothId, slot]));
      const wide = !window.matchMedia || window.matchMedia("(min-width:1024px)").matches;
      const width = canvas.clientWidth || 0;
      const preset=profileTemplate(artwork),imageHeight=width*(artwork?.height||1)/(artwork?.width||1);
      const positioned = Boolean(loaded && wide && selectedArtwork?.kind === "passport" && artwork?.layout?.mode === "template" && slots.size &&
        slots.size === pass.booths.length && pass.booths.every(booth => slots.has(booth.id)) &&
        [...slots.values()].every(slot => width * slot.size / 100 >= 96 && (!preset || slot.y*imageHeight/100-48>=preset.header*imageHeight/100)));
      grid.classList.toggle("has-template", positioned);
      panHint.hidden = !loaded || artwork?.layout?.mode !== "template" || positioned;
      canvas.tabIndex = -1;
      const ratio = artwork?.width > 0 && artwork?.height > 0 ? artwork.width + " / " + artwork.height : "16 / 9";
      art.style.setProperty("--pass-image-ratio", ratio);
      // Reserve the top of the artwork for its logos; overflow continues over the fallback surface, never a zoomed crop.
      canvas.style.setProperty("--pass-art-header", loaded ? ((profileTemplate(artwork)?.header||22) * artwork.height / artwork.width) + "%" : "1rem");
      placeArtProfile(artProfile,loaded?artwork:null,pass,readable=>profileBlock.classList.toggle("has-art-profile",readable));
      if (!positioned) return;
      grid.style.setProperty("--pass-image-ratio", artwork.width + " / " + artwork.height);
      for (const card of grid.children) {
        const slot = slots.get(card.dataset.boothId);
        card.style.setProperty("--stamp-x", slot.x + "%");
        card.style.setProperty("--stamp-y", slot.y + "%");
        card.style.setProperty("--stamp-size", slot.size + "%");
      }
    }

    function render() {
      [pass.eventName, pass.name, pass.className, pass.code].forEach((value, index) => {
        profile[index].textContent = value;
      });
      progress.textContent = `${count.textContent} gian hàng hoàn thành`;
      const total = pass.booths.length || 1, columns = Math.ceil(total / Math.ceil(total / 5));
      grid.style.setProperty("--pass-desktop-columns", columns);
      grid.style.setProperty("--pass-medium-columns", Math.min(4,columns));
      grid.style.setProperty("--pass-small-columns", Math.min(3,columns));
      const focusedId = [...grid.children].find(card => card.children[0] === document.activeElement)?.dataset.boothId;
      grid.replaceChildren(...pass.booths.map(booth => boothStamp(booth, pending.has(booth.id), selectStamp)));
      renderStampDetails();
      if (focusedId) [...grid.children].find(card => card.dataset.boothId === focusedId)?.children[0]?.focus({preventScroll:true});
      renderArtwork();
      pending.clear();
      renderIcons();
    }

    function renderArtwork() {
      const choice = responsiveArtwork(), kind = choice.kind, version = choice.asset?.version;
      selectedArtwork = choice;
      artworkLoaded = false;
      applyTemplate(false);
      backdrop(art, pass.eventId, kind, version, loaded => {
        if (!pass || selectedArtwork !== choice) return;
        artworkLoaded = loaded;
        dialog.classList.toggle("has-artwork",loaded);
        canvas.classList.toggle("has-artwork",loaded);
        art.hidden = !loaded;
        imageStatus.hidden=!version||loaded;
        imageStatus.textContent=version&&!loaded?"Ảnh phiếu chưa tải được. Đang dùng nền dự phòng; các dấu đã xác nhận được giữ nguyên.":"";
        applyTemplate(loaded);
      });
    }

    function acceptSnapshot(snapshot, session) {
      const next = projectPass(snapshot, session);
      if (!next) {
        reset();
        return;
      }

      const samePass = pass?.code === next.code && pass?.eventId === next.eventId;
      if (!samePass) reset();
      const completed = next.booths.filter(booth => booth.completed);
      for (const booth of completed) {
        if (animated.has(booth.id)) continue;
        animated.add(booth.id);
        if (samePass) pending.add(booth.id);
      }
      const changed = JSON.stringify(pass) !== JSON.stringify(next);
      pass = next;
      count.textContent = `${completed.length}/${next.booths.length}`;
      button.hidden = false;
      setSyncPending(navigator.onLine === false);
      if (dialog.open && changed) render();
    }

    button.addEventListener("click", () => {
      if (!pass || dialog.open) return;
      render();
      dialog.showModal();
      applyTemplate(artworkLoaded);
    });
    getElement("studentPassClose").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { clearStampSelection(); if (!button.hidden) button.focus(); });
    window.addEventListener("resize", () => {
      if (!pass || !dialog.open) return;
      const next = responsiveArtwork();
      if (next.kind !== selectedArtwork?.kind || next.asset?.version !== selectedArtwork?.asset?.version) renderArtwork();
      else applyTemplate(artworkLoaded);
    });

    return { acceptSnapshot, setSyncPending, reset };
  };
})();
