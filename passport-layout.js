/* Shared, read-only passport geometry. Completion and authorization never live here. */
(() => {
  "use strict";
  const version="passport-layout-v2";
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const headerOf=asset=>({"open-stem-landscape-v1":40,"open-stem-portrait-v1":36})[asset?.layout?.profileTemplate]||22;
  const areaOf=(layout,asset)=>layout?.safeArea?{...layout.safeArea}:{x:4,y:headerOf(asset),width:92,height:96-headerOf(asset)};
  function validateArea(area,asset){
    if(!area||![area.x,area.y,area.width,area.height].every(Number.isFinite)||area.x<0||area.y<headerOf(asset)||area.width<=0||area.height<=0||area.x+area.width>100||area.y+area.height>100)return "Vùng an toàn phải nằm trong ảnh và dưới logo/họ tên/lớp.";
    return "";
  }
  function validateSlots(slots,asset,area){
    const issue=validateArea(area,asset);if(issue)return issue;
    if(!asset?.width||!asset?.height||!Array.isArray(slots)||!slots.length||slots.length>80)return "Cần 1–80 vị trí thực tế trên ảnh.";
    const ids=new Set();
    for(const slot of slots){
      if(!slot||typeof slot.slotId!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(slot.slotId)||ids.has(slot.slotId)||![slot.x,slot.y,slot.size].every(Number.isFinite)||slot.size<4||slot.size>65)return "slotId phải duy nhất; X/Y/vùng đặt dấu phải hợp lệ.";
      ids.add(slot.slotId);const rx=slot.size/2,ry=rx*asset.width/asset.height;
      if(slot.x-rx<area.x-.0001||slot.x+rx>area.x+area.width+.0001||slot.y-ry<area.y-.0001||slot.y+ry>area.y+area.height+.0001)return "Vị trí dấu vượt vùng an toàn hoặc ranh giới ảnh.";
    }
    for(let i=0;i<slots.length;i++)for(let j=0;j<i;j++)if(Math.hypot(slots[i].x-slots[j].x,(slots[i].y-slots[j].y)*asset.height/asset.width)<(slots[i].size+slots[j].size)/2-.0001)return "Hai vị trí đang trùng hoặc chồng lên nhau.";
    return "";
  }
  function bind(booths,slots,previous=[]){
    if(!slots.length)return [];
    const old=new Map(previous.map(item=>[item.boothId,item])),ids=new Set(slots.map(s=>s.slotId)),used=new Set();
    return booths.map((booth,index)=>{
      const page=Math.floor(index/slots.length)+1,prior=old.get(booth.id);
      let id=prior?.page===page&&ids.has(prior.slotId)&&!used.has(page+":"+prior.slotId)?prior.slotId:null;
      if(!id)id=slots.find(slot=>!used.has(page+":"+slot.slotId)).slotId;
      used.add(page+":"+id);return {boothId:booth.id,slotId:id,page};
    });
  }
  function adapt(raw,booths){
    const layout=clone(raw||{mode:"auto"});
    if(layout.mode!=="template")return layout;
    const legacy=(layout.slots||[]).some(s=>s.boothId&&!s.slotId);
    const previous=legacy?(layout.slots||[]).map((s,i)=>({boothId:s.boothId,slotId:"slot-"+String(i+1).padStart(2,"0"),page:1})):(layout.assignments||[]);
    layout.slots=(layout.slots||[]).map((s,i)=>({slotId:s.slotId||"slot-"+String(i+1).padStart(2,"0"),x:s.x,y:s.y,size:s.size}));
    layout.capacity=layout.slots.length;layout.assignments=bind(booths,layout.slots,previous);return layout;
  }
  function grid(count,width,height,area,device){
    const low=device==="mobile"?70:80,high=device==="mobile"?86:96,gap=10;
    const aw=width*area.width/100,ah=height*area.height/100;
    let best=null;
    for(let diameter=high;diameter>=low;diameter--){
      const cols=Math.floor((aw+gap)/(diameter+gap)),rows=Math.floor((ah+gap)/(diameter+gap)),capacity=cols*rows;
      if(!cols||!rows)continue;
      if(!best||capacity>best.capacity)best={diameter,cols,rows,capacity};
      if(capacity>=count){best={diameter,cols,rows,capacity};break;}
    }
    if(!best)return null;
    return best;
  }
  function gridItems(ids,width,height,area,shape){
    const cols=Math.min(shape.cols,Math.max(1,Math.ceil(ids.length/Math.ceil(ids.length/shape.cols))));
    const rows=Math.ceil(ids.length/cols),ax=width*area.x/100,ay=height*area.y/100,aw=width*area.width/100,ah=height*area.height/100;
    const rowHeight=ah/rows;
    return ids.map((id,index)=>{
      const row=Math.floor(index/cols),inRow=Math.min(cols,ids.length-row*cols),column=index%cols;
      return {boothId:id,x:(ax+aw*(column+.5)/inRow)/width*100,y:(ay+rowHeight*(row+.5))/height*100,sizePx:shape.diameter};
    });
  }
  function plan({booths,asset,layout,width,device="desktop"}){
    width=width|| (device==="mobile"?250:900);
    const image=asset?.width&&asset?.height?asset:{width:device==="mobile"?3:16,height:device==="mobile"?4:9};
    const height=width*image.height/image.width,normalized=adapt(layout||asset?.layout,booths),area=areaOf(normalized,asset);
    const issue=validateArea(area,asset);if(issue)return {pages:[],message:issue,mode:"invalid",area,height};
    let warning="";
    if(normalized.mode==="template"){
      const slots=normalized.slots||[],error=validateSlots(slots,image,area),min=device==="mobile"?70:80,max=device==="mobile"?90:100;
      if(!error&&slots.every(slot=>width*slot.size/100>=min-.01)){
        const assignments=bind(booths,slots,normalized.assignments),byId=new Map(slots.map(slot=>[slot.slotId,slot]));
        const pages=Array.from({length:Math.max(1,Math.ceil(booths.length/slots.length))},()=>[]);
        for(const item of assignments){const slot=byId.get(item.slotId);pages[item.page-1].push({...item,x:slot.x,y:slot.y,sizePx:Math.min(max,width*slot.size/100)});}
        return {pages,mode:"template",area,height,slots,assignments,message:booths.length>slots.length?`${booths.length} gian hàng · ${pages.length} trang (${slots.length} vị trí/trang).`:""};
      }
      warning=error||"Vị trí mẫu quá nhỏ ở màn hình này; dùng bố trí tự động có phân trang để giữ dấu dễ đọc.";
    }
    const shape=grid(booths.length,width,height,area,device);
    if(!shape)return {pages:[],mode:"invalid",area,height,message:"Vùng ảnh không đủ chứa một dấu dễ đọc. BTC cần ảnh Mobile phù hợp hoặc điều chỉnh vùng an toàn; tiến độ vẫn được giữ."};
    const pages=[];for(let start=0;start<booths.length;start+=shape.capacity)pages.push(gridItems(booths.slice(start,start+shape.capacity).map(b=>b.id),width,height,area,shape));
    if(!pages.length)pages.push([]);
    return {pages,area,height,mode:"auto",message:warning||(pages.length>1?`Vùng an toàn phù hợp ${shape.capacity} dấu/trang; chia ${pages.length} trang để giữ kích thước dễ đọc.`:""),capacity:shape.capacity};
  }
  function generate(count,asset,area,device){
    if(!Number.isInteger(count)||count<1||count>80)throw Error("Chọn từ 1 đến 80 slot thực tế.");
    const issue=validateArea(area,asset);if(issue)throw Error(issue);
    const width=device==="mobile"?250:900,height=width*asset.height/asset.width,shape=grid(count,width,height,area,device);
    if(!shape||shape.capacity<count)throw Error(`Vùng an toàn chỉ phù hợp ${shape?.capacity||0} slot dễ đọc. Giảm số slot hoặc dùng Vòng tròn tự động nhiều trang.`);
    return gridItems(Array.from({length:count},(_,i)=>"slot-"+String(i+1).padStart(2,"0")),width,height,area,shape).map(item=>({slotId:item.boothId,x:item.x,y:item.y,size:item.sizePx/width*100}));
  }
  window.FSchoolPassportLayout={version,clone,canonical,headerOf,areaOf,validateArea,validateSlots,bind,adapt,plan,generate};
})();
