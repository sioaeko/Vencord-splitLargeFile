import { IpcMainInvokeEvent } from "electron";

export async function fetchChunk(_: IpcMainInvokeEvent, url: string): Promise<{ status: number; data: string | null; }> {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            return { status: res.status, data: null };
        }
        const buffer = await res.arrayBuffer();
        // Convert to base64 to pass through IPC
        return { status: res.status, data: Buffer.from(buffer).toString("base64") };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}
