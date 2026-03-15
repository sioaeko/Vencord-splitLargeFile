import definePlugin from "@utils/types";
import { addChatBarButton, removeChatBarButton, ChatBarButton } from "@api/ChatButtons";
import { findLazy } from "@webpack";
import { Constants, FluxDispatcher, MessageStore, React, RestAPI, SelectedChannelStore, SnowflakeUtils, Toasts } from "@webpack/common";

const CloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const CHUNK_TIMEOUT = 30 * 60 * 1000; // 30 minutes

interface ChunkData {
    index: number;
    total: number;
    originalName: string;
    originalSize: number;
    timestamp: number;
    url: string;
    channelId?: string;
    messageId?: string;
}

interface ChunkStorage {
    [key: string]: {
        ch: ChunkData[];
        lu: number;
        mg?: boolean;
    };
}

interface MergedResult {
    key: string;
    originalName: string;
    isImage: boolean;
    mimeType: string;
    status: "pending" | "loading" | "ready" | "error";
    blob?: Blob;
    objectUrl?: string;
    error?: string;
}

const cs: ChunkStorage = {};
const mergedResults = new Map<string, MergedResult>();

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
};

// --- Download helper: works on both Discord Desktop and Web ---
async function downloadBlob(blob: Blob, filename: string) {
    if (IS_DISCORD_DESKTOP) {
        try {
            const buffer = await blob.arrayBuffer();
            const data = new Uint8Array(buffer);
            DiscordNative.fileManager.saveWithDialog(data, filename);
        } catch (e) {
            console.warn("[FileSplitter] saveWithDialog failed, using fallback:", e);
            const url = URL.createObjectURL(blob);
            window.open(url);
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

function getChunkKey(c: Pick<ChunkData, "originalName" | "timestamp">) {
    return `${c.originalName}_${c.timestamp}`;
}

function normalizeAttachmentUrl(url: string | null | undefined) {
    if (!url) return null;

    try {
        const parsed = new URL(url);
        if (parsed.hostname === "media.discordapp.net") {
            parsed.hostname = "cdn.discordapp.com";
        }
        return parsed.toString();
    } catch {
        return url.replace("://media.discordapp.net/", "://cdn.discordapp.com/");
    }
}

function getAttachmentUrl(attachment: any) {
    return attachment?.url
        ?? attachment?.proxy_url
        ?? attachment?.download_url
        ?? attachment?.proxyUrl
        ?? null;
}

function parseChunkMeta(content: string): any | null {
    try {
        const c = JSON.parse(content);
        if (typeof c === "object" && c.type === "FileSplitterChunk" &&
            typeof c.index === "number" && typeof c.total === "number" &&
            typeof c.originalName === "string" && typeof c.timestamp === "number") {
            return c;
        }
    } catch { }
    return null;
}

function getStoredMessages(channelId: string): any[] {
    const messages = MessageStore.getMessages(channelId);
    if (!messages) return [];

    if (Array.isArray(messages)) return messages;
    if (typeof messages.toArray === "function") return messages.toArray();
    if (typeof messages.values === "function") return Array.from(messages.values());
    if (Array.isArray((messages as any)._array)) return (messages as any)._array;
    if (Array.isArray((messages as any).array)) return (messages as any).array;
    if ((messages as any)._map && typeof (messages as any)._map.values === "function") {
        return Array.from((messages as any)._map.values());
    }

    return Object.values(messages).filter((message: any) => typeof message?.content === "string");
}

function inferMimeType(filename: string) {
    const extension = filename.split(".").pop()?.toLowerCase();
    return extension ? IMAGE_MIME_BY_EXTENSION[extension] ?? null : null;
}

function isInlinePreviewableImage(filename: string) {
    const mimeType = inferMimeType(filename);
    return mimeType?.startsWith("image/") ?? false;
}

function getFileBadge(filename: string) {
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) return { kind: "archive", label: extension.toUpperCase() };
    if (["pdf"].includes(extension)) return { kind: "document", label: "PDF" };
    if (["txt", "md", "json", "csv", "xml", "yaml", "yml"].includes(extension)) return { kind: "text", label: extension.toUpperCase() };
    if (["mp3", "wav", "flac", "ogg", "m4a"].includes(extension)) return { kind: "audio", label: extension.toUpperCase() };
    if (["mp4", "mkv", "avi", "mov", "webm"].includes(extension)) return { kind: "video", label: extension.toUpperCase() };
    if (["exe", "msi", "apk"].includes(extension)) return { kind: "app", label: extension.toUpperCase() };
    return { kind: "file", label: (extension || "FILE").slice(0, 4).toUpperCase() };
}

function createFileIcon(kind: string, label: string) {
    const wrap = document.createElement("div");
    wrap.style.width = "52px";
    wrap.style.height = "52px";
    wrap.style.borderRadius = "12px";
    wrap.style.display = "grid";
    wrap.style.placeItems = "center";
    wrap.style.flexShrink = "0";
    wrap.style.background = "linear-gradient(135deg, var(--brand-500), var(--background-accent))";
    wrap.style.color = "white";
    wrap.title = label;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "26");
    svg.setAttribute("height", "26");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.9");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    const addPath = (d: string) => {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
    };

    addPath("M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z");
    addPath("M14 2v5h5");

    if (kind === "archive") {
        addPath("M10 10v8");
        addPath("M12 10v8");
        addPath("M10 12h2");
        addPath("M10 15h2");
        addPath("M10 18h2");
    } else if (kind === "video") {
        addPath("M10 10.5v5l4-2.5z");
    } else if (kind === "audio") {
        addPath("M10 10v6");
        addPath("M14 9v5");
        addPath("M10 16a1.5 1.5 0 1 1-1.5 1.5");
        addPath("M14 14a1.5 1.5 0 1 1-1.5 1.5");
    } else if (kind === "text") {
        addPath("M9 11h6");
        addPath("M9 14h6");
        addPath("M9 17h4");
    } else if (kind === "document") {
        addPath("M9 11h6");
        addPath("M9 15h6");
    } else if (kind === "app") {
        addPath("M9 10h6v6H9z");
    } else {
        addPath("M9 11h6");
        addPath("M9 15h6");
        addPath("M9 19h4");
    }

    wrap.appendChild(svg);
    return wrap;
}

