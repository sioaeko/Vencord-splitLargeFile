import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Button, FluxDispatcher, React, Text } from "@webpack/common";
import { addChatBarButton, removeChatBarButton, ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";

const { useState, useCallback } = React;

// Optimized chunk size. Set to 24.5MB, just under Discord's 25MB default limit for non-Nitro users.
const CHUNK_SIZE = 24.5 * 1024 * 1024;
const CHUNK_TIMEOUT = 5 * 60 * 1000; // 5-minute cache expiration for incomplete files.

/**
 * Metadata structure for a file chunk.
 * This object is JSON-stringified and sent as the message content,
 * excluding the binary payload which is sent as an attachment.
 */
interface FileChunkMetadata {
    type: "FileSplitterChunk";
    index: number;
    total: number;
    originalName: string;
    originalSize: number;
    timestamp: number;
}

/**
 * Represents a chunk stored in the local ChunkManager.
 */
interface StoredFileChunk extends FileChunkMetadata {
    url: string;
}

interface ChunkStorage {
    [key: string]: {
        chunks: StoredFileChunk[];
        lastUpdated: number;
    };
}

// --- Webpack Module Resolution ---
const UploadHandler = findByPropsLazy("upload", "instantBatchUpload");
const ChannelStore = findByPropsLazy("getChannelId");

/**
 * Manages the assembly of file chunks received from messages.
 */
class ChunkManager {
    private static storage: ChunkStorage = {};

    static addChunk(chunk: StoredFileChunk): void {
        const key = chunk.originalName;
        if (!this.storage[key]) {
            this.storage[key] = {
                chunks: [],
                lastUpdated: Date.now()
            };
        }

        if (!this.storage[key].chunks.some(c => c.index === chunk.index)) {
            this.storage[key].chunks.push(chunk);
            this.storage[key].lastUpdated = Date.now();
        }
    }

    static getChunks(fileName: string): StoredFileChunk[] | null {
        return this.storage[fileName]?.chunks || null;
    }

    static cleanOldChunks(): void {
        const now = Date.now();
        Object.keys(this.storage).forEach(key => {
            if (now - this.storage[key].lastUpdated > CHUNK_TIMEOUT) {
                delete this.storage[key];
                console.log(`[FileSplitter] Garbage collected stale chunks for: ${key}`);
            }
        });
    }
}

// --- Core Utilities ---

const isValidChunk = (chunk: any): chunk is FileChunkMetadata => {
    return (
        typeof chunk === "object" &&
        chunk.type === "FileSplitterChunk" &&
        typeof chunk.index === "number" &&
        typeof chunk.total === "number" &&
        typeof chunk.originalName === "string" &&
        typeof chunk.originalSize === "number" &&
        typeof chunk.timestamp === "number"
    );
};

const handleFileMerge = async (chunks: StoredFileChunk[]) => {
    try {
        chunks.sort((a, b) => a.index - b.index);

        const blobParts: Blob[] = [];
        for (const chunk of chunks) {
            const response = await fetch(chunk.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch chunk ${chunk.index + 1} from ${chunk.url}`);
            }
            const blob = await response.blob();
            blobParts.push(blob);
        }

        const finalBlob = new Blob(blobParts);
        const finalFile = new File([finalBlob], chunks[0].originalName);

        const url = URL.createObjectURL(finalFile);
        const a = document.createElement("a");
        a.href = url;
        a.download = finalFile.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`[FileSplitter] File merged and downloaded successfully: ${finalFile.name}`);
    } catch (error) {
        console.error("[FileSplitter] Error during file merge process:", error);
    }
};

// --- React Component: UI ---

const SplitFileComponent = () => {
    const [status, setStatus] = useState("");
    const [isUploading, setIsUploading] = useState(false);
    const [progress, setProgress] = useState(0);

    const handleFileSplit = useCallback(async (file: File) => {
        try {
            setIsUploading(true);
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);

                const chunkBlob = file.slice(start, end);

                const metadata: FileChunkMetadata = {
                    type: "FileSplitterChunk",
                    index: i,
                    total: totalChunks,
                    originalName: file.name,
                    originalSize: file.size,
                    timestamp: Date.now()
                };

                const chunkFile = new File(
                    [chunkBlob],
                    `${file.name}.part${String(i + 1).padStart(3, "0")}`,
                    { type: "application/octet-stream" }
                );

                await UploadHandler.upload({
                    file: chunkFile,
                    message: JSON.stringify(metadata),
                    channelId: ChannelStore.getChannelId()
                });

                setProgress(Math.round(((i + 1) / totalChunks) * 100));
            }

            setStatus(`Successfully uploaded ${totalChunks} parts for ${file.name}`);
        } catch (error: any) {
            setStatus(`Error: ${error.message}`);
        } finally {
            setIsUploading(false);
            setProgress(0);
        }
    }, []);

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (file.size > 500 * 1024 * 1024) {
            setStatus("File exceeds 500MB. This is not supported.");
            return;
        }

        if (file.size > CHUNK_SIZE) {
            setStatus(`Splitting ${file.name} into ~${Math.ceil(file.size / CHUNK_SIZE)} chunks...`);
            await handleFileSplit(file);
        } else {
            setStatus("File is small enough to be sent directly.");
        }

        e.target.value = "";
    }, [handleFileSplit]);

    return (
        <div style={{ padding: "8px", borderTop: "1px solid var(--background-modifier-accent)" }}>
            <input
                type="file"
                onChange={handleFileSelect}
                style={{ display: "none" }}
                id="file-splitter-input"
            />
            <Button
                onClick={() => document.getElementById("file-splitter-input")?.click()}
                disabled={isUploading}
            >
                {isUploading ? `Uploading... (${progress}%)` : "Upload Large File"}
            </Button>
            {status && (
                <Text variant="text-sm/normal" style={{ marginLeft: "8px", verticalAlign: "middle" }}>
                    {status}
                </Text>
            )}
        </div>
    );
};

// SVG icon for the chat bar button
const SplitFileIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M14 2H6C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm8-4h-4v-2h4v-2l3 3-3 3v-2z" />
    </svg>
);

// ChatBarButton render function
const SplitFileButton: ChatBarButtonFactory = () => (
    <ChatBarButton tooltip="Upload Large File" onClick={() => document.getElementById("file-splitter-input")?.click()}>
        <SplitFileIcon />
    </ChatBarButton>
);

// --- Vencord Plugin Definition ---

export default definePlugin({
    name: "FileSplitter",
    description: "Splits large files into 25MB chunks to bypass Discord's default limit.",
    authors: [
        {
            id: 1234567890n,
            name: "sioaeko",
        },
    ],

    chunkCleanupInterval: null as ReturnType<typeof setInterval> | null,

    onMessageCreate({ message }: { message: any }) {
        try {
            if (!message.content || !message.attachments?.length) return;

            const chunkData = JSON.parse(message.content);

            if (isValidChunk(chunkData)) {
                const attachment = message.attachments[0];
                if (!attachment?.url) return;

                const storedChunk: StoredFileChunk = {
                    ...chunkData,
                    url: attachment.url
                };

                ChunkManager.addChunk(storedChunk);

                const chunks = ChunkManager.getChunks(chunkData.originalName);
                if (chunks && chunks.length === chunkData.total) {
                    console.log(`[FileSplitter] All ${chunkData.total} chunks received for ${chunkData.originalName}. Initiating merge...`);
                    handleFileMerge(chunks);
                }
            }
        } catch {
            // Non-chunk messages; JSON.parse will fail, which is expected.
        }
    },

    start() {
        this.chunkCleanupInterval = setInterval(() => {
            ChunkManager.cleanOldChunks();
        }, 60000);

        FluxDispatcher.subscribe("MESSAGE_CREATE", this.onMessageCreate);
        addChatBarButton("FileSplitter", SplitFileButton, SplitFileIcon);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", this.onMessageCreate);
        removeChatBarButton("FileSplitter");
        if (this.chunkCleanupInterval) {
            clearInterval(this.chunkCleanupInterval);
        }
    }
});
