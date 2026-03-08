const fs = require("fs");
const path = require("path");
const { extractAll, createPackage } = require("@electron/asar");

const equicordFolder = path.join(process.env.APPDATA, "Equicord", "equicord");
const asarBak = path.join(process.env.APPDATA, "Equicord", "equicord.asar.bak");
const rendererPath = path.join(equicordFolder, "renderer.js");

// Re-extract from backup
if (fs.existsSync(equicordFolder)) fs.rmSync(equicordFolder, { recursive: true });
extractAll(asarBak, equicordFolder);
console.log("1. Extracted fresh copy from backup.");

let code = fs.readFileSync(rendererPath, "utf8");

// === Dynamic analysis ===
// definePlugin function
const dpMatch = code.match(/(\w+)\(\{name:"BadgeAPI"/);
const dpFn = dpMatch[1];

// plugins registry: XX={[YY.name]:YY,...}
const rtMatch = code.match(/(\w+)=\{(\[\w+\.name\]:\w+,){3,}/);
const rtVar = rtMatch[1];
const rtIdx = rtMatch.index;

// PluginMeta: },XX={[YY.name]:{folderName:
const piMatch = code.match(/\},(\w+)=\{\[\w+\.name\]:\{folderName:/);
const piVar = piMatch[1];

// addChatBarButton / removeChatBarButton / ChatBarButton
const cbbMatch = code.match(/(\w+)=\((\w+),(\w+),(\w+)\)=>(\w+)\.set\(\2,\{render:\3,icon:\4\}\)/);
const addCBB = cbbMatch[1]; // qw
const cbbMap = cbbMatch[5]; // ng

// Find removeChatBarButton and ChatBarButton by parsing the known pattern:
// qw=(e,t,o)=>ng.set(...),QB=e=>ng.delete(e),Jn=ee.wrap(
const cbbAreaMatch = code.match(new RegExp(`${addCBB}=.*?,(\\w+)=\\w+=>${cbbMap}\\.delete\\(\\w+\\),(\\w+)=\\w+\\.wrap`));
if (!cbbAreaMatch) { console.error("Cannot find rmCBB/chatBarBtn!"); process.exit(1); }
const rmCBB = cbbAreaMatch[1]; // QB
const chatBarBtn = cbbAreaMatch[2]; // Jn

// SelectedChannelStore
const veMatch = code.match(/(\w+)\.getChannelId\(\)/);
const channelStore = veMatch[1]; // Ve

// sendMessage - find the helper function that calls $o.sendMessage
const smMatch = code.match(/(\w+)\.sendMessage\((\w+),(\w+),(\w+),(\w+)\)/);
const msgActions = smMatch[1]; // $o

// React - find via createElement or useState
const reactMatch = code.match(/(\w+)\.useState\b/);
const reactVar = reactMatch ? reactMatch[1] : "X";

// FluxDispatcher
const fdMatch = code.match(/(\w+)\.subscribe\("MESSAGE_CREATE"/);
const fluxDisp = fdMatch ? fdMatch[1] : "J";

console.log(`   definePlugin: ${dpFn}`);
console.log(`   plugins registry: ${rtVar}`);
console.log(`   addChatBarButton: ${addCBB}, remove: ${rmCBB}`);
console.log(`   ChatBarButton: ${chatBarBtn}`);
console.log(`   ChannelStore: ${channelStore}`);
console.log(`   MessageActions: ${msgActions}`);
console.log(`   React: ${reactVar}`);
console.log(`   FluxDispatcher: ${fluxDisp}`);

// === Build plugin code ===
const pluginVar = "_FS_";
const pluginDef = `var ${pluginVar}=${dpFn}({name:"FileSplitter",description:"Splits large files into 25MB chunks to bypass Discord's default limit.",authors:[{id:1234567890n,name:"sioaeko"}],start(){var self=this;var C=Vencord.Webpack.Common;var CHUNK_SIZE=10*1024*1024;var CHUNK_TIMEOUT=5*60*1000;var cs={};self._CI=setInterval(function(){var now=Date.now();Object.keys(cs).forEach(function(k){if(now-cs[k].lu>CHUNK_TIMEOUT)delete cs[k]})},60000);self._onM=function(d){try{if(!d.message||!d.message.content||!d.message.attachments||!d.message.attachments.length)return;var c=JSON.parse(d.message.content);if(typeof c==="object"&&c.type==="FileSplitterChunk"&&typeof c.index==="number"&&typeof c.total==="number"&&typeof c.originalName==="string"){var att=d.message.attachments[0];if(!att||!att.url)return;var k=c.originalName;if(!cs[k])cs[k]={ch:[],lu:Date.now()};if(!cs[k].ch.some(function(x){return x.index===c.index})){cs[k].ch.push(Object.assign({},c,{url:att.url}));cs[k].lu=Date.now()}var all=cs[k]?cs[k].ch:null;if(all&&all.length===c.total){all.sort(function(a,b){return a.index-b.index});(async function(){try{var parts=[];for(var i=0;i<all.length;i++){var r=await fetch(all[i].url);parts.push(await r.blob())}var blob=new Blob(parts);var url=URL.createObjectURL(blob);var a=document.createElement("a");a.href=url;a.download=all[0].originalName;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);delete cs[k]}catch(e){console.error("[FileSplitter]",e)}})()}}}catch(e){}};C.FluxDispatcher.subscribe("MESSAGE_CREATE",self._onM);var SplitIcon=function(){return C.React.createElement("svg",{width:"24",height:"24",viewBox:"0 0 24 24",fill:"currentColor"},C.React.createElement("path",{d:"M14 2H6C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm8-4h-4v-2h4v-2l3 3-3 3v-2z"}))};function uploadChunk(channelId,chunkFile,metadata){return new Promise(function(resolve,reject){try{console.log("[FileSplitter] CloudUploader type:",typeof C.CloudUploader);console.log("[FileSplitter] Uploading chunk:",metadata.index+1,"/",metadata.total);var uploader=new C.CloudUploader({file:chunkFile,platform:1},channelId);console.log("[FileSplitter] Uploader created, methods:",Object.getOwnPropertyNames(Object.getPrototypeOf(uploader)).join(","));uploader.on("complete",function(){console.log("[FileSplitter] Upload complete, filename:",uploader.filename,"uploaded:",uploader.uploadedFilename);C.RestAPI.post({url:C.Constants.Endpoints.MESSAGES(channelId),body:{flags:0,channel_id:channelId,content:JSON.stringify(metadata),nonce:C.SnowflakeUtils.fromTimestamp(Date.now()),sticker_ids:[],type:0,attachments:[{id:"0",filename:uploader.filename,uploaded_filename:uploader.uploadedFilename}]}}).then(function(){console.log("[FileSplitter] Message sent!");resolve()}).catch(function(e){console.error("[FileSplitter] RestAPI error:",e);reject(new Error("Send failed: "+JSON.stringify(e)))})});uploader.on("error",function(e){console.error("[FileSplitter] Upload error event:",e);reject(new Error("Upload failed: "+JSON.stringify(e)))});uploader.upload()}catch(e){console.error("[FileSplitter] Exception:",e);reject(new Error(e&&e.message?e.message:JSON.stringify(e)))}})}var SplitButton=function(){var R=C.React;var el=R.createElement;var _s=R.useState(null);var status=_s[0];var setStatus=_s[1];function doUpload(){var input=document.createElement("input");input.type="file";input.onchange=async function(){var file=input.files[0];if(!file)return;if(file.size>500*1024*1024){C.Toasts.show({message:"File exceeds 500MB limit.",id:C.Toasts.genId(),type:C.Toasts.Type.FAILURE});return}if(file.size<=CHUNK_SIZE){C.Toasts.show({message:"File is small enough to send directly.",id:C.Toasts.genId(),type:C.Toasts.Type.MESSAGE});return}var totalChunks=Math.ceil(file.size/CHUNK_SIZE);C.Toasts.show({message:"Splitting "+file.name+" into "+totalChunks+" chunks...",id:C.Toasts.genId(),type:C.Toasts.Type.MESSAGE});setStatus("0%");try{var channelId=C.SelectedChannelStore.getChannelId();for(var i=0;i<totalChunks;i++){var start=i*CHUNK_SIZE;var end=Math.min(start+CHUNK_SIZE,file.size);var chunkBlob=file.slice(start,end);var metadata={type:"FileSplitterChunk",index:i,total:totalChunks,originalName:file.name,originalSize:file.size,timestamp:Date.now()};var chunkFile=new File([chunkBlob],file.name+".part"+String(i+1).padStart(3,"0"),{type:"application/octet-stream"});await uploadChunk(channelId,chunkFile,metadata);setStatus(Math.round(((i+1)/totalChunks)*100)+"%")}C.Toasts.show({message:"Uploaded "+totalChunks+" parts for "+file.name,id:C.Toasts.genId(),type:C.Toasts.Type.SUCCESS});setStatus(null)}catch(e){var errMsg=e&&e.message?e.message:JSON.stringify(e);C.Toasts.show({message:"Error: "+errMsg,id:C.Toasts.genId(),type:C.Toasts.Type.FAILURE});console.error("[FileSplitter] Full error:",e);setStatus(null)}};input.click()}var label=status?"Uploading "+status:"Split & Upload";return el(${chatBarBtn},{tooltip:label,onClick:status?function(){}:doUpload},el(SplitIcon,null))};${addCBB}("FileSplitter",SplitButton,SplitIcon);console.log("[FileSplitter] Started with upload UI")},stop(){var C=Vencord.Webpack.Common;if(this._onM)C.FluxDispatcher.unsubscribe("MESSAGE_CREATE",this._onM);${rmCBB}("FileSplitter");if(this._CI)clearInterval(this._CI);console.log("[FileSplitter] Stopped")}});`;

// === Inject ===
// 2. Insert plugin definition before registry
const beforeRt = code.substring(0, rtIdx);
const afterRt = code.substring(rtIdx);
code = beforeRt + pluginDef + afterRt;
console.log("2. Inserted plugin definition.");

// 3. Add to plugins registry
const newRtStart = code.indexOf(rtVar + "={", rtIdx);
const insertPos = newRtStart + rtVar.length + 2;
code = code.substring(0, insertPos) + `[${pluginVar}.name]:${pluginVar},` + code.substring(insertPos);
console.log("3. Added to plugins registry.");

// 4. Add to PluginMeta
const piSearch = piVar + "={";
const newPiStart = code.indexOf(piSearch, rtIdx);
const piInsertPos = newPiStart + piSearch.length;
code = code.substring(0, piInsertPos) + `[${pluginVar}.name]:{folderName:"src/userplugins/fileSplitter",userPlugin:true},` + code.substring(piInsertPos);
console.log("4. Added to PluginMeta.");

// Write
fs.writeFileSync(rendererPath, code);
console.log("\nDone! Full FileSplitter (with upload UI) injected.");
console.log("File size:", fs.statSync(rendererPath).size);
