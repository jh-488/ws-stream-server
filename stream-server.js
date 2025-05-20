const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ 
  server,
  maxPayload: 5 * 1024 * 1024 // 5MB max message size
});

// Store active connections
const clients = new Set();
// Store active stream sources
const streamSources = new Map(); // roomId -> source connection
let lastFrameTime = 0;
let frameCount = 0;

// Log performance stats periodically
setInterval(() => {
  if (frameCount > 0) {
    console.log(`Streaming at ${frameCount} fps, ${clients.size} clients connected, ${streamSources.size} active sources`);
    frameCount = 0;
  }
}, 5000);

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // Set binary type to arraybuffer for more efficient binary transfers
  ws.binaryType = 'arraybuffer';
  
  // Track client capabilities and network performance
  ws.clientInfo = {
    lastMessageTime: Date.now(),
    messagesSent: 0,
    bytesTransferred: 0,
    latency: 200, // Initial assumption
    dropped: 0
  };
  
  clients.add(ws);

  // Send server info to the new client
  ws.send(JSON.stringify({
    type: 'info',
    message: 'Connected to Edrys WebSocket streaming server',
    sources: Array.from(streamSources.keys()),
    clients: clients.size - 1 // Exclude self
  }));

  // Handle messages from clients
  ws.on('message', (message) => {
    try {
      // Handle potential Buffer or string messages
      const messageString = message instanceof Buffer ? 
        message.toString('utf-8') : message;
      
      let data;
      try {
        data = JSON.parse(messageString);
      } catch (e) {
        console.error('Failed to parse message as JSON:', e);
        return;
      }
      
      if (data.type === 'register-source') {
        // Require a roomId for registration
        if (!data.roomId) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Room ID is required to register as source'
          }));
          return;
        }

        const roomId = data.roomId;
        
        // Check if this room already has a source
        if (streamSources.has(roomId)) {
          // If the source is still connected, reject new registration
          const existingSource = streamSources.get(roomId);
          if (existingSource.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              message: `Room ${roomId} already has an active source`
            }));
            return;
          } else {
            // If existing source is no longer connected, remove it
            streamSources.delete(roomId);
          }
        }
        
        // Register this client as the source for the room
        ws.isSource = true;
        ws.roomId = roomId;
        streamSources.set(roomId, ws);
        console.log(`Stream source registered for room: ${roomId}`);
        
        // Confirm successful registration
        ws.send(JSON.stringify({
          type: 'source-registered',
          roomId: roomId
        }));
        
        // Notify all clients in the same room that a source is available
        clients.forEach((client) => {
          if (client !== ws && 
              client.readyState === WebSocket.OPEN && 
              client.roomId === roomId) {
            client.send(JSON.stringify({
              type: 'source-available',
              roomId: roomId
            }));
          }
        });
      } 
      else if (data.type === 'join-room') {
        // Client wants to join a specific room
        const roomId = data.roomId;
        if (!roomId) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Room ID is required to join a room'
          }));
          return;
        }
        
        ws.roomId = roomId;
        console.log(`Client joined room: ${roomId}`);
        
        // Notify the client if this room has a source
        if (streamSources.has(roomId)) {
          const source = streamSources.get(roomId);
          if (source.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'source-available',
              roomId: roomId
            }));
          } else {
            // Clean up dead sources
            streamSources.delete(roomId);
          }
        }
      }
      else if (data.type === 'frame' && ws.isSource) {
        if (!data.data) {
          console.error('Missing frame data');
          return;
        }
        
        // Track frame rate
        frameCount++;
        const now = Date.now();
        if (now - lastFrameTime > 5000) {
          lastFrameTime = now;
        }
        
        // Only send frames to clients in the same room
        const roomClients = [...clients].filter(client => 
          client !== ws && 
          client.readyState === WebSocket.OPEN && 
          client.roomId === ws.roomId
        );
        
        if (roomClients.length > 0) {
          // Sort clients by performance for more efficient delivery
          const sortedClients = roomClients.sort((a, b) => {
            return (a.clientInfo?.latency || 999) - (b.clientInfo?.latency || 999);
          });
            
          // Use a slight delay between sends to avoid network congestion
          sortedClients.forEach((client, index) => {
            if (client.readyState === WebSocket.OPEN) {
              const clientInfo = client.clientInfo;
              const messageSize = messageString.length;
              
              // Send immediately to first few clients, delay others slightly
              setTimeout(() => {
                try {
                  client.send(messageString);
                  
                  // Update client stats
                  clientInfo.messagesSent++;
                  clientInfo.bytesTransferred += messageSize;
                  clientInfo.lastMessageTime = Date.now();
                } catch (error) {
                  clientInfo.dropped++;
                  console.error('Error sending to client:', error);
                }
              }, Math.floor(index / 3) * 5); // Group clients in batches of 3 with 5ms delay between batches
            }
          });
        }
      } else if (data.type === 'ping') {
        // Respond to ping with pong and include server timestamp for latency calculation
        ws.clientInfo.lastMessageTime = Date.now();
        ws.send(JSON.stringify({ 
          type: 'pong',
          timestamp: Date.now(),
          clientTimestamp: data.timestamp
        }));
      } else if (data.type === 'pong-response') {
        // Client confirms pong receipt - allows us to measure RTT
        const rtt = Date.now() - data.serverTimestamp;
        ws.clientInfo.latency = rtt / 2; // Estimate one-way latency as RTT/2
      } else if (data.type === 'stats') {
        // Client reporting its performance stats
        if (ws.clientInfo) {
          ws.clientInfo.fps = data.fps;
          ws.clientInfo.bufferSize = data.bufferSize;
          ws.clientInfo.dropped = data.dropped || ws.clientInfo.dropped;
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
    
    // If this was a stream source, remove it and notify room clients
    if (ws.isSource && ws.roomId) {
      console.log(`Stream source disconnected from room: ${ws.roomId}`);
      streamSources.delete(ws.roomId);
      
      // Notify room clients that the source has disconnected
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.roomId === ws.roomId) {
          client.send(JSON.stringify({
            type: 'source-disconnected',
            roomId: ws.roomId
          }));
        }
      });
    }
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    // Remove client on error
    clients.delete(ws);
    if (ws.isSource && ws.roomId) {
      streamSources.delete(ws.roomId);
    }
  });
});

// Enhanced heartbeat system that also measures latency
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    
    ws.isAlive = false;
    
    try {
      // Send ping with timestamp for latency calculation
      ws.send(JSON.stringify({
        type: 'ping',
        timestamp: Date.now(),
        stats: {
          clients: clients.size,
          fps: frameCount / 5 // last 5 seconds
        }
      }));
      ws.ping();
    } catch (e) {
      // Client might be dead
      console.error("Failed to ping client", e);
    }
  });
  
  frameCount = 0; // Reset frame counter for next interval
}, 5000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

wss.on('close', () => {
  clearInterval(interval);
});

// Start server
const PORT = process.env.PORT || 8765;
server.listen(PORT, () => {
  console.log(`WebSocket streaming server running on port ${PORT}`);
});
