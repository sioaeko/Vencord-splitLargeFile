import { definePlugin, webpack } from "@vendcord/webpack";
import { Button, Text } from "@vendcord/components";
import { useCallback, useState, useEffect } from "react";
import { Forms } from "@vendcord/ui/components";

const CHUNK_SIZE = 7.9 * 1024 * 1024;
const CHUNK_TIMEOUT = 5 * 60 * 1000;

interface FileChunk {
    index: number;
    total: number;
    data: string;
    originalName: string;
    originalSize: number;
    timestamp: number;
}

interface ChunkStorage {
    [key: string]: {
        chunks: FileChunk[];
        lastUpdated: number;
    };
}

const FileUploadStore = webpack.getModule(m => m?.upload && m?.instantBatchUpload);
const MessageActions = webpack.getModule(m => m?.sendMessage);

class ChunkManager {
    private static storage: ChunkStorage = {};

    static addChunk(chunk: FileChunk): void {
        const key = chunk.originalName;
        if (!this.storage[key]) {
            this.storage[key] = {
                chunks: [],
                lastUpdated: Date.now()
            };
        }
        this.storage[key].chunks.push(chunk);
        this.storage[key].lastUpdated = Date.now();
    }

    static getChunks(fileName: string): FileChunk[] | null {
        return this.storage[fileName]?.chunks || null;
    }

    static cleanOldChunks(): void {
        const now = Date.now();
        Object.keys(this.storage).forEach(key => {
            if (now - this.storage[key].lastUpdated > CHUNK_TIMEOUT) {
                delete this.storage[key];
            }
        });
    }
}

const SplitFileComponent = () => {
    const [status, setStatus] = useState("");
    const [isUploading, setIsUploading] = useState(false);
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        const cleanup = setInterval(() => {
            ChunkManager.cleanOldChunks();
        }, 60000);

        return () => clearInterval(cleanup);
    }, []);

    const handleFileSplit = useCallback(async (file: File) => {
        try {
            setIsUploading(true);
            const chunks: FileChunk[] = [];
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const chunk = file.slice(start, end);
                
                const base64Data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(chunk);
                });

                chunks.push({
                    index: i,
                    total: totalChunks,
                    data: base64Data,
                    originalName: file.name,
                    originalSize: file.size,
                    timestamp: Date.now()
                });
            }

            await Promise.all(chunks.map(async (chunk, index) => {
                try {
                    const chunkBlob = await fetch(chunk.data).then(r => r.blob());
                    const chunkFile = new File(
                        [chunkBlob], 
                        `${file.name}.part${chunk.index + 1}of${chunk.total}`,
                        { type: 'application/octet-stream' }
                    );
                    
                    await FileUploadStore.upload({
                        file: chunkFile,
                        message: JSON.stringify(chunk),
                        channelId: webpack.getModule(m => m?.getChannelId)?.getChannelId()
                    });

                    setProgress(Math.round(((index + 1) / totalChunks) * 100));
                } catch (error) {
                    throw new Error(`Failed to upload chunk ${index + 1}: ${error.message}`);
                }
            }));

            setStatus(`Successfully split and uploaded file into ${totalChunks} parts`);
        } catch (error) {
            setStatus(`Error: ${error.message}`);
        } finally {
            setIsUploading(false);
            setProgress(0);
        }
    }, []);

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (file.size > CHUNK_SIZE) {
            setStatus(`Preparing to split ${file.name} into chunks...`);
            await handleFileSplit(file);
        } else {
            setStatus("File is small enough to send directly");
        }
    }, [handleFileSplit]);

    const handleFileMerge = useCallback(async (chunks: FileChunk[]) => {
        try {
            chunks.sort((a, b) => a.index - b.index);
            
            const blobParts: Blob[] = [];
            for (const chunk of chunks) {
                const response = await fetch(chunk.data);
                const blob = await response.blob();
                blobParts.push(blob);
            }
            
            const finalBlob = new Blob(blobParts);
            const finalFile = new File([finalBlob], chunks[0].originalName);
            
            const url = URL.createObjectURL(finalFile);
            const a = document.createElement('a');
            a.href = url;
            a.download = finalFile.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error merging file chunks:', error);
        }
    }, []);

    return (
        <Forms.FormSection>
            <input 
                type="file" 
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                id="file-input"
            />
            <Button
                onClick={() => document.getElementById('file-input')?.click()}
                disabled={isUploading}
            >
                {isUploading ? 'Uploading...' : 'Select Large File'}
            </Button>
            {progress > 0 && <Text variant="text-sm/normal">{`Progress: ${progress}%`}</Text>}
            {status && <Text variant="text-sm/normal">{status}</Text>}
        </Forms.FormSection>
    );
};

export default definePlugin({
    name: "FileSplitter",
    description: "Split large files to bypass Discord's 8MB limit",
    authors: [
        {
            id: 1234567890n,
            name: "Your Name",
        },
    ],
    patches: [
        {
            find: "uploadFiles,",
            replacement: {
                match: /(.{1,}\.uploadFiles,)/,
                replace: "$1,FileSplitter:()=><SplitFileComponent/>,"
            }
        }
    ],

    start() {
        const originalSendMessage = MessageActions.sendMessage;
        MessageActions.sendMessage = async (...args) => {
            try {
                const content = args[1]?.content;
                if (content && typeof content === 'string' && content.startsWith("{")) {
                    const chunkData = JSON.parse(content) as FileChunk;
                    if (this.isValidChunk(chunkData)) {
                        ChunkManager.addChunk(chunkData);
                        
                        const chunks = ChunkManager.getChunks(chunkData.originalName);
                        if (chunks && chunks.length === chunkData.total) {
                            await this.handleFileMerge(chunks);
                        }
                    }
                }
            } catch (e) {
                // Not a chunk message, proceed normally
            }
            return originalSendMessage.apply(this, args);
        };
    },

    stop() {
        if (MessageActions.sendMessage.__original) {
            MessageActions.sendMessage = MessageActions.sendMessage.__original;
        }
    },

    isValidChunk(chunk: any): chunk is FileChunk {
        return (
            typeof chunk === 'object' &&
            typeof chunk.index === 'number' &&
            typeof chunk.total === 'number' &&
            typeof chunk.data === 'string' &&
            typeof chunk.originalName === 'string' &&
            typeof chunk.originalSize === 'number' &&
            typeof chunk.timestamp === 'number'
        );
    }
});