function getMessageElement(channelId: string, messageId: string, attachmentUrl?: string) {
    const directId = document.getElementById(`chat-messages-${channelId}-${messageId}`);
    if (directId) return directId;

    const fallbackSelectors = [
        `[data-list-item-id="chat-messages___${channelId}-${messageId}"]`,
        `[data-message-id="${messageId}"]`,
        `[id$="-${messageId}"]`
    ];
    for (const sel of fallbackSelectors) {
        const el = document.querySelector(sel);
        if (el instanceof HTMLElement) return el;
    }

    if (attachmentUrl) {
        let normalizedAttachmentUrl = normalizeAttachmentUrl(attachmentUrl);
        normalizedAttachmentUrl = normalizedAttachmentUrl?.split("?")[0] ?? null;
        if (!normalizedAttachmentUrl) return null;

        const links = Array.from(document.querySelectorAll("a[href]"));
        for (const link of links) {
            let href = normalizeAttachmentUrl((link as HTMLAnchorElement).href);
            href = href?.split("?")[0] ?? null;
            if (href !== normalizedAttachmentUrl) continue;
            const container = link.closest("[id^='chat-messages-'], [data-list-item-id^='chat-messages___'], li, article, [class*='message']");
            if (container instanceof HTMLElement) return container;
        }
    }

    return null;
}

function getResultMount(messageEl: HTMLElement) {
    let mount = messageEl.querySelector("[data-filesplitter-result-mount]") as HTMLElement | null;
    if (mount) return mount;

    const content = messageEl.querySelector("[id^='message-content-']") as HTMLElement | null;
    const contentParent = content?.parentElement as HTMLElement | null;
    const host = contentParent
        ?? messageEl.querySelector("article") as HTMLElement | null
        ?? messageEl;

    mount = document.createElement("div");
    mount.dataset.filesplitterResultMount = "true";
    mount.style.marginTop = "8px";
    host.appendChild(mount);
    return mount;
}

