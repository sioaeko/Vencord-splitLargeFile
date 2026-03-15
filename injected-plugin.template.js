var _FS_=__DP_FN__({
name:"FileSplitter",
description:"Splits large files into 10MB chunks to bypass Discord's default limit.",
authors:[{id:1234567890n,name:"sioaeko"}],
start(){
var self=this;
var C=Vencord.Webpack.Common;
var CHUNK_SIZE=10*1024*1024;
var CHUNK_TIMEOUT=30*60*1000;
var cs={};
var mergedResults=new Map();
var processedMessageIds=new Set();
var lastRenderedVersion=new Map();
function downloadBlob(blob,filename){
var url=URL.createObjectURL(blob);
var a=document.createElement("a");
a.href=url;
a.download=filename;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
setTimeout(function(){URL.revokeObjectURL(url);},60000);
return Promise.resolve();
}
function getChunkKey(c){return c.originalName+"_"+c.timestamp;}
function normalizeAttachmentUrl(url){
if(!url)return null;
try{
var parsed=new URL(url);
if(parsed.hostname==="media.discordapp.net")parsed.hostname="cdn.discordapp.com";
return parsed.toString();
}catch{
return String(url).replace("://media.discordapp.net/","://cdn.discordapp.com/");
}}
function getAttachmentUrl(attachment){
return (attachment&&(
attachment.url||
attachment.proxy_url||
attachment.download_url||
attachment.proxyUrl||
null
))||null;
}
function parseChunkMeta(content){
try{
var c=JSON.parse(content);
if(typeof c==="object"&&c&&c.type==="FileSplitterChunk"&&typeof c.index==="number"&&typeof c.total==="number"&&typeof c.originalName==="string"&&typeof c.timestamp==="number")return c;
}catch{}
return null;
}
function getStoredMessages(channelId){
var messages=C.MessageStore.getMessages(channelId);
if(!messages)return [];
if(Array.isArray(messages))return messages;
if(typeof messages.toArray==="function")return messages.toArray();
if(typeof messages.values==="function")return Array.from(messages.values());
if(Array.isArray(messages._array))return messages._array;
if(Array.isArray(messages.array))return messages.array;
if(messages._map&&typeof messages._map.values==="function")return Array.from(messages._map.values());
return Object.values(messages).filter(function(message){return typeof (message&&message.content)==="string";});
}
var IMAGE_MIME_BY_EXTENSION={
avif:"image/avif",
bmp:"image/bmp",
gif:"image/gif",
jpeg:"image/jpeg",
jpg:"image/jpeg",
png:"image/png",
webp:"image/webp"
};
function inferMimeType(filename){
var extension=filename.split(".").pop();
if(!extension)return null;
extension=extension.toLowerCase();
return IMAGE_MIME_BY_EXTENSION[extension]||null;
}
function isInlinePreviewableImage(filename){
var mimeType=inferMimeType(filename);
return !!(mimeType&&mimeType.indexOf("image/")===0);
}
function getFileBadge(filename){
var extension=(filename.split(".").pop()||"").toLowerCase();
if(["zip","rar","7z","tar","gz"].includes(extension))return{kind:"archive",label:extension.toUpperCase()};
if(["pdf"].includes(extension))return{kind:"document",label:"PDF"};
if(["txt","md","json","csv","xml","yaml","yml"].includes(extension))return{kind:"text",label:extension.toUpperCase()};
if(["mp3","wav","flac","ogg","m4a"].includes(extension))return{kind:"audio",label:extension.toUpperCase()};
if(["mp4","mkv","avi","mov","webm"].includes(extension))return{kind:"video",label:extension.toUpperCase()};
if(["exe","msi","apk"].includes(extension))return{kind:"app",label:extension.toUpperCase()};
return{kind:"file",label:(extension||"FILE").slice(0,4).toUpperCase()};
}
function createFileIcon(kind,label){
var wrap=document.createElement("div");
wrap.style.width="52px";
wrap.style.height="52px";
wrap.style.borderRadius="12px";
wrap.style.display="grid";
wrap.style.placeItems="center";
wrap.style.flexShrink="0";
wrap.style.background="linear-gradient(135deg, var(--brand-500), var(--background-accent))";
wrap.style.color="white";
wrap.title=label;
var svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
svg.setAttribute("viewBox","0 0 24 24");
svg.setAttribute("width","26");
svg.setAttribute("height","26");
svg.setAttribute("fill","none");
svg.setAttribute("stroke","currentColor");
svg.setAttribute("stroke-width","1.9");
svg.setAttribute("stroke-linecap","round");
svg.setAttribute("stroke-linejoin","round");
function addPath(d){
var path=document.createElementNS("http://www.w3.org/2000/svg","path");
path.setAttribute("d",d);
svg.appendChild(path);
}
addPath("M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z");
addPath("M14 2v5h5");
if(kind==="archive"){
addPath("M10 10v8");
addPath("M12 10v8");
addPath("M10 12h2");
addPath("M10 15h2");
addPath("M10 18h2");
}else if(kind==="video"){
addPath("M10 10.5v5l4-2.5z");
}else if(kind==="audio"){
addPath("M10 10v6");
addPath("M14 9v5");
addPath("M10 16a1.5 1.5 0 1 1-1.5 1.5");
addPath("M14 14a1.5 1.5 0 1 1-1.5 1.5");
}else if(kind==="text"){
addPath("M9 11h6");
addPath("M9 14h6");
addPath("M9 17h4");
}else if(kind==="document"){
addPath("M9 11h6");
addPath("M9 15h6");
}else if(kind==="app"){
addPath("M9 10h6v6H9z");
}else{
addPath("M9 11h6");
addPath("M9 15h6");
addPath("M9 19h4");
}
wrap.appendChild(svg);
return wrap;
}
function getMessageElement(channelId,messageId,attachmentUrl){
var directId=document.getElementById("chat-messages-"+channelId+"-"+messageId);
if(directId)return directId;
var fallbackSelectors=[
"[data-list-item-id='chat-messages___"+channelId+"-"+messageId+"']",
"[data-message-id='"+messageId+"']",
"[id$='-"+messageId+"']"
];
for(var i=0;i<fallbackSelectors.length;i++){
var el=document.querySelector(fallbackSelectors[i]);
if(el instanceof HTMLElement)return el;
}
if(attachmentUrl){
var normalizedAttachmentUrl=normalizeAttachmentUrl(attachmentUrl);
normalizedAttachmentUrl=normalizedAttachmentUrl&&normalizedAttachmentUrl.split("?")[0];
if(!normalizedAttachmentUrl)return null;
var links=Array.from(document.querySelectorAll("a[href]"));
for(var j=0;j<links.length;j++){
var link=links[j];
var href=normalizeAttachmentUrl(link.href);
href=href&&href.split("?")[0];
if(href!==normalizedAttachmentUrl)continue;
var container=link.closest("[id^='chat-messages-'], [data-list-item-id^='chat-messages___'], li, article, [class*='message']");
if(container instanceof HTMLElement)return container;
}}
return null;
}
function getResultMount(messageEl){
var mount=messageEl.querySelector("[data-filesplitter-result-mount]");
if(mount)return mount;
var content=messageEl.querySelector("[id^='message-content-']");
var contentParent=content&&content.parentElement;
var article=messageEl.querySelector("article");
var host=contentParent||article||messageEl;
mount=document.createElement("div");
mount.dataset.filesplitterResultMount="true";
mount.style.marginTop="8px";
host.appendChild(mount);
return mount;
}
function getAnchorChunk(key){
var entry=cs[key];
if(!entry||!entry.ch.length)return null;
return entry.ch.find(function(chunk){return chunk.channelId&&chunk.messageId&&getMessageElement(chunk.channelId,chunk.messageId,chunk.url);})||
entry.ch.find(function(chunk){return chunk.channelId&&chunk.messageId;})||
null;
}
function markHidden(element){
if(element.dataset.filesplitterHidden==="true")return;
element.dataset.filesplitterHidden="true";
element.dataset.filesplitterPrevDisplay=element.style.display||"";
element.style.display="none";
}
function hideChunkMessages(key){
var entry=cs[key];
var anchorChunk=getAnchorChunk(key);
if(!entry||!entry.ch.length||!anchorChunk||!anchorChunk.messageId)return;
for(var i=0;i<entry.ch.length;i++){
var chunk=entry.ch[i];
if(!chunk.channelId||!chunk.messageId)continue;
var messageEl=getMessageElement(chunk.channelId,chunk.messageId,chunk.url);
if(!messageEl)continue;
if(chunk.messageId!==anchorChunk.messageId){
markHidden(messageEl);
continue;
}
var content=messageEl.querySelector("[id^='message-content-']");
var accessories=messageEl.querySelector("[id^='message-accessories-']");
var attachmentBlocks=messageEl.querySelectorAll("[class*='attachment'], [class*='mediaMosaic']");
var mount=getResultMount(messageEl);
var attachmentHref=normalizeAttachmentUrl(chunk.url);
attachmentHref=attachmentHref&&attachmentHref.split("?")[0];
if(content instanceof HTMLElement)markHidden(content);
if(accessories instanceof HTMLElement){
Array.from(accessories.children).forEach(function(child){
if(!(child instanceof HTMLElement))return;
if(child===mount||child.contains(mount))return;
markHidden(child);
});
}
Array.from(attachmentBlocks).forEach(function(block){
if(!(block instanceof HTMLElement))return;
if(block===mount||block.contains(mount)||mount.contains(block))return;
markHidden(block);
});
if(attachmentHref){
Array.from(messageEl.querySelectorAll("a[href]")).forEach(function(link){
if(!(link instanceof HTMLAnchorElement))return;
var href=normalizeAttachmentUrl(link.href);
href=href&&href.split("?")[0];
if(href!==attachmentHref)return;
var target=link.closest("[class*='attachment'], [class*='file'], [class*='container'], a[href]");
if(target instanceof HTMLElement&&target!==mount&&!mount.contains(target))markHidden(target);
});
}
Array.from(messageEl.querySelectorAll("div, span")).forEach(function(textNode){
if(!(textNode instanceof HTMLElement))return;
if(!/\.part\d{3}/i.test(textNode.textContent||""))return;
if(mount.contains(textNode)||textNode.contains(mount))return;
var row=textNode.closest("[class*='file'], [class*='attachment'], [class*='container'], li, article, div");
if(row instanceof HTMLElement&&row!==mount&&!mount.contains(row))markHidden(row);
});
}}
function createActionButton(label,onClick){
var button=document.createElement("button");
button.type="button";
button.textContent=label;
button.onclick=onClick;
button.style.border="none";
button.style.borderRadius="8px";
button.style.padding="8px 12px";
button.style.background="var(--button-secondary-background)";
button.style.color="var(--white-500)";
button.style.cursor="pointer";
button.style.fontSize="13px";
button.style.fontWeight="700";
button.style.lineHeight="1.2";
return button;
}
function createResultCardNode(result){
var wrapper=document.createElement("div");
wrapper.dataset.filesplitterPreview=result.key;
wrapper.dataset.filesplitterResultCard="true";
wrapper.style.marginTop="8px";
wrapper.style.width="100%";
wrapper.style.maxWidth="420px";
wrapper.style.borderRadius="12px";
wrapper.style.overflow="hidden";
wrapper.style.background="var(--background-secondary)";
wrapper.style.border="1px solid var(--background-modifier-accent)";
wrapper.style.boxShadow="0 6px 18px rgba(0, 0, 0, 0.24)";
if(result.isImage&&result.objectUrl){
var image=document.createElement("img");
image.src=result.objectUrl;
image.alt=result.originalName;
image.style.display="block";
image.style.width="100%";
image.style.maxHeight="420px";
image.style.objectFit="contain";
image.style.background="var(--background-primary)";
wrapper.appendChild(image);
}
var body=document.createElement("div");
body.style.padding="10px 12px";
body.style.display="flex";
body.style.alignItems="center";
body.style.justifyContent="space-between";
body.style.gap="12px";
body.style.background="var(--background-secondary, #23262d)";
var text=document.createElement("div");
text.style.minWidth="0";
text.style.flex="1";
text.style.display="flex";
text.style.flexDirection="column";
text.style.gap="3px";
if(!result.isImage){
var badgeInfo=getFileBadge(result.originalName);
var badge=createFileIcon(badgeInfo.kind,badgeInfo.label);
body.appendChild(badge);
}
var title=document.createElement("div");
title.textContent=result.originalName;
title.style.fontFamily="var(--font-primary, gg sans, sans-serif)";
title.style.fontSize="14px";
title.style.fontWeight="700";
title.style.lineHeight="1.25";
title.style.color="var(--text-normal, #f2f3f5)";
title.style.textShadow="0 1px 1px rgba(0, 0, 0, 0.28)";
title.style.overflow="hidden";
title.style.textOverflow="ellipsis";
title.style.whiteSpace="nowrap";
var subtitle=document.createElement("div");
subtitle.style.fontFamily="var(--font-primary, gg sans, sans-serif)";
subtitle.style.fontSize="12px";
subtitle.style.fontWeight="600";
subtitle.style.lineHeight="1.3";
subtitle.style.color="var(--channels-default, rgba(242, 243, 245, 0.72))";
subtitle.style.textShadow="0 1px 1px rgba(0, 0, 0, 0.2)";
subtitle.textContent=result.error?
"Merge failed: "+result.error:
result.isImage?(result.status==="ready"?"Merged image preview":"Preparing image preview..."):"Merged file ready to download";
text.appendChild(title);
text.appendChild(subtitle);
var actions=document.createElement("div");
actions.style.display="flex";
actions.style.gap="8px";
actions.style.flexShrink="0";
if(result.status==="error"){
actions.appendChild(createActionButton("Retry",function(){void ensureMergedResult(result.key,result.isImage);}));
}else{
var downloadButton=createActionButton("Download",function(){void handleDownload(result.key);});
downloadButton.disabled=result.status==="loading"&&!result.blob;
if(downloadButton.disabled)downloadButton.style.opacity="0.6";
actions.appendChild(downloadButton);
}
body.appendChild(text);
body.appendChild(actions);
wrapper.appendChild(body);
return wrapper;
}
function renderMergedResult(key,force){
var result=mergedResults.get(key);
var anchorChunk=getAnchorChunk(key);
if(!result||!anchorChunk||!anchorChunk.channelId||!anchorChunk.messageId)return;
var version=result.status+"|"+(result.objectUrl||"")+(result.error||"");
if(!force&&lastRenderedVersion.get(key)===version){
var existing=document.querySelector("[data-filesplitter-preview='"+key+"']");
if(existing)return;
}
var messageEl=getMessageElement(anchorChunk.channelId,anchorChunk.messageId,anchorChunk.url);
if(!messageEl)return;
var mount=getResultMount(messageEl);
if(!mount)return;
hideChunkMessages(key);
var existingCard=document.querySelector("[data-filesplitter-preview='"+key+"']");
if(existingCard)existingCard.remove();
mount.replaceChildren(createResultCardNode(result));
lastRenderedVersion.set(key,version);
}
function renderAllMergedResults(){
mergedResults.forEach(function(_,key){renderMergedResult(key);});
}
function clearMergedResults(){
document.querySelectorAll("[data-filesplitter-preview]").forEach(function(node){node.remove();});
document.querySelectorAll("[data-filesplitter-result-mount]").forEach(function(node){node.remove();});
document.querySelectorAll("[data-filesplitter-hidden='true']").forEach(function(node){
if(!(node instanceof HTMLElement))return;
node.style.display=node.dataset.filesplitterPrevDisplay||"";
delete node.dataset.filesplitterHidden;
delete node.dataset.filesplitterPrevDisplay;
});
mergedResults.forEach(function(result){
if(result.objectUrl)URL.revokeObjectURL(result.objectUrl);
});
mergedResults.clear();
lastRenderedVersion.clear();
}
async function fetchBlob(url){
if(typeof VencordNative!=="undefined"&&VencordNative.fileSplitter&&typeof VencordNative.fileSplitter.fetchBlob==="function"){
var buf=await VencordNative.fileSplitter.fetchBlob(url);
return new Blob([buf]);
}
var r=await fetch(url);
if(!r.ok)throw new Error("HTTP "+r.status);
return await r.blob();
}
async function assembleBlob(key){
var entry=cs[key];
if(!entry||!entry.ch.length)throw new Error("No chunks available");
var parts=[];
for(var i=0;i<entry.ch.length;i++){
parts.push(await fetchBlob(entry.ch[i].url));
}
var mimeType=inferMimeType(entry.ch[0].originalName)||"application/octet-stream";
return{blob:new Blob(parts,{type:mimeType}),mimeType:mimeType};
}
async function ensureMergedResult(key,eagerImagePreview){
var entry=cs[key];
if(!entry||!entry.ch.length)return;
var isImage=isInlinePreviewableImage(entry.ch[0].originalName);
var result=mergedResults.get(key);
var shouldPreparePreview=false;
if(!result){
result={
key:key,
originalName:entry.ch[0].originalName,
isImage:isImage,
mimeType:inferMimeType(entry.ch[0].originalName)||"application/octet-stream",
status:"pending"
};
mergedResults.set(key,result);
shouldPreparePreview=isImage&&eagerImagePreview;
renderMergedResult(key);
}else if(eagerImagePreview&&result.isImage&&!result.objectUrl&&result.status!=="loading"){
shouldPreparePreview=true;
}
if(!result.isImage||!shouldPreparePreview)return;
result.error=undefined;
if(result.status!=="loading"){
result.status="loading";
renderMergedResult(key);
}
try{
var assembled=await assembleBlob(key);
result.blob=assembled.blob;
result.mimeType=assembled.mimeType;
result.objectUrl=URL.createObjectURL(assembled.blob);
result.status="ready";
result.error=undefined;
}catch(e){
result.status="error";
result.error=e&&e.message?e.message:String(e);
console.error("[FileSplitter] Preview preparation failed:",e);
}
renderMergedResult(key);
}
async function handleDownload(key){
var result=mergedResults.get(key);
if(!result)return;
try{
if(!result.blob){
var assembled=await assembleBlob(key);
result.blob=assembled.blob;
result.mimeType=assembled.mimeType;
}
await downloadBlob(result.blob,result.originalName);
}catch(e){
console.error("[FileSplitter] Download failed:",e);
C.Toasts.show({message:"Download failed: "+(e&&e.message?e.message:String(e)),id:C.Toasts.genId(),type:C.Toasts.Type.FAILURE});
return;
}
C.Toasts.show({message:"Downloaded: "+result.originalName,id:C.Toasts.genId(),type:C.Toasts.Type.SUCCESS});
renderMergedResult(key);
}
function storeChunk(c,attachmentUrl){
var key=getChunkKey(c);
if(!cs[key])cs[key]={ch:[],lu:Date.now()};
if(!cs[key].ch.some(function(x){return x.index===c.index;})){
cs[key].ch.push(Object.assign({},c,{url:attachmentUrl}));
}
cs[key].lu=Date.now();
return{key:key,entry:cs[key]};
}
async function tryMergeChunks(key){
var entry=cs[key];
if(!entry||entry.mg||entry.ch.length===0)return;
var expectedCount=entry.ch[0].total;
if(entry.ch.length!==expectedCount)return;
entry.mg=true;
entry.ch.sort(function(a,b){return a.index-b.index;});
hideChunkMessages(key);
void ensureMergedResult(key,isInlinePreviewableImage(entry.ch[0].originalName));
}
function processChunk(c,attachmentUrl){
var normalizedUrl=normalizeAttachmentUrl(attachmentUrl);
if(!normalizedUrl)return;
var stored=storeChunk(c,normalizedUrl);
void tryMergeChunks(stored.key);
}
function processMessage(message){
if(!message||!message.content||!message.attachments||!message.attachments.length)return false;
if(message.id&&processedMessageIds.has(message.id))return true;
var c=parseChunkMeta(message.content);
if(!c)return false;
var attachmentUrl=getAttachmentUrl(message.attachments[0]);
if(!attachmentUrl)return false;
if(message.id)processedMessageIds.add(message.id);
processChunk(Object.assign({},c,{channelId:message.channel_id,messageId:message.id}),attachmentUrl);
return true;
}
function scanExistingMessages(channelId){
try{
var messages=getStoredMessages(channelId);
var found=0;
for(var i=0;i<messages.length;i++){
if(processMessage(messages[i]))found++;
}
if(found>0)console.log("[FileSplitter] Scanned channel, found",found,"chunks from existing messages");
Object.keys(cs).forEach(function(key){void tryMergeChunks(key);});
}catch(e){
console.error("[FileSplitter] Scan error:",e);
}}
function uploadChunk(channelId,chunkFile,metadata){
return new Promise(function(resolve,reject){
try{
var uploader=new C.CloudUploader({file:chunkFile,platform:1},channelId);
uploader.on("complete",function(){
C.RestAPI.post({
url:C.Constants.Endpoints.MESSAGES(channelId),
body:{
flags:0,
channel_id:channelId,
content:JSON.stringify(metadata),
nonce:C.SnowflakeUtils.fromTimestamp(Date.now()),
sticker_ids:[],
type:0,
attachments:[{id:"0",filename:uploader.filename,uploaded_filename:uploader.uploadedFilename}]
}
}).then(function(){resolve();}).catch(function(e){reject(new Error("Send failed: "+JSON.stringify(e)));});
});
uploader.on("error",function(e){reject(new Error("Upload failed: "+JSON.stringify(e)));});
uploader.upload();
}catch(e){
reject(new Error(e&&e.message?e.message:JSON.stringify(e)));
}});
}
var SplitIcon=function(){
return C.React.createElement("svg",{width:"24",height:"24",viewBox:"0 0 24 24",fill:"currentColor"},
C.React.createElement("path",{d:"M14 2H6C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm8-4h-4v-2h4v-2l3 3-3 3v-2z"}));
};
var SplitButton=function(){
var R=C.React;
var el=R.createElement;
var _s=R.useState(null);
var status=_s[0];
var setStatus=_s[1];
function doUpload(){
var input=document.createElement("input");
input.type="file";
input.onchange=async function(){
var file=input.files&&input.files[0];
if(!file)return;
if(file.size>500*1024*1024){
C.Toasts.show({message:"File exceeds 500MB limit.",id:C.Toasts.genId(),type:C.Toasts.Type.FAILURE});
return;
}
if(file.size<=CHUNK_SIZE){
C.Toasts.show({message:"File is small enough to send directly.",id:C.Toasts.genId(),type:C.Toasts.Type.MESSAGE});
return;
}
var totalChunks=Math.ceil(file.size/CHUNK_SIZE);
C.Toasts.show({message:"Splitting "+file.name+" into "+totalChunks+" chunks...",id:C.Toasts.genId(),type:C.Toasts.Type.MESSAGE});
setStatus("0%");
try{
var channelId=C.SelectedChannelStore.getChannelId();
var uploadTimestamp=Date.now();
for(var i=0;i<totalChunks;i++){
var start=i*CHUNK_SIZE;
var end=Math.min(start+CHUNK_SIZE,file.size);
var chunkBlob=file.slice(start,end);
var metadata={type:"FileSplitterChunk",index:i,total:totalChunks,originalName:file.name,originalSize:file.size,timestamp:uploadTimestamp};
var chunkFile=new File([chunkBlob],file.name+".part"+String(i+1).padStart(3,"0"),{type:"application/octet-stream"});
await uploadChunk(channelId,chunkFile,metadata);
setStatus(Math.round(((i+1)/totalChunks)*100)+"%");
}
C.Toasts.show({message:"Uploaded "+totalChunks+" parts for "+file.name,id:C.Toasts.genId(),type:C.Toasts.Type.SUCCESS});
setStatus(null);
}catch(e){
C.Toasts.show({message:"Error: "+(e&&e.message?e.message:JSON.stringify(e)),id:C.Toasts.genId(),type:C.Toasts.Type.FAILURE});
setStatus(null);
}};
input.click();
}
var label=status?"Uploading "+status:"Split & Upload";
return el(__CHAT_BAR_BUTTON__,{tooltip:label,onClick:status?function(){}:doUpload},el(SplitIcon,null));
};
self._cleanupInterval=setInterval(function(){
var now=Date.now();
Object.keys(cs).forEach(function(k){
if(now-cs[k].lu>CHUNK_TIMEOUT)delete cs[k];
});
},60000);
self._onMessageCreate=function(d){try{processMessage(d.message);}catch(e){console.error("[FileSplitter] Handler error:",e);}};
self._onMessageUpdate=function(d){try{if(d.message&&d.message.id)processedMessageIds.delete(d.message.id);processMessage(d.message);}catch(e){console.error("[FileSplitter] Update handler error:",e);}};
var pendingRender=null;
function scheduleRender(){
if(pendingRender)return;
pendingRender=requestAnimationFrame(function(){pendingRender=null;renderAllMergedResults();});
}
self._onLoadMessagesSuccess=function(d){if(d&&d.channelId){scanExistingMessages(d.channelId);scheduleRender();}};
self._onChannelSelect=function(d){if(d&&d.channelId){scanExistingMessages(d.channelId);scheduleRender();clearTimeout(self._delayedChannelScan);self._delayedChannelScan=setTimeout(function(){scanExistingMessages(d.channelId);scheduleRender();},1500);}};
C.FluxDispatcher.subscribe("MESSAGE_CREATE",self._onMessageCreate);
C.FluxDispatcher.subscribe("MESSAGE_UPDATE",self._onMessageUpdate);
C.FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS",self._onLoadMessagesSuccess);
C.FluxDispatcher.subscribe("CHANNEL_SELECT",self._onChannelSelect);
__ADD_CBB__("FileSplitter",SplitButton,SplitIcon);
self._clearMergedResults=clearMergedResults;
var currentChannel=C.SelectedChannelStore.getChannelId();
if(currentChannel){
scanExistingMessages(currentChannel);
scheduleRender();
self._delayedChannelScan=setTimeout(function(){scanExistingMessages(currentChannel);scheduleRender();},1500);
}
},
stop(){
var C=Vencord.Webpack.Common;
if(this._onMessageCreate)C.FluxDispatcher.unsubscribe("MESSAGE_CREATE",this._onMessageCreate);
if(this._onMessageUpdate)C.FluxDispatcher.unsubscribe("MESSAGE_UPDATE",this._onMessageUpdate);
if(this._onLoadMessagesSuccess)C.FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS",this._onLoadMessagesSuccess);
if(this._onChannelSelect)C.FluxDispatcher.unsubscribe("CHANNEL_SELECT",this._onChannelSelect);
__REMOVE_CBB__("FileSplitter");
if(this._cleanupInterval)clearInterval(this._cleanupInterval);
if(this._delayedChannelScan)clearTimeout(this._delayedChannelScan);
if(this._clearMergedResults)this._clearMergedResults();
processedMessageIds.clear();
}
});
