import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { getWaManager } from "./whatsapp-manager";

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Initialize the manager immediately
const waManager = getWaManager();

app.get("/status", (req, res) => {
  res.json(waManager.getState());
});

app.post("/connect", async (req, res) => {
  try {
    await waManager.connect();
    res.json({ success: true, status: waManager.getState().status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    await waManager.disconnect();
    res.json({ success: true, status: waManager.getState().status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/send", async (req, res) => {
  const { jid, message } = req.body;
  if (!jid || !message) {
    return res.status(400).json({ success: false, error: "Missing jid or message" });
  }
  
  if (!waManager.isConnected()) {
    return res.status(400).json({ success: false, error: "WhatsApp not connected" });
  }

  try {
    const success = await waManager.sendMessage(jid, message);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/campaign", async (req, res) => {
  const { campaignId, recipients, message, webhookUrl } = req.body;
  if (!waManager.isConnected()) {
    return res.status(400).json({ success: false, error: "WhatsApp not connected" });
  }
  
  // Acknowledge request immediately
  res.json({ success: true, message: "Campaign started in background" });
  
  // Run loop in background
  (async () => {
    let sent = 0;
    let failed = 0;
    for (const jid of recipients) {
      try {
        await waManager.sendMessage(jid, message);
        sent++;
      } catch (err) {
        failed++;
      }
      await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5s delay
      
      // Ping webhook every 10 messages
      if ((sent + failed) % 10 === 0 && webhookUrl) {
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId, sentCount: sent, failedCount: failed, status: "RUNNING" })
        }).catch(() => {});
      }
    }
    
    // Final webhook ping
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          campaignId, 
          sentCount: sent, 
          failedCount: failed, 
          status: failed === recipients.length ? "FAILED" : "COMPLETED" 
        })
      }).catch(() => {});
    }
  })();
});

// SSE endpoint for status updates
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders(); // flush the headers to establish SSE

  // Send initial state
  res.write(`event: state\ndata: ${JSON.stringify(waManager.getState())}\n\n`);

  const onStateChange = (state: any) => {
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  };

  waManager.onStateChange(onStateChange);

  req.on("close", () => {
    waManager.offStateChange(onStateChange);
  });
});

app.listen(port, () => {
  console.log(`WhatsApp Microservice listening at http://localhost:${port}`);
  // Attempt to auto-reconnect if auth exists
  waManager.connect().catch(console.error);
});