function getAnchorChunk(key: string) {
    const entry = cs[key];
    if (!entry?.ch.length) return null;

    return entry.ch.find(chunk => chunk.channelId && chunk.messageId && getMessageElement(chunk.channelId, chunk.messageId, chunk.url))
        ?? entry.ch.find(chunk => chunk.channelId && chunk.messageId)
        ?? null;
}

function markHidden(element: HTMLElement) {
    if (element.dataset.filesplitterHidden === "true") return;

    element.dataset.filesplitterHidden = "true";
    element.dataset.filesplitterPrevDisplay = element.style.display || "";
    element.style.display = "none";
}

function hideChunkMessages(key: string) {
    const entry = cs[key];
    const anchorChunk = getAnchorChunk(key);
    if (!entry?.ch.length || !anchorChunk?.messageId) return;

    for (const chunk of entry.ch) {
        if (!chunk.channelId || !chunk.messageId) continue;

        const messageEl = getMessageElement(chunk.channelId, chunk.messageId, chunk.url);
        if (!messageEl) continue;

        if (chunk.messageId !== anchorChunk.messageId) {
            markHidden(messageEl);
            continue;
        }

        const content = messageEl.querySelector("[id^='message-content-']") as HTMLElement | null;
        const accessories = messageEl.querySelector("[id^='message-accessories-']") as HTMLElement | null;
        const attachmentBlocks = messageEl.querySelectorAll("[class*='attachment'], [class*='mediaMosaic']");
        const mount = getResultMount(messageEl);
        const attachmentHref = normalizeAttachmentUrl(chunk.url)?.split("?")[0];

        if (content) markHidden(content);
        if (accessories) {
            for (const child of Array.from(accessories.children)) {
                if (!(child instanceof HTMLElement)) continue;
                if (child === mount || child.contains(mount)) continue;
                markHidden(child);
            }
        }

        for (const block of Array.from(attachmentBlocks)) {
            if (!(block instanceof HTMLElement)) continue;
            if (block === mount || block.contains(mount) || mount.contains(block)) continue;
            markHidden(block);
        }

        if (attachmentHref) {
            for (const link of Array.from(messageEl.querySelectorAll("a[href]"))) {
                if (!(link instanceof HTMLAnchorElement)) continue;
                const href = normalizeAttachmentUrl(link.href)?.split("?")[0];
                if (href !== attachmentHref) continue;

                const target = link.closest("[class*='attachment'], [class*='file'], [class*='container'], a[href]") as HTMLElement | null;
                if (target && target !== mount && !mount.contains(target)) {
                    markHidden(target);
                }
            }
        }

        for (const textNode of Array.from(messageEl.querySelectorAll("div, span"))) {
            if (!(textNode instanceof HTMLElement)) continue;
            if (!/\.part\d{3}/i.test(textNode.textContent ?? "")) continue;
            if (mount.contains(textNode) || textNode.contains(mount)) continue;

            const row = textNode.closest("[class*='file'], [class*='attachment'], [class*='container'], li, article, div") as HTMLElement | null;
            if (row && row !== mount && !mount.contains(row)) {
                markHidden(row);
            }
        }
    }
}

function createActionButton(label: string, onClick: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = onClick;
    button.style.border = "none";
    button.style.borderRadius = "8px";
    button.style.padding = "8px 12px";
    button.style.background = "var(--button-secondary-background)";
    button.style.color = "var(--white-500)";
    button.style.cursor = "pointer";
    button.style.fontSize = "13px";
    button.style.fontWeight = "700";
    button.style.lineHeight = "1.2";
    return button;
}

