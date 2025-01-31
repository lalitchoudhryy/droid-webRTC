const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server (now as signaling server)
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false, // Disable compression for lower latency
  maxPayload: 1024 * 1024, // 1MB max payload
});

// Store clients with their roles and stream types
const clients = new Map(); // Using Map to store client info

// Add at the top with other declarations
const activeStreams = new Set();

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  // Add ping-pong heartbeat to detect stale connections
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Add connection metadata
  ws.connectionTime = new Date();

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "register":
          // Register client role and stream type
          clients.set(ws, {
            role: message.role,
            streamId: message.streamId,
            peerId: message.peerId,
          });

          // Track active streams when a streamer connects
          if (message.role === "streamer") {
            activeStreams.add(message.streamId);
            // Notify all multi-viewers about the new stream
            broadcastActiveStreams();
          }
          // Send active streams list to multi-viewer
          else if (message.role === "multi-viewer") {
            ws.send(
              JSON.stringify({
                type: "active-streams",
                streams: Array.from(activeStreams),
              })
            );
          }
          // Original viewer logic
          else if (message.role === "viewer") {
            for (const [clientWs, info] of clients.entries()) {
              if (
                info.role === "streamer" &&
                info.streamId === message.streamId
              ) {
                clientWs.send(
                  JSON.stringify({
                    type: "viewer-ready",
                    viewerId: message.peerId,
                    streamId: message.streamId,
                  })
                );
                break;
              }
            }
          }
          break;

        case "offer":
          // Forward offer to specific viewer
          forwardToViewer(message.target, {
            type: "offer",
            offer: message.offer,
            streamId: message.streamId,
            fromPeerId: message.fromPeerId,
          });
          break;

        case "answer":
          // Forward answer to specific streamer
          forwardToStreamer(message.target, {
            type: "answer",
            answer: message.answer,
            streamId: message.streamId,
            fromPeerId: message.fromPeerId,
          });
          break;

        case "ice-candidate":
          // Forward ICE candidate to specific peer
          forwardToClient(message.target, {
            type: "ice-candidate",
            candidate: message.candidate,
            fromPeerId: message.fromPeerId,
          });
          break;
      }
    } catch (error) {
      console.error("Error processing message:", error);
      console.error("Raw message:", data.toString());
    }
  });

  ws.on("close", () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      // Remove stream from active streams if it was a streamer
      if (clientInfo.role === "streamer") {
        activeStreams.delete(clientInfo.streamId);
        broadcastActiveStreams();
      }
      // Notify other peers about disconnection
      broadcastDisconnection(clientInfo.peerId);
    }
    clients.delete(ws);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
    clients.delete(ws);
    // Add reconnection logic if needed
    ws.close();
  });
});

// Helper functions for signaling
function forwardToViewer(targetPeerId, message) {
  for (const [ws, info] of clients.entries()) {
    if (info.role === "viewer" && info.peerId === targetPeerId) {
      ws.send(JSON.stringify(message));
      break;
    }
  }
}

function forwardToStreamer(targetPeerId, message) {
  for (const [ws, info] of clients.entries()) {
    if (info.role === "streamer" && info.peerId === targetPeerId) {
      ws.send(JSON.stringify(message));
      break;
    }
  }
}

function forwardToClient(targetPeerId, message) {
  for (const [ws, info] of clients.entries()) {
    if (info.peerId === targetPeerId) {
      ws.send(JSON.stringify(message));
      break;
    }
  }
}

function broadcastDisconnection(peerId) {
  // Find which stream this peer was associated with
  let disconnectedStreamId = null;
  clients.forEach((info) => {
    if (info.peerId === peerId && info.role === "streamer") {
      disconnectedStreamId = info.streamId;
    }
  });

  const message = JSON.stringify({
    type: "peer-disconnected",
    peerId: peerId,
    streamId: disconnectedStreamId, // Add streamId to the message
  });

  clients.forEach((info, ws) => {
    if (info.peerId !== peerId) {
      ws.send(message);
    }
  });
}

// Add heartbeat interval to check for stale connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => {
  clearInterval(interval);
});

// Add this new function for broadcasting active streams
function broadcastActiveStreams() {
  const message = JSON.stringify({
    type: "active-streams",
    streams: Array.from(activeStreams),
  });

  clients.forEach((info, ws) => {
    if (info.role === "multi-viewer") {
      ws.send(message);
    }
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
