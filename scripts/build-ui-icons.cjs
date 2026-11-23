const fs=require("node:fs");
const path=require("node:path"), vm=require("node:vm");
// Uses the checked-in subset by default. To add icons, pass an existing official
// Lucide UMD file as the argument; this script never downloads or installs tools.
const libraryPath=path.resolve(process.argv[2] || "vendor/lucide.js");
const source=fs.readFileSync(libraryPath,"utf8"), sandbox={window:{}};
vm.runInNewContext(source,sandbox,{filename:libraryPath});
const library=sandbox.window.lucide || sandbox.lucide;
if(!library?.icons)throw Error("Expected official Lucide UMD or the local subset");
const files=["index.html","event-ui.js","event-admin.js","student-pass.js","event-roster.js","event-images.js","EventWorkflow.gs"];
const strings=files.map(f=>fs.readFileSync(f,"utf8")).join("\n");
const names=new Set(["circle-help","cloud-check","circle-check","badge-check","store","loader-circle","x","badge","shield-check","image-up"]);
for(const match of strings.matchAll(/["']([a-z][a-z0-9-]+)["']/g)){
 const name=match[1],key=name.replace(/(^|-)([a-z0-9])/g,(_,dash,ch)=>ch.toUpperCase());
 if(library.icons[key])names.add(name);
}
const icons={};
for(const name of [...names].sort()){
 const key=name.replace(/(^|-)([a-z0-9])/g,(_,dash,ch)=>ch.toUpperCase());
 if(!library.icons[key])throw Error("Missing icon "+name);
 icons[key]=library.icons[key];
}
const helpers=source.slice(source.indexOf("  const defaultAttributes ="),(source.includes("  const mergeClasses =") ? source.indexOf("  const mergeClasses =") : source.indexOf("  const icons =")));
fs.writeFileSync("vendor/lucide.js","/* Lucide v1.77.0, curated existing icon set. See vendor/LUCIDE-LICENSE.txt. */\n(() => {\n"+helpers+
"  const icons = "+JSON.stringify(icons,null,2)+";\n  window.lucide = {icons, createElement};\n})();\n");
const esc=v=>String(v).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const tag=(name,attrs,body="")=>"<"+name+" "+Object.entries(attrs).map(([k,v])=>k+'="'+esc(v)+'"').join(" ")+">"+body+"</"+name+">";
function svg(name,cls){
 const key=name.replace(/(^|-)([a-z0-9])/g,(_,dash,ch)=>ch.toUpperCase());
 const definition=icons[key];if(!definition)throw Error(name);
 return tag("svg",{xmlns:"http://www.w3.org/2000/svg",width:20,height:20,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",
  "stroke-width":2,"stroke-linecap":"round","stroke-linejoin":"round",class:"lucide "+cls,"data-lucide":name,"aria-hidden":"true",focusable:"false"},
  definition.map(([name,attrs])=>tag(name,attrs)).join(""));
}
let html=fs.readFileSync("index.html","utf8");
const split=html.indexOf('  <script src="./event-ui.js">');
let initial=html.slice(0,split),rest=html.slice(split);
initial=initial.replace(/<i data-lucide="([a-z0-9-]+)"([^>]*)><\/i>/g,(_,name,attrs)=>{
 const cls=attrs.match(/class="([^"]*)"/)?.[1]||"";
 return svg(name,cls);
});
for(const [field,name,label] of [["studentCodeInput","badge","Mã học sinh"],["studentAccessInput","key-round","Mã truy cập sự kiện"],
 ["teacherEmailInput","mail","Email công vụ"],["teacherOtpInput","shield-check","Mã OTP (6 số trong Gmail)"]]){
 initial=initial.replace(new RegExp('(<label for="'+field+'"[^>]*>)'+label+'(</label>)'),
 '$1<span class="ui-label-caption">'+svg(name,"ui-icon-small")+label+'</span>$2');
}
for(const [id,name] of [["sendOtpButton","mail"],["verifyOtpButton","shield-check"]]){
 const regex=new RegExp('(<button id="'+id+'"[^>]*>)([^<]+)(</button>)');
 initial=initial.replace(regex,(_,open,label,close)=>open+svg(name,"ui-action-icon ui-icon-small")+label+close);
}
fs.writeFileSync("index.html",initial+rest);
console.log("Curated",Object.keys(icons).length,"Lucide icons,",fs.statSync("vendor/lucide.js").size,"bytes.");