function createResultCardNode(result: MergedResult) {
    const wrapper = document.createElement("div");
    wrapper.dataset.filesplitterPreview = result.key;
    wrapper.dataset.filesplitterResultCard = "true";
    wrapper.style.marginTop = "8px";
    wrapper.style.width = "100%";
    wrapper.style.maxWidth = "420px";
    wrapper.style.borderRadius = "12px";
    wrapper.style.overflow = "hidden";
    wrapper.style.background = "var(--background-secondary)";
    wrapper.style.border = "1px solid var(--background-modifier-accent)";
    wrapper.style.boxShadow = "0 6px 18px rgba(0, 0, 0, 0.24)";

    if (result.isImage && result.objectUrl) {
        const image = document.createElement("img");
        image.src = result.objectUrl;
        image.alt = result.originalName;
        image.style.display = "block";
        image.style.width = "100%";
        image.style.maxHeight = "420px";
        image.style.objectFit = "contain";
        image.style.background = "var(--background-primary)";
        wrapper.appendChild(image);
    }

    const body = document.createElement("div");
    body.style.padding = "10px 12px";
    body.style.display = "flex";
    body.style.alignItems = "center";
    body.style.justifyContent = "space-between";
    body.style.gap = "12px";
    body.style.background = "var(--background-secondary, #23262d)";

    const text = document.createElement("div");
    text.style.minWidth = "0";
    text.style.flex = "1";
    text.style.display = "flex";
    text.style.flexDirection = "column";
    text.style.gap = "3px";

    if (!result.isImage) {
        const badgeInfo = getFileBadge(result.originalName);
        const badge = createFileIcon(badgeInfo.kind, badgeInfo.label);
        body.appendChild(badge);
    }

    const title = document.createElement("div");
    title.textContent = result.originalName;
    title.style.fontFamily = "var(--font-primary, gg sans, sans-serif)";
    title.style.fontSize = "14px";
    title.style.fontWeight = "700";
    title.style.lineHeight = "1.25";
    title.style.color = "var(--text-normal, #f2f3f5)";
    title.style.textShadow = "0 1px 1px rgba(0, 0, 0, 0.28)";
    title.style.overflow = "hidden";
    title.style.textOverflow = "ellipsis";
    title.style.whiteSpace = "nowrap";

    const subtitle = document.createElement("div");
    subtitle.style.fontFamily = "var(--font-primary, gg sans, sans-serif)";
    subtitle.style.fontSize = "12px";
    subtitle.style.fontWeight = "600";
    subtitle.style.lineHeight = "1.3";
    subtitle.style.color = "var(--channels-default, rgba(242, 243, 245, 0.72))";
    subtitle.style.textShadow = "0 1px 1px rgba(0, 0, 0, 0.2)";
    subtitle.textContent = result.error
        ? `Merge failed: ${result.error}`
        : result.isImage
            ? result.status === "ready"
                ? "Merged image preview"
                : "Preparing image preview..."
            : "Merged file ready to download";

    text.appendChild(title);
    text.appendChild(subtitle);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.flexShrink = "0";

    if (result.status === "error") {
        actions.appendChild(createActionButton("Retry", () => {
            void ensureMergedResult(result.key, result.isImage);
        }));
    } else {
        const downloadButton = createActionButton("Download", () => {
            void handleDownload(result.key);
        });
        downloadButton.disabled = result.status === "loading" && !result.blob;
        if (downloadButton.disabled) downloadButton.style.opacity = "0.6";
        actions.appendChild(downloadButton);
    }

    body.appendChild(text);
    body.appendChild(actions);
    wrapper.appendChild(body);
    return wrapper;
}

function renderMergedResult(key: string) {
    const result = mergedResults.get(key);
    const anchorChunk = getAnchorChunk(key);
    if (!result || !anchorChunk?.channelId || !anchorChunk.messageId) return;

    const messageEl = getMessageElement(anchorChunk.channelId, anchorChunk.messageId, anchorChunk.url);
    if (!messageEl) return;

    const mount = getResultMount(messageEl);
    if (!mount) return;

    hideChunkMessages(key);
    const existing = document.querySelector(`[data-filesplitter-preview="${key}"]`);
    if (existing) existing.remove();
    mount.replaceChildren(createResultCardNode(result));
}

function renderAllMergedResults() {
    for (const key of mergedResults.keys()) {
        renderMergedResult(key);
    }
}

