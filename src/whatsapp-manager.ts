import { EventEmitter } from "events";
import path from "path";
import fs from "fs";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "@whiskeysockets/baileys";
import QRCode from "qrcode";

export type WaStatus = "disconnected" | "connecting" | "connected" | "qr";

export interface WaContactInfo {
  jid: string;
  name?: string;
  notify?: string;
  phone?: string;
  isGroup?: boolean;
}

export interface WaGroupInfo {
  id: string;
  subject: string;
  size?: number;
  participants?: string[];
}

export interface WaManagerState {
  status: WaStatus;
  qrBase64: string | null;
  qrString: string | null;
  phone: string | null;
  name: string | null;
  contacts: WaContactInfo[];
  groups: WaGroupInfo[];
  error: string | null;
}

export interface WaSendMessage {
  type: "text" | "image" | "video" | "audio" | "document";
  text?: string;
  mediaData?: string; // base64
  mimetype?: string;
  fileName?: string;
  linkPreview?: boolean;
}

class WhatsAppManager extends EventEmitter {
  private sock: any = null;
  private state: WaManagerState = {
    status: "disconnected",
    qrBase64: null,
    qrString: null,
    phone: null,
    name: null,
    contacts: [],
    groups: [],
    error: null,
  };
  private authDir: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;

  constructor() {
    super();
    this.setMaxListeners(100);
    this.authDir = path.join(process.cwd(), "wa_auth");
    fs.mkdirSync(this.authDir, { recursive: true });
  }

  getState(): WaManagerState {
    return { ...this.state };
  }

  private setState(patch: Partial<WaManagerState>) {
    this.state = { ...this.state, ...patch };
    this.emit("state_change", this.state);
  }

  onStateChange(listener: (state: WaManagerState) => void) {
    this.on("state_change", listener);
  }

  offStateChange(listener: (state: WaManagerState) => void) {
    this.off("state_change", listener);
  }

  async connect(): Promise<void> {
    if (this.isConnecting) return;
    if (this.state.status === "connected") return;

    this.isConnecting = true;
    this.setState({ status: "connecting", error: null });

    try {
      const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: authState,
        printQRInTerminal: true,
        browser: Browsers.macOS("Desktop"),
        connectTimeoutMs: 30000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 3,
      });

