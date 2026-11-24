(() => {
  "use strict";
  const kinds = ["passport", "passportMobile"];
  const maximumBytes = 1024 * 1024;
  const types = ["image/png", "image/jpeg", "image/webp"];

  function assetBlob(result) {
    if (!result?.success || !types.includes(result.mime) || typeof result.content !== "string" ||
        result.content.length > 4 * Math.ceil(maximumBytes / 3)) throw new Error("Ảnh sự kiện không khả dụng.");
    return new Blob([Uint8Array.from(atob(result.content), char => char.charCodeAt(0))], {type: result.mime});
  }

  async function prepareUpload(file) {
    if (!file || file.size > 12 * maximumBytes) throw new Error("Chọn ảnh JPEG, PNG hoặc WebP dưới 12 MB.");
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const tag = (offset, length) => String.fromCharCode(...header.slice(offset, offset + length));
    if (!((header[0] === 255 && header[1] === 216) ||
        (header[0] === 137 && tag(1, 3) === "PNG") || (tag(0, 4) === "RIFF" && tag(8, 4) === "WEBP"))) {
      throw new Error("Chỉ chấp nhận tệp ảnh JPEG, PNG hoặc WebP.");
    }
    const original = URL.createObjectURL(file), image = new Image();
    try {
      image.src = original;
      await image.decode();
      const canvas = document.createElement("canvas");
      let transparent;
      for (const limit of [2000, 1500, 1100, 800, 600, 400]) {
        const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        if (transparent === undefined) {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          transparent = false;
          for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] !== 255) { transparent = true; break; }
          }
        }
        // Store preview-friendly formats in Drive; keep alpha as PNG.
        // Existing WebP assets remain readable and accepted as input.
        const formats = transparent ? [["image/png"]] :
          header[0] === 255 ? [["image/jpeg", .88], ["image/jpeg", .76]] :
          [["image/png"], ["image/jpeg", .88], ["image/jpeg", .76]];
        for (const [mime, quality] of formats) {
          const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
          if (blob?.size && blob.size <= maximumBytes && ["image/png", "image/jpeg"].includes(blob.type)) {
            return {blob, width: canvas.width, height: canvas.height};
          }
        }
      }
      throw new Error("Không nén được ảnh xuống 1 MB. Hãy thử ảnh có độ phân giải thấp hơn.");
    } finally {
      URL.revokeObjectURL(original);
    }
  }

  async function encode(blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (let offset = 0; offset < data.length; offset += 16384) {
      text += String.fromCharCode(...data.subarray(offset, offset + 16384));
    }
    return {mime: blob.type, content: btoa(text)};
  }

  window.createEventImageManager = function (getElement, endpoint, api, refresh) {
    const card = getElement("eventImagesCard"), select = getElement("eventImagesSelect"), status = getElement("eventImagesStatus");
    const form = getElement("eventImagesForm");
    const templatePreview = getElement("eventPassportPreview");
    const publicAssets = new Map(), targets = new Map();
    const drafts = new Map();
    const previewImage = getElement("eventPassportImagePreview"), fileInput = getElement("eventPassportFile"), variant = getElement("eventPassportVariant"), profileControl=getElement("eventPassportProfileTemplate");
    const profileRenderer=window.FSchoolPassArtwork, inlineProfile=profileRenderer.createArtProfile(templatePreview);
    const previews = {passport: {}, passportMobile: {}};
    let editingKind = "passport", profileTemplates={}, profileDirty={};
    let events = [], booths = [], selected = null, revision = "", draft = {}, epoch = 0, busy = false, dirty = false;
    let optionsKey = "", boothKey = "", ready = true;

    function publicUrl(eventId, kind, version) {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({action: "GET_EVENT_IMAGE", eventId, kind, version});
      return url.href;
    }

    async function loadPublicImage(url) {
      let cache;
      try { if (window.caches) cache = await window.caches.open("fs-event-images-v1"); } catch {}
      if (cache) {
        try {
          const saved = await cache.match(url);
          if (saved && Date.now() - Number(saved.headers.get("x-fs-image-saved")) < 86400000) return await saved.blob();
          if (saved) await cache.delete(url);
        } catch {}
      }
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
      let blob;
      try {
        const response = await fetch(url, {mode: "cors", credentials: "omit", signal: controller.signal});
        if (!response.ok) throw new Error("Ảnh sự kiện không khả dụng.");
        blob = assetBlob(await response.json());
      } finally { clearTimeout(timeout); }
      if (cache) {
        try {
          await cache.put(url, new Response(blob, {headers: {"Content-Type": blob.type, "x-fs-image-saved": String(Date.now())}}));
          const keys = await cache.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - 12)).map(key => cache.delete(key)));
        } catch {}
      }
      return blob;
    }

    function backdrop(node, eventId, kind, version, done = () => {}) {
      const url = version ? publicUrl(eventId, kind, version) : "";
      const previous = targets.get(node);
      if (previous?.url === url && !(previous.result === false && Date.now() - previous.failedAt > 15000)) {
        if (previous.result !== undefined) done(previous.result);
        else previous.done = done;
        return;
      }
      node.style.removeProperty("--event-artwork");
      const target = {url, done, eventId, kind, version};
      targets.set(node, target);
      if (!url) { target.result = false; done(false); return; }
      if (!publicAssets.has(url)) {
        publicAssets.set(url, loadPublicImage(url).then(async blob => {
          const objectURL = URL.createObjectURL(blob), image = new Image();
          try {
            image.src = objectURL;
            await image.decode();
            return objectURL;
          } catch (error) {
            URL.revokeObjectURL(objectURL);
            throw error;
          }
        }).catch(() => { publicAssets.delete(url); return ""; }));
      }
      void publicAssets.get(url).then(objectURL => {
        if (targets.get(node) !== target) return;
        target.result = Boolean(objectURL);
        if (!objectURL) target.failedAt = Date.now();
        if (objectURL) node.style.setProperty("--event-artwork", 'url("' + objectURL + '")');
        target.done(target.result);
      });
    }

    const viewer = getElement("eventImageViewer"), viewerImage = getElement("eventImageViewerImage"), viewerProfile=profileRenderer.createArtProfile(getElement("eventImageViewerCanvas"));
    function closeViewer() {
      if (viewer.open) viewer.close();
      viewerImage.removeAttribute("src");
      profileRenderer.placeArtProfile(viewerProfile,null,null);
    }
    viewer.addEventListener("close", () => {viewerImage.removeAttribute("src");profileRenderer.placeArtProfile(viewerProfile,null,null);});
    getElement("eventImageViewerClose").addEventListener("click", closeViewer);
    function profileSupported() { return selected?.images?.passportProfileVersion === "passport-profile-v1"; }
    function previewAsset(kind) {
      const asset=draft[kind]||selected?.images?.[kind];
      return asset?{...asset,layout:{...asset.layout,profileTemplate:profileTemplates[kind]||""}}:null;
    }
    function mobileSupported() { return selected?.images?.passportVariantsVersion === "passport-responsive-v1"; }
    function layoutSupported(){return mobileSupported()&&profileSupported()&&selected?.images?.passportLayoutVersion===window.FSchoolPassportLayout.version;}
    const layoutEditor=window.createPassportLayoutEditor(getElement,()=>({kind:editingKind,booths,images:selected?.images,
      asset:previewAsset,supported:layoutSupported(),busy}),()=>{dirty=true;},say);
    function previewKind() {
      return templatePreview.dataset.previewMode === "mobile" && (draft.passportMobile || selected?.images?.passportMobile?.version) ? "passportMobile" : "passport";
    }
    getElement("eventPassportExpand").addEventListener("click", () => {
      const kind = previewKind(), preview = previews[kind];
      if (!selected || !preview.url) { say("Đang dùng ảnh mặc định hoặc ảnh chưa tải được."); return; }
      getElement("eventImageViewerTitle").textContent = selected.name + " · Xem trước " + (templatePreview.dataset.previewMode === "mobile" ? "Mobile" : "Desktop");
      viewerImage.src = preview.url;
      const frame = getElement("eventImageViewerCanvas");
      frame.dataset.previewMode = templatePreview.dataset.previewMode || "desktop";
      frame.style.setProperty("--preview-image-ratio",templatePreview.style.getPropertyValue("--preview-image-ratio"));
      frame.style.setProperty("--preview-art-header",templatePreview.style.getPropertyValue("--preview-art-header"));

      viewer.dataset.previewMode = templatePreview.dataset.previewMode || "desktop";
      viewer.showModal();
      layoutEditor.renderAll();
      profileRenderer.placeArtProfile(viewerProfile,previewAsset(kind),{name:"HỌC SINH MẪU",className:"10A1"});
    });

    function clearPreview(kind) {
      const preview = previews[kind];
      if (preview.url) URL.revokeObjectURL(preview.url);
      preview.url = "";
    }
    function updatePreview() {
      const kind = previewKind(), url = previews[kind].url;
      if (url) previewImage.src = url; else previewImage.removeAttribute("src");
      previewImage.hidden = !url;
      getElement("eventPassportEmpty").hidden = !!url;
      const thumbnail = getElement("eventPassportThumbnail"), editingUrl = previews[editingKind].url;
      if (editingUrl) thumbnail.src = editingUrl; else thumbnail.removeAttribute("src");
      thumbnail.hidden = !editingUrl;
      const mobile = templatePreview.dataset.previewMode === "mobile";
      const asset = previewAsset(kind);
      templatePreview.style.setProperty("--preview-image-ratio",asset?.width > 0 ? asset.width + " / " + asset.height : "16 / 9");
      templatePreview.style.setProperty("--preview-art-header",asset?.width > 0 ? ((profileRenderer.profileTemplate(asset)?.header||22) * asset.height / asset.width) + "%" : "1rem");
      profileControl.value=profileTemplates[editingKind]||"";
      profileControl.disabled=!profileSupported();
      getElement("eventPassportProfileHelp").textContent=profileSupported()?"Họ tên và lớp là chữ động, không ghi vào ảnh. Hai tệp Open STEM đã cung cấp sẽ tự chọn đúng mẫu; ảnh khác mặc định dùng thông tin riêng.":"BTC cần backend hỗ trợ passport-profile-v1 để lưu cách căn họ tên/lớp theo ảnh.";
      profileRenderer.placeArtProfile(inlineProfile,url?asset:null,{name:"HỌC SINH MẪU",className:"10A1"});
      getElement("eventPassportPreviewInfo").textContent = (mobile ? "Mobile" : "Desktop") +
        (mobile && kind === "passport" ? " · Dùng ảnh Desktop dự phòng" : " · Ảnh riêng") + ". Ảnh hiển thị đầy đủ, không cắt hoặc kéo giãn.";
      getElement("eventPassportRestore").disabled = !selected?.images?.[editingKind]?.canRestore;
      getElement("eventPassportAdvanced").hidden = false;
      getElement("eventPassportVariantStatus").textContent = !mobileSupported() ?
        "Ảnh Desktop vẫn hoạt động. BTC cập nhật backend hỗ trợ passport-responsive-v1 để lưu ảnh Mobile riêng." :
        editingKind === "passportMobile" ? "Ảnh Mobile độc lập. Nếu chưa có, học sinh dùng ảnh Desktop đầy đủ tỷ lệ; dấu xếp tự động." :
        "Ảnh Desktop là ảnh dự phòng cho Mobile. Thông tin học sinh được hiển thị riêng, không ghi lên artwork.";
      drawMarkers();
    }
    function showPreview(kind, blob) {
      clearPreview(kind);
      previews[kind].url = URL.createObjectURL(blob);
      updatePreview();
    }

    function say(message) { status.textContent = message; }

    function drawMarkers() { layoutEditor.renderAll(); }
    function buildSlots() { layoutEditor.renderControls(); }
    function rememberDraft() {
      if(selected&&dirty)drafts.set(selected.id,{revision,draft:{...draft},profileTemplates:{...profileTemplates},
        profileDirty:{...profileDirty},editorState:layoutEditor.snapshot()});
    }

    function pickEvent(event) {
      rememberDraft();
      const ticket = ++epoch;
      closeViewer();
      selected = event;
      getElement("eventPassportAdvanced").removeAttribute("open");
      revision = event?.images?.revision || "";
      dirty = false;
      profileTemplates=Object.fromEntries(kinds.map(kind=>[kind,event?.images?.[kind]?.layout?.profileTemplate||""]));profileDirty={};
      draft = {};
      say(event?.archived ? "Sự kiện lưu trữ. Ảnh chỉ hiển thị trong bản xem trước của BTC." : "");
      form.disabled = busy || !event || !ready;
      const saved = event && drafts.get(event.id);
      if (saved) {
        revision = saved.revision; draft = saved.draft;
        profileTemplates={...profileTemplates,...saved.profileTemplates};profileDirty={...saved.profileDirty};dirty = true;
        say("Đã khôi phục bản nháp của " + event.name + (revision !== (event.images?.revision || "") ? ". Ảnh trên máy chủ đã thay đổi; cần nạp lại trước khi lưu." : "."));
      }
      if (!mobileSupported()) editingKind = "passport";
      variant.value = editingKind;
      for (const option of variant.options) option.disabled = option.value === "passportMobile" && !mobileSupported();
      layoutEditor.reset(event?.images,saved?.editorState);
      for (const kind of kinds) {
        clearPreview(kind);
        fileInput.value = "";
        const asset = event?.images?.[kind];
        getElement("eventPassportEmpty").textContent =
          "Phiếu mặc định" + (event ? " · " + event.name : "");
        getElement("eventPassportRestore").disabled = !asset?.canRestore;
        if (draft[kind]) { showPreview(kind, draft[kind].blob); continue; }
        if (!asset?.version) continue;
        void api("PREVIEW_EVENT_IMAGE", {eventId: event.id, kind, version: asset.version}).then(result => {
          if (ticket === epoch && !draft[kind]) showPreview(kind, assetBlob(result));
        }).catch(() => { if (ticket === epoch && !draft[kind]) say("Không tải được bản xem trước đã lưu. Bạn có thể thay ảnh hoặc khôi phục mặc định."); });
      }
      updatePreview();
    }

    function syncAdmin(nextEvents, nextBooths, allowed, selectedEventId, contextReady = true) {
      card.hidden = !allowed;
      if (!allowed) { if (selected) pickEvent(null); return; }
      events = nextEvents;
      booths = nextBooths;
      ready = contextReady;
      const nextBoothKey = JSON.stringify(booths.map(booth => [booth.id, booth.name]));
      const nextOptions = JSON.stringify(events.map(event => [event.id, event.name, event.archived]));
      const event = events.find(item => item.id === (selectedEventId || selected?.id)) || events.find(item => item.status === "active") || events[0];
      if (optionsKey !== nextOptions) {
        optionsKey = nextOptions;
        select.replaceChildren(...events.map(item => {
          const option = document.createElement("option");
          option.value = item.id;
          option.textContent = item.name + (item.archived ? " · Lưu trữ" : "");
          return option;
        }));
        select.value = event?.id || "";
      }
      select.value = event?.id || "";
      const capabilityChanged = event?.images?.passportVariantsVersion !== selected?.images?.passportVariantsVersion || event?.images?.passportProfileVersion !== selected?.images?.passportProfileVersion || event?.images?.passportLayoutVersion !== selected?.images?.passportLayoutVersion;
      if (event?.id !== selected?.id || (!busy && capabilityChanged) || (!dirty && !busy && (event?.images?.revision || "") !== revision)) pickEvent(event);
      else if (boothKey !== nextBoothKey) buildSlots();
      boothKey = nextBoothKey;
      form.disabled = busy || !selected || !ready;
    }

    async function selectFile(kind) {
      if (kind === "passportMobile" && !mobileSupported()) { say("BTC cần cập nhật backend hỗ trợ passport-responsive-v1."); return; }
      const file = fileInput.files?.[0];
      if (!file || !selected || busy) return;
      const ticket = epoch;
      busy = true;
      form.disabled = true;
      select.disabled = true;
      say("Đang kiểm tra và nén ảnh…");
      try {
        const prepared = await prepareUpload(file);
        if (ticket !== epoch) return;
        draft[kind] = prepared;
        profileTemplates[kind]=profileSupported()?profileRenderer.uploadTemplate(file.name):"";
        profileDirty[kind]=true;
        dirty = true;
        showPreview(kind, prepared.blob);
        say(`Ảnh ${prepared.width} × ${prepared.height} px đã sẵn sàng để lưu.`);
      } catch (error) {
        if (ticket === epoch) say(error.message || "Không mở được tệp ảnh.");
      } finally {
        busy = false;
        select.disabled = false;
        form.disabled = !selected || !ready;
      }
    }

    async function save(kind, operation) {
      if (!selected || busy || !ready) return;
      if(operation==="restoreLayout"&&!layoutSupported()){say("BTC cần cập nhật Apps Script hỗ trợ passport-layout-v2 để khôi phục bố trí.");return;}
      if (kind === "passportMobile" && !mobileSupported()) { say("BTC cần cập nhật backend hỗ trợ passport-responsive-v1."); return; }
      if(profileTemplates[kind]&&!profileSupported()){say("BTC cần backend hỗ trợ passport-profile-v1.");return;}
      const event = selected, ticket = epoch;
      const image = draft[kind];
      if (operation === "save") operation = image ? "upload" : selected.images?.[kind]?.version ? (selected.images[kind].publishApproved ? "layout" : "approve") : "";
      if (!operation) { say("Hãy chọn ảnh trước khi lưu."); return; }
      let layout={mode:"auto"};
      if(["layout","upload","approve"].includes(operation)){
        try{
          if(layoutSupported())layout=layoutEditor.getLayout(kind);
          else if(layoutEditor.isDirty(kind))throw Error("BTC cần cập nhật Apps Script hỗ trợ passport-layout-v2 trước khi lưu bố trí.");
          if(profileTemplates[kind])layout.profileTemplate=profileTemplates[kind];
        }catch(error){say(error.message);return;}
      }
      const feedback=window.FSchoolUi.begin();
      busy = true;
      form.disabled = true;
      select.disabled = true;
      say("Đang lưu cấu hình ảnh…");
      try {
        const result = await api("SAVE_EVENT_IMAGE", {eventId: event.id, kind, operation, layout, expectedRevision: revision,
          ...(operation === "upload" ? {upload: await encode(image.blob)} : {})});
        if (!result.images || typeof result.images.revision !== "string" || !result.images.revision ||
            (operation !== "default" && !result.images[kind]?.version) ||
            (["upload","layout","approve"].includes(operation) && layout.profileTemplate && result.images[kind]?.layout?.profileTemplate !== layout.profileTemplate) ||
            (layout.layoutVersion && (result.images.passportLayoutVersion!==layout.layoutVersion || JSON.stringify(window.FSchoolPassportLayout.canonical(result.images[kind]?.layout))!==JSON.stringify(window.FSchoolPassportLayout.canonical(layout))))) throw new Error("Chưa đối chiếu được metadata ảnh đã lưu. Hãy nạp lại để kiểm tra trước khi gửi lại.");
        window.FSchoolUi.end(feedback,"success");
        if (ticket !== epoch) return;
        event.images = result.images;
        delete draft[kind];
        layoutEditor.committed(kind,result.images[kind]?.layout);
        delete profileDirty[kind];
        profileTemplates[kind]=result.images[kind]?.layout?.profileTemplate||"";
        revision = result.images.revision;
        dirty = layoutEditor.hasDirty() || Object.keys(draft).length > 0 || Object.values(profileDirty).some(Boolean);
        if (dirty) rememberDraft(); else drafts.delete(event.id);
        pickEvent(event);
        say(layout.layoutVersion||operation==="restoreLayout"?"Đã lưu ảnh và bố trí phiếu.":"Đã lưu ảnh.");
        void refresh(event.id, result.images).then(result => {
          if (ticket === epoch - 1 && result === false) say("Đã lưu, đang chờ đồng bộ.");
        }).catch(() => { if (selected?.id === event.id) say("Đã lưu, đang chờ đồng bộ."); });
      } catch (error) {
        window.FSchoolUi.end(feedback,"error");
        if (ticket === epoch) say(error.message);
      } finally {
        window.FSchoolUi.end(feedback);
        busy = false;
        select.disabled = false;
        form.disabled = !selected || !ready;
      }
    }

    for (const [id,operation] of [["eventPassportSave","save"],["eventPassportDefault","default"],["eventPassportRestore","restore"],["eventPassportRestoreLayout","restoreLayout"]]) {
      getElement(id).addEventListener("click", () => void save(editingKind, operation));
    }
    fileInput.addEventListener("change", () => void selectFile(editingKind));
    profileControl.addEventListener("change",()=>{
      if(busy||!profileSupported())return;
      profileTemplates[editingKind]=profileControl.value;profileDirty[editingKind]=true;dirty=true;updatePreview();layoutEditor.renderControls();
    });
    variant.addEventListener("change", () => {
      if (busy) return;
      if (variant.value === "passportMobile" && !mobileSupported()) { variant.value = editingKind; say("BTC cần cập nhật backend hỗ trợ passport-responsive-v1."); return; }
      editingKind = variant.value === "passportMobile" ? "passportMobile" : "passport";
      fileInput.value = "";
      setPreviewMode(editingKind === "passportMobile" ? "mobile" : "desktop");
      updatePreview();layoutEditor.renderControls();
    });
    select.addEventListener("change", () => typeof window.selectManagedEvent === "function" ? window.selectManagedEvent(select.value) : pickEvent(events.find(event => event.id === select.value)));
    getElement("eventImagesReload").addEventListener("click", async () => {
      if (busy) return;
      if (dirty && !confirm("Nạp lại sẽ bỏ bản nháp ảnh và vị trí của sự kiện đang chọn. Tiếp tục?")) return;
      const ticket = epoch;
      dirty = false;
      if (selected) drafts.delete(selected.id);
      busy = true;form.disabled = true;select.disabled = true;
      say("Đang nạp lại ảnh của sự kiện đang chọn…");
      try {
        const result=await refresh(selected?.id);
        if (selected && ticket === epoch) {
          if(result?.eventId!==selected.id||!result.images)throw new Error("Phản hồi ảnh không khớp sự kiện đang chọn. Hãy nạp lại.");
          selected.images=result.images;
          pickEvent(selected);
        }
      } catch(error) { if(ticket === epoch)say(error.message || "Chưa nạp được ảnh đã lưu."); }
      finally { busy=false;select.disabled=false;form.disabled=!selected||!ready; }
    });
    function setPreviewMode(value) {
      if(value==="mobile"&&!mobileSupported()){say("BTC cần cập nhật passport-responsive-v1 để cấu hình Mobile độc lập.");}
      else {editingKind=value==="mobile"?"passportMobile":"passport";variant.value=editingKind;}
      templatePreview.dataset.previewMode = value;
      getElement("eventPassportPreviewDesktop").setAttribute("aria-pressed", String(value === "desktop"));
      getElement("eventPassportPreviewMobile").setAttribute("aria-pressed", String(value === "mobile"));
      updatePreview();layoutEditor.renderControls();
    }
    for (const [id, value] of [["eventPassportPreviewDesktop", "desktop"], ["eventPassportPreviewMobile", "mobile"]]) {
      getElement(id).addEventListener("click", () => setPreviewMode(value));
    }
    window.addEventListener("online", () => {
      const retry = [...targets].filter(([, target]) => target.version && target.result === false);
      for (const [node, target] of retry) {
        publicAssets.delete(target.url);
        targets.delete(node);
      }
      for (const [node, target] of retry) backdrop(node, target.eventId, target.kind, target.version, target.done);
    });

    return {backdrop, syncAdmin, resetAdmin: () => { dirty = false; drafts.clear(); syncAdmin([], [], false); }};
  };
})();