function clearMergedResults() {
    document.querySelectorAll("[data-filesplitter-preview]").forEach(node => node.remove());
    document.querySelectorAll("[data-filesplitter-result-mount]").forEach(node => node.remove());
    document.querySelectorAll("[data-filesplitter-hidden='true']").forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        node.style.display = node.dataset.filesplitterPrevDisplay ?? "";
        delete node.dataset.filesplitterHidden;
        delete node.dataset.filesplitterPrevDisplay;
    });

    for (const result of mergedResults.values()) {
        if (result.objectUrl) URL.revokeObjectURL(result.objectUrl);
    }
    mergedResults.clear();
}

// --- Fetch a URL as blob ---
async function fetchBlob(url: string): Promise<Blob> {
    const normalizedUrl = normalizeAttachmentUrl(url) ?? url;
    try {
        const r = await fetch(normalizedUrl);
        if (r.ok) return await r.blob();
    } catch (e) {
        console.warn("[FileSplitter] fetch failed:", e);
    }
    throw new Error("Failed to fetch chunk: " + normalizedUrl.substring(0, 80));
}

async function assembleBlob(key: string) {
    const entry = cs[key];
    if (!entry?.ch.length) throw new Error("No chunks available");

    const parts: Blob[] = [];
    for (let i = 0; i < entry.ch.length; i++) {
        parts.push(await fetchBlob(entry.ch[i].url));
    }

    const mimeType = inferMimeType(entry.ch[0].originalName) ?? "application/octet-stream";
    return {
        blob: new Blob(parts, { type: mimeType }),
        mimeType
    };
}

async function ensureMergedResult(key: string, eagerImagePreview = false) {
    const entry = cs[key];
    if (!entry?.ch.length) return;

    const isImage = isInlinePreviewableImage(entry.ch[0].originalName);
    let result = mergedResults.get(key);
    let shouldPreparePreview = false;

    if (!result) {
        result = {
            key,
            originalName: entry.ch[0].originalName,
            isImage,
            mimeType: inferMimeType(entry.ch[0].originalName) ?? "application/octet-stream",
            status: "pending"
        };
        mergedResults.set(key, result);
        shouldPreparePreview = isImage && eagerImagePreview;
        renderMergedResult(key);
    } else if (eagerImagePreview && result.isImage && !result.objectUrl && result.status !== "loading") {
        shouldPreparePreview = true;
    }

    if (!result.isImage || !shouldPreparePreview) return;

    result.error = undefined;
    if (result.status !== "loading") {
        result.status = "loading";
        renderMergedResult(key);
    }

    try {
        const { blob, mimeType } = await assembleBlob(key);
        result.blob = blob;
        result.mimeType = mimeType;
        result.objectUrl = URL.createObjectURL(blob);
        result.status = "ready";
        result.error = undefined;
    } catch (e: any) {
        result.status = "error";
        result.error = e?.message ?? String(e);
        console.error("[FileSplitter] Preview preparation failed:", e);
    }

    renderMergedResult(key);
}