      this.sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const base64 = await QRCode.toDataURL(qr, {
              width: 280,
              margin: 2,
              color: { dark: "#000000", light: "#ffffff" },
            });
            this.setState({
              status: "qr",
              qrBase64: base64,
              qrString: qr,
            });
          } catch (e) {
            console.error("[WA] QR generation failed:", e);
          }
        }

        if (connection === "open") {
          const me = this.sock.user;
          const phone = me?.id?.split(":")?.[0]?.split("@")?.[0] ?? null;
          this.setState({
            status: "connected",
            qrBase64: null,
            qrString: null,
            phone,
            name: me?.name ?? null,
            error: null,
          });
          this.isConnecting = false;
          
          setTimeout(() => this.loadContactsAndGroups(), 2000);
        }

        if (connection === "close") {
          const code = (lastDisconnect?.error as any)?.output?.statusCode;
          const reason = DisconnectReason;
          const shouldReconnect = code !== reason.loggedOut;

          this.setState({
            status: "disconnected",
            qrBase64: null,
            qrString: null,
            error: shouldReconnect ? null : "Logged out from WhatsApp",
          });
          this.isConnecting = false;
          this.sock = null;

          if (shouldReconnect) {
            this.reconnectTimer = setTimeout(() => this.connect(), 5000);
          } else {
            this.clearAuth();
          }
        }
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("contacts.upsert", (contacts: any[]) => {
        const mapped: WaContactInfo[] = contacts.map((c) => ({
          jid: c.id,
          name: c.name,
          notify: c.notify,
          phone: c.id?.split("@")?.[0],
          isGroup: c.id?.endsWith("@g.us") ?? false,
        }));
        const existing = new Map(this.state.contacts.map((c) => [c.jid, c]));
        mapped.forEach((c) => existing.set(c.jid, c));
        this.setState({ contacts: Array.from(existing.values()) });
      });

      this.sock.ev.on("contacts.update", (updates: any[]) => {
        const existing = new Map(this.state.contacts.map((c) => [c.jid, c]));
        updates.forEach((u) => {
          const prev = existing.get(u.id) ?? { jid: u.id };
          existing.set(u.id, { ...prev, ...u, jid: u.id });
        });
        this.setState({ contacts: Array.from(existing.values()) });
      });

      this.sock.ev.on("groups-upsert", (groups: any[]) => {
        const mapped: WaGroupInfo[] = groups.map((g) => ({
          id: g.id,
          subject: g.subject,
          size: g.size,
          participants: g.participants?.map((p: any) => p.id),
        }));
        const existing = new Map(this.state.groups.map((g) => [g.id, g]));
        mapped.forEach((g) => existing.set(g.id, g));
        this.setState({ groups: Array.from(existing.values()) });
      });
    } catch (err: any) {
      console.error("[WA] Connection error:", err);
      this.setState({ status: "disconnected", error: err.message });
      this.isConnecting = false;
    }
  }

  private async loadContactsAndGroups() {
    if (!this.sock) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const mapped: WaGroupInfo[] = Object.values(groups).map((g: any) => ({
        id: g.id,
        subject: g.subject,
        size: g.participants?.length,
        participants: g.participants?.map((p: any) => p.id),
      }));
      this.setState({ groups: mapped });
    } catch (err) {
      console.warn("[WA] Could not load groups:", err);
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (_) {}
      this.sock = null;
    }
    this.clearAuth();
    this.setState({
      status: "disconnected",
      qrBase64: null,
      qrString: null,
      phone: null,
      name: null,
      contacts: [],
      groups: [],
      error: null,
    });
    this.isConnecting = false;
  }

  async sendMessage(jid: string, message: WaSendMessage): Promise<boolean> {
    if (!this.sock || this.state.status !== "connected") {
      throw new Error("WhatsApp not connected");
    }
    try {
      if (message.type === "text") {
        await this.sock.sendMessage(jid, {
          text: message.text ?? "",
          ...(message.linkPreview !== false ? {} : { linkPreview: false }),
        });
      } else if (message.type === "image" && message.mediaData) {
        await this.sock.sendMessage(jid, {
          image: Buffer.from(message.mediaData, "base64"),
          caption: message.text ?? "",
          mimetype: message.mimetype ?? "image/jpeg",
        });
      } else if (message.type === "video" && message.mediaData) {
        await this.sock.sendMessage(jid, {
          video: Buffer.from(message.mediaData, "base64"),
          caption: message.text ?? "",
          mimetype: message.mimetype ?? "video/mp4",
        });
      } else if (message.type === "audio" && message.mediaData) {
        await this.sock.sendMessage(jid, {
          audio: Buffer.from(message.mediaData, "base64"),
          mimetype: message.mimetype ?? "audio/ogg; codecs=opus",
          ptt: true,
        });
      } else if (message.type === "document" && message.mediaData) {
        await this.sock.sendMessage(jid, {
          document: Buffer.from(message.mediaData, "base64"),
          mimetype: message.mimetype ?? "application/octet-stream",
          fileName: message.fileName ?? "file",
          caption: message.text ?? "",
        });
      }
      return true;
    } catch (err: any) {
      console.error("[WA] Send error:", err);
      return false;
    }
  }

  isConnected(): boolean {
    return this.state.status === "connected";
  }

  private clearAuth() {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      fs.mkdirSync(this.authDir, { recursive: true });
    } catch (_) {}
  }
}

let managerInstance: WhatsAppManager | null = null;

export function getWaManager(): WhatsAppManager {
  if (!managerInstance) {
    managerInstance = new WhatsAppManager();
  }
  return managerInstance;
}
