import definePlugin, { PluginNative } from "@utils/types";
import { addChatBarButton, removeChatBarButton, ChatBarButton } from "@api/ChatButtons";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { Constants, FluxDispatcher, MessageStore, React, RestAPI, SelectedChannelStore, SnowflakeUtils, Toasts } from "@webpack/common";

const Native = VencordNative.pluginHelpers.FileSplitter as PluginNative<typeof import("./native")>;

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const CHUNK_TIMEOUT = 30 * 60 * 1000; // 30 minutes (increased from 5min for slow uploads)

interface ChunkData {
    index: number;
    total: number;
    originalName: string;
    originalSize: number;
    timestamp: number;
    url: string;
}

interface ChunkStorage {
    [key: string]: {
        ch: ChunkData[];
        lu: number;
    };
}

const cs: ChunkStorage = {};

// --- Download helper: works on both Discord Desktop and Web ---
async function downloadBlob(blob: Blob, filename: string) {
    if (IS_DISCORD_DESKTOP) {
        try {
            const buffer = await blob.arrayBuffer();
            const data = new Uint8Array(buffer);
            DiscordNative.fileManager.saveWithDialog(data, filename);
        } catch (e) {
            // Fallback: open blob URL in new tab
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

// --- Try to parse chunk metadata from message content ---
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

// --- Fetch a URL as blob ---
async function fetchBlob(url: string): Promise<Blob> {
    // Method 1: Native IPC (main process fetch, bypasses CSP)
    if (IS_DISCORD_DESKTOP) {
        try {
            const result = await Native.fetchChunk(url);
            if (result.status >= 200 && result.status < 300 && result.data) {
                const binary = atob(result.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return new Blob([bytes]);
            }
            console.warn("[FileSplitter] Native fetch returned", result.status, result.data?.substring(0, 100));
        } catch (e) {
            console.warn("[FileSplitter] Native fetch failed:", e);
        }
    }

    // Method 2: direct fetch (works on web)
    try {
        const r = await fetch(url);
        if (r.ok) return await r.blob();
        console.warn("[FileSplitter] fetch returned", r.status);
    } catch (e) {
        console.warn("[FileSplitter] fetch failed:", e);
    }

    throw new Error("All fetch methods failed for: " + url.substring(0, 80));
}

// --- Process a single chunk message ---
function processChunk(c: any, attachmentUrl: string) {
    const k = c.originalName + "_" + c.timestamp;
    if (!cs[k]) cs[k] = { ch: [], lu: Date.now() };

    if (!cs[k].ch.some(x => x.index === c.index)) {
        cs[k].ch.push({ ...c, url: attachmentUrl });
        cs[k].lu = Date.now();
    }

    console.log("[FileSplitter] Chunk", c.index + 1, "/", c.total, "for", c.originalName, "| collected:", cs[k].ch.length);

    const all = cs[k]?.ch;
    if (all && all.length === c.total) {
        console.log("[FileSplitter] All chunks received! Merging...");
        all.sort((a, b) => a.index - b.index);

        Toasts.show({
            message: `Merging ${c.total} parts of ${c.originalName}...`,
            id: Toasts.genId(),
            type: Toasts.Type.MESSAGE
        });

        (async () => {
            try {
                const parts: Blob[] = [];
                for (let i = 0; i < all.length; i++) {
                    console.log("[FileSplitter] Fetching chunk", i + 1, "url:", all[i].url.substring(0, 80));
                    parts.push(await fetchBlob(all[i].url));
                }

                const blob = new Blob(parts);
                await downloadBlob(blob, all[0].originalName);
                delete cs[k];

                Toasts.show({
                    message: `Merged and downloaded: ${all[0].originalName}`,
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS
                });
            } catch (e: any) {
                console.error("[FileSplitter] Merge error:", e);
                Toasts.show({
                    message: `Merge failed: ${e?.message ?? e}`,
                    id: Toasts.genId(),
                    type: Toasts.Type.FAILURE
                });
            }
        })();
    }
}

// --- Scan existing messages in channel for chunks ---
function scanExistingMessages(channelId: string) {
    try {
        const messages = MessageStore.getMessages(channelId)?.toArray?.() ?? [];
        let found = 0;
        for (const msg of messages) {
            if (!msg.content || !msg.attachments?.length) continue;
            const c = parseChunkMeta(msg.content);
            if (!c) continue;
            const att = msg.attachments[0];
            if (!att?.url) continue;

            const k = c.originalName + "_" + c.timestamp;
            if (!cs[k]) cs[k] = { ch: [], lu: Date.now() };
            if (!cs[k].ch.some(x => x.index === c.index)) {
                cs[k].ch.push({ ...c, url: att.url });
                cs[k].lu = Date.now();
                found++;
            }
        }

        if (found > 0) {
            console.log("[FileSplitter] Scanned channel, found", found, "chunks from existing messages");
            for (const k of Object.keys(cs)) {
                const entry = cs[k];
                if (entry.ch.length > 0 && entry.ch.length === entry.ch[0].total) {
                    processChunk(entry.ch[0], entry.ch[0].url);
                }
            }
        }
    } catch (e) {
        console.error("[FileSplitter] Scan error:", e);
    }
}

// --- Upload ---
function uploadChunk(channelId: string, chunkFile: File, metadata: any): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const uploader = new CloudUpload({ file: chunkFile, platform: CloudUploadPlatform.WEB }, channelId);

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

    _onMessageCreate: undefined as any,
    _onChannelSelect: undefined as any,
    _cleanupInterval: undefined as any,

    start() {
        // Garbage collection interval
        this._cleanupInterval = setInterval(() => {
            const now = Date.now();
            Object.keys(cs).forEach(k => {
                if (now - cs[k].lu > CHUNK_TIMEOUT) {
                    console.log("[FileSplitter] Expired chunks for:", k);
                    delete cs[k];
                }
            });
        }, 60000);

        // Real-time chunk detection
        this._onMessageCreate = (d: any) => {
            try {
                if (!d.message?.content || !d.message?.attachments?.length) return;
                const c = parseChunkMeta(d.message.content);
                if (!c) return;

                const att = d.message.attachments[0];
                if (!att?.url) return;

                processChunk(c, att.url);
            } catch (e) {
                console.error("[FileSplitter] Handler error:", e);
            }
        };

        // Scan existing messages when switching channels
        this._onChannelSelect = (d: any) => {
            if (d.channelId) {
                scanExistingMessages(d.channelId);
            }
        };

        FluxDispatcher.subscribe("MESSAGE_CREATE", this._onMessageCreate);
        FluxDispatcher.subscribe("CHANNEL_SELECT", this._onChannelSelect);
        addChatBarButton("FileSplitter", SplitButton, SplitIcon);

        // Scan current channel on plugin start
        const currentChannel = SelectedChannelStore.getChannelId();
        if (currentChannel) scanExistingMessages(currentChannel);
    },

    stop() {
        if (this._onMessageCreate) FluxDispatcher.unsubscribe("MESSAGE_CREATE", this._onMessageCreate);
        if (this._onChannelSelect) FluxDispatcher.unsubscribe("CHANNEL_SELECT", this._onChannelSelect);
        removeChatBarButton("FileSplitter");
        if (this._cleanupInterval) clearInterval(this._cleanupInterval);
    }
});