async function handleDownload(key: string) {
    const result = mergedResults.get(key);
    if (!result) return;

    try {
        if (!result.blob) {
            const assembled = await assembleBlob(key);
            result.blob = assembled.blob;
            result.mimeType = assembled.mimeType;
        }

        await downloadBlob(result.blob, result.originalName);
    } catch (e: any) {
        console.error("[FileSplitter] Download failed:", e);
        Toasts.show({
            message: `Download failed: ${e?.message ?? e}`,
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    Toasts.show({
        message: `Downloaded: ${result.originalName}`,
        id: Toasts.genId(),
        type: Toasts.Type.SUCCESS
    });
    renderMergedResult(key);
}

function storeChunk(c: ChunkData, attachmentUrl: string) {
    const key = getChunkKey(c);
    if (!cs[key]) cs[key] = { ch: [], lu: Date.now() };

    if (!cs[key].ch.some(x => x.index === c.index)) {
        cs[key].ch.push({ ...c, url: attachmentUrl });
    }

    cs[key].lu = Date.now();
    return { key, entry: cs[key] };
}

async function tryMergeChunks(key: string) {
    const entry = cs[key];
    if (!entry || entry.mg || entry.ch.length === 0) return;

    const expectedCount = entry.ch[0].total;
    if (entry.ch.length !== expectedCount) return;

    entry.mg = true;
    entry.ch.sort((a, b) => a.index - b.index);

    hideChunkMessages(key);
    void ensureMergedResult(key, isInlinePreviewableImage(entry.ch[0].originalName));
}

function processChunk(c: any, attachmentUrl: string) {
    const normalizedUrl = normalizeAttachmentUrl(attachmentUrl);
    if (!normalizedUrl) return;

    const { key } = storeChunk(c, normalizedUrl);
    void tryMergeChunks(key);
}

function processMessage(message: any) {
    if (!message?.content || !message.attachments?.length) return false;

    const c = parseChunkMeta(message.content);
    if (!c) return false;

    const attachmentUrl = getAttachmentUrl(message.attachments[0]);
    if (!attachmentUrl) return false;

    processChunk({
        ...c,
        channelId: message.channel_id,
        messageId: message.id
    }, attachmentUrl);
    return true;
}

function scanExistingMessages(channelId: string) {
    try {
        const messages = getStoredMessages(channelId);
        let found = 0;
        for (const msg of messages) {
            if (processMessage(msg)) found++;
        }

        if (found > 0) {
            console.log("[FileSplitter] Scanned channel, found", found, "chunks from existing messages");
        }

        for (const key of Object.keys(cs)) {
            void tryMergeChunks(key);
        }
    } catch (e) {
        console.error("[FileSplitter] Scan error:", e);
    }
}

// --- Upload ---
function uploadChunk(channelId: string, chunkFile: File, metadata: any): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const uploader = new CloudUpload({ file: chunkFile, platform: 1 }, channelId);

            uploader.on("complete", () => {
                RestAPI.post({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    body: {
                        flags: 0,
                        channel_id: channelId,
                        content: JSON.stringify(metadata),
                        nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                        sticker_ids: [],
                        type: 0,
                        attachments: [{
                            id: "0",
                            filename: uploader.filename,
                            uploaded_filename: uploader.uploadedFilename
                        }]
                    }
                }).then(() => resolve()).catch((e: any) => reject(new Error("Send failed: " + JSON.stringify(e))));
            });

            uploader.on("error", (e: any) => reject(new Error("Upload failed: " + JSON.stringify(e))));
            uploader.upload();
        } catch (e: any) {
            reject(new Error(e?.message ?? JSON.stringify(e)));
        }
    });
}

// --- UI Components ---
const SplitIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M14 2H6C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm8-4h-4v-2h4v-2l3 3-3 3v-2z" />
    </svg>
);

const SplitButton = () => {
    const [status, setStatus] = React.useState<string | null>(null);

    function doUpload() {
        const input = document.createElement("input");
        input.type = "file";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;

            if (file.size > 500 * 1024 * 1024) {
                Toasts.show({ message: "File exceeds 500MB limit.", id: Toasts.genId(), type: Toasts.Type.FAILURE });
                return;
            }

            if (file.size <= CHUNK_SIZE) {
                Toasts.show({ message: "File is small enough to send directly.", id: Toasts.genId(), type: Toasts.Type.MESSAGE });
                return;
            }

            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            Toasts.show({ message: `Splitting ${file.name} into ${totalChunks} chunks...`, id: Toasts.genId(), type: Toasts.Type.MESSAGE });
            setStatus("0%");

            try {
                const channelId = SelectedChannelStore.getChannelId();
                const uploadTimestamp = Date.now();
                for (let i = 0; i < totalChunks; i++) {
                    const start = i * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunkBlob = file.slice(start, end);

                    const metadata = {
                        type: "FileSplitterChunk",
                        index: i,
                        total: totalChunks,
                        originalName: file.name,
                        originalSize: file.size,
                        timestamp: uploadTimestamp
                    };

                    const chunkFile = new File(
                        [chunkBlob],
                        `${file.name}.part${String(i + 1).padStart(3, "0")}`,
                        { type: "application/octet-stream" }
                    );

                    await uploadChunk(channelId, chunkFile, metadata);
                    setStatus(`${Math.round(((i + 1) / totalChunks) * 100)}%`);
                }

                Toasts.show({ message: `Uploaded ${totalChunks} parts for ${file.name}`, id: Toasts.genId(), type: Toasts.Type.SUCCESS });
                setStatus(null);
            } catch (e: any) {
                Toasts.show({ message: `Error: ${e?.message ?? JSON.stringify(e)}`, id: Toasts.genId(), type: Toasts.Type.FAILURE });
                setStatus(null);
            }
        };
        input.click();
    }

    const label = status ? `Uploading ${status}` : "Split & Upload";

    return (
        <ChatBarButton tooltip={label} onClick={status ? () => {} : doUpload}>
            <SplitIcon />
        </ChatBarButton>
    );
};

