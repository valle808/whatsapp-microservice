"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWaManager = getWaManager;
const events_1 = require("events");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const baileys_1 = require("@whiskeysockets/baileys");
const qrcode_1 = __importDefault(require("qrcode"));
class WhatsAppManager extends events_1.EventEmitter {
    sock = null;
    state = {
        status: "disconnected",
        qrBase64: null,
        qrString: null,
        phone: null,
        name: null,
        contacts: [],
        groups: [],
        error: null,
    };
    authDir;
    reconnectTimer = null;
    isConnecting = false;
    constructor() {
        super();
        this.setMaxListeners(100);
        this.authDir = path_1.default.join(process.cwd(), "wa_auth");
        fs_1.default.mkdirSync(this.authDir, { recursive: true });
    }
    getState() {
        return { ...this.state };
    }
    setState(patch) {
        this.state = { ...this.state, ...patch };
        this.emit("state_change", this.state);
    }
    onStateChange(listener) {
        this.on("state_change", listener);
    }
    offStateChange(listener) {
        this.off("state_change", listener);
    }
    async connect() {
        if (this.isConnecting)
            return;
        if (this.state.status === "connected")
            return;
        this.isConnecting = true;
        this.setState({ status: "connecting", error: null });
        try {
            const { state: authState, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(this.authDir);
            const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
            this.sock = (0, baileys_1.makeWASocket)({
                version,
                auth: authState,
                printQRInTerminal: true,
                browser: baileys_1.Browsers.macOS("Desktop"),
                connectTimeoutMs: 30000,
                retryRequestDelayMs: 2000,
                maxMsgRetryCount: 3,
            });
            this.sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;
                if (qr) {
                    try {
                        const base64 = await qrcode_1.default.toDataURL(qr, {
                            width: 280,
                            margin: 2,
                            color: { dark: "#000000", light: "#ffffff" },
                        });
                        this.setState({
                            status: "qr",
                            qrBase64: base64,
                            qrString: qr,
                        });
                    }
                    catch (e) {
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
                    const code = lastDisconnect?.error?.output?.statusCode;
                    const reason = baileys_1.DisconnectReason;
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
                    }
                    else {
                        this.clearAuth();
                    }
                }
            });
            this.sock.ev.on("creds.update", saveCreds);
            this.sock.ev.on("contacts.upsert", (contacts) => {
                const mapped = contacts.map((c) => ({
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
            this.sock.ev.on("contacts.update", (updates) => {
                const existing = new Map(this.state.contacts.map((c) => [c.jid, c]));
                updates.forEach((u) => {
                    const prev = existing.get(u.id) ?? { jid: u.id };
                    existing.set(u.id, { ...prev, ...u, jid: u.id });
                });
                this.setState({ contacts: Array.from(existing.values()) });
            });
            this.sock.ev.on("groups-upsert", (groups) => {
                const mapped = groups.map((g) => ({
                    id: g.id,
                    subject: g.subject,
                    size: g.size,
                    participants: g.participants?.map((p) => p.id),
                }));
                const existing = new Map(this.state.groups.map((g) => [g.id, g]));
                mapped.forEach((g) => existing.set(g.id, g));
                this.setState({ groups: Array.from(existing.values()) });
            });
        }
        catch (err) {
            console.error("[WA] Connection error:", err);
            this.setState({ status: "disconnected", error: err.message });
            this.isConnecting = false;
        }
    }
    async loadContactsAndGroups() {
        if (!this.sock)
            return;
        try {
            const groups = await this.sock.groupFetchAllParticipating();
            const mapped = Object.values(groups).map((g) => ({
                id: g.id,
                subject: g.subject,
                size: g.participants?.length,
                participants: g.participants?.map((p) => p.id),
            }));
            this.setState({ groups: mapped });
        }
        catch (err) {
            console.warn("[WA] Could not load groups:", err);
        }
    }
    async disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.sock) {
            try {
                await this.sock.logout();
            }
            catch (_) { }
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
    async sendMessage(jid, message) {
        if (!this.sock || this.state.status !== "connected") {
            throw new Error("WhatsApp not connected");
        }
        try {
            if (message.type === "text") {
                await this.sock.sendMessage(jid, {
                    text: message.text ?? "",
                    ...(message.linkPreview !== false ? {} : { linkPreview: false }),
                });
            }
            else if (message.type === "image" && message.mediaData) {
                await this.sock.sendMessage(jid, {
                    image: Buffer.from(message.mediaData, "base64"),
                    caption: message.text ?? "",
                    mimetype: message.mimetype ?? "image/jpeg",
                });
            }
            else if (message.type === "video" && message.mediaData) {
                await this.sock.sendMessage(jid, {
                    video: Buffer.from(message.mediaData, "base64"),
                    caption: message.text ?? "",
                    mimetype: message.mimetype ?? "video/mp4",
                });
            }
            else if (message.type === "audio" && message.mediaData) {
                await this.sock.sendMessage(jid, {
                    audio: Buffer.from(message.mediaData, "base64"),
                    mimetype: message.mimetype ?? "audio/ogg; codecs=opus",
                    ptt: true,
                });
            }
            else if (message.type === "document" && message.mediaData) {
                await this.sock.sendMessage(jid, {
                    document: Buffer.from(message.mediaData, "base64"),
                    mimetype: message.mimetype ?? "application/octet-stream",
                    fileName: message.fileName ?? "file",
                    caption: message.text ?? "",
                });
            }
            return true;
        }
        catch (err) {
            console.error("[WA] Send error:", err);
            return false;
        }
    }
    isConnected() {
        return this.state.status === "connected";
    }
    clearAuth() {
        try {
            fs_1.default.rmSync(this.authDir, { recursive: true, force: true });
            fs_1.default.mkdirSync(this.authDir, { recursive: true });
        }
        catch (_) { }
    }
}
let managerInstance = null;
function getWaManager() {
    if (!managerInstance) {
        managerInstance = new WhatsAppManager();
    }
    return managerInstance;
}
