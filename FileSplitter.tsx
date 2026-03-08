import definePlugin from "@utils/types";
import { addChatBarButton, removeChatBarButton, ChatBarButton } from "@api/ChatButtons";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { Constants, FluxDispatcher, React, RestAPI, SelectedChannelStore, SnowflakeUtils, Toasts } from "@webpack/common";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const CHUNK_TIMEOUT = 5 * 60 * 1000;

interface ChunkStorage {
    [key: string]: {
        ch: { index: number; total: number; originalName: string; originalSize: number; timestamp: number; url: string; }[];
        lu: number;
    };
}

const cs: ChunkStorage = {};

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
                }).then(() => {
                    resolve();
                }).catch((e: any) => {
                    reject(new Error("Send failed: " + JSON.stringify(e)));
                });
            });

            uploader.on("error", (e: any) => {
                reject(new Error("Upload failed: " + JSON.stringify(e)));
            });

            uploader.upload();
        } catch (e: any) {
            reject(new Error(e?.message ?? JSON.stringify(e)));
        }
    });
}

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
                Toasts.show({
                    message: "File exceeds 500MB limit.",
                    id: Toasts.genId(),
                    type: Toasts.Type.FAILURE
                });
                return;
            }

            if (file.size <= CHUNK_SIZE) {
                Toasts.show({
                    message: "File is small enough to send directly.",
                    id: Toasts.genId(),
                    type: Toasts.Type.MESSAGE
                });
                return;
            }

            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            Toasts.show({
                message: `Splitting ${file.name} into ${totalChunks} chunks...`,
                id: Toasts.genId(),
                type: Toasts.Type.MESSAGE
            });
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

                Toasts.show({
                    message: `Uploaded ${totalChunks} parts for ${file.name}`,
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS
                });
                setStatus(null);
            } catch (e: any) {
                Toasts.show({
                    message: `Error: ${e?.message ?? JSON.stringify(e)}`,
                    id: Toasts.genId(),
                    type: Toasts.Type.FAILURE
                });
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
    _cleanupInterval: undefined as any,

    start() {
        this._cleanupInterval = setInterval(() => {
            const now = Date.now();
            Object.keys(cs).forEach(k => {
                if (now - cs[k].lu > CHUNK_TIMEOUT) delete cs[k];
            });
        }, 60000);

        this._onMessageCreate = (d: any) => {
            try {
                if (!d.message?.content || !d.message?.attachments?.length) return;
                const c = JSON.parse(d.message.content);

                if (typeof c === "object" && c.type === "FileSplitterChunk" &&
                    typeof c.index === "number" && typeof c.total === "number" &&
                    typeof c.originalName === "string") {

                    const att = d.message.attachments[0];
                    if (!att?.url) return;

                    const k = c.originalName + "_" + c.timestamp;
                    if (!cs[k]) cs[k] = { ch: [], lu: Date.now() };

                    if (!cs[k].ch.some(x => x.index === c.index)) {
                        cs[k].ch.push({ ...c, url: att.url });
                        cs[k].lu = Date.now();
                    }

                    const all = cs[k]?.ch;
                    if (all && all.length === c.total) {
                        all.sort((a, b) => a.index - b.index);
                        (async () => {
                            try {
                                const parts: Blob[] = [];
                                for (let i = 0; i < all.length; i++) {
                                    const r = await fetch(all[i].url);
                                    parts.push(await r.blob());
                                }
                                const blob = new Blob(parts);
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = all[0].originalName;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                                delete cs[k];

                                Toasts.show({
                                    message: `Merged and downloaded: ${all[0].originalName}`,
                                    id: Toasts.genId(),
                                    type: Toasts.Type.SUCCESS
                                });
                            } catch (e) {
                                console.error("[FileSplitter]", e);
                            }
                        })();
                    }
                }
            } catch { }
        };

        FluxDispatcher.subscribe("MESSAGE_CREATE", this._onMessageCreate);
        addChatBarButton("FileSplitter", SplitButton, SplitIcon);
    },

    stop() {
        if (this._onMessageCreate) FluxDispatcher.unsubscribe("MESSAGE_CREATE", this._onMessageCreate);
        removeChatBarButton("FileSplitter");
        if (this._cleanupInterval) clearInterval(this._cleanupInterval);
    }
});