// --- Plugin Definition ---
export default definePlugin({
    name: "FileSplitter",
    description: "Splits large files into 10MB chunks to bypass Discord's default limit.",
    authors: [
        {
            id: 1234567890n,
            name: "sioaeko",
        },
    ],
    dependencies: ["ChatInputButtonAPI"],

    _onMessageCreate: undefined as any,
    _onMessageUpdate: undefined as any,
    _onLoadMessagesSuccess: undefined as any,
    _onChannelSelect: undefined as any,
    _cleanupInterval: undefined as any,
    _delayedChannelScan: undefined as any,

    start() {
        clearMergedResults();

        this._onMessageCreate = (d: any) => {
            try { processMessage(d.message); } catch (e) { console.error("[FileSplitter] MESSAGE_CREATE error:", e); }
        };
        this._onMessageUpdate = (d: any) => {
            try { processMessage(d.message); } catch (e) { console.error("[FileSplitter] MESSAGE_UPDATE error:", e); }
        };
        this._onLoadMessagesSuccess = (d: any) => {
            if (d?.channelId) {
                scanExistingMessages(d.channelId);
                renderAllMergedResults();
            }
        };
        this._onChannelSelect = (d: any) => {
            if (d?.channelId) {
                scanExistingMessages(d.channelId);
                renderAllMergedResults();
                clearTimeout(this._delayedChannelScan);
                this._delayedChannelScan = setTimeout(() => {
                    scanExistingMessages(d.channelId);
                    renderAllMergedResults();
                }, 1500);
            }
        };

        FluxDispatcher.subscribe("MESSAGE_CREATE", this._onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", this._onMessageUpdate);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", this._onLoadMessagesSuccess);
        FluxDispatcher.subscribe("CHANNEL_SELECT", this._onChannelSelect);

        addChatBarButton("FileSplitter", SplitButton, SplitIcon);

        this._cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const key of Object.keys(cs)) {
                if (now - cs[key].lu > CHUNK_TIMEOUT) delete cs[key];
            }
        }, 60000);

        const currentChannel = SelectedChannelStore.getChannelId();
        if (currentChannel) {
            scanExistingMessages(currentChannel);
            renderAllMergedResults();
            this._delayedChannelScan = setTimeout(() => {
                scanExistingMessages(currentChannel);
                renderAllMergedResults();
            }, 1500);
        }
    },

    stop() {
        if (this._onMessageCreate) FluxDispatcher.unsubscribe("MESSAGE_CREATE", this._onMessageCreate);
        if (this._onMessageUpdate) FluxDispatcher.unsubscribe("MESSAGE_UPDATE", this._onMessageUpdate);
        if (this._onLoadMessagesSuccess) FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", this._onLoadMessagesSuccess);
        if (this._onChannelSelect) FluxDispatcher.unsubscribe("CHANNEL_SELECT", this._onChannelSelect);
        removeChatBarButton("FileSplitter");
        if (this._cleanupInterval) clearInterval(this._cleanupInterval);
        if (this._delayedChannelScan) clearTimeout(this._delayedChannelScan);
        clearMergedResults();
    }
});
