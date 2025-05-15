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
let streamSource = null;
let lastFrameTime = 0;
let frameCount = 0;

// Log performance stats periodically
setInterval(() => {
  if (frameCount > 0) {
    console.log(`Streaming at ${frameCount} fps, ${clients.size} clients connected`);
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
    hasSource: streamSource !== null,
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
        if (streamSource) {
          // If we already have a source, notify the new client
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Another client is already streaming'
          }));
        } else {
          streamSource = ws;
          console.log('Stream source registered');
          
          // Notify all clients that a source has connected
          clients.forEach((client) => {
            if (client !== streamSource && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'info',
                message: 'Stream source connected'
              }));
            }
          });
        }
      } else if (data.type === 'frame' && ws === streamSource) {
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
        
        // Broadcast video frame to all viewers with prioritization
        const viewerCount = clients.size - 1; // Exclude source
        if (viewerCount > 0) {
          // Sort clients by performance so we prioritize clients that can handle the stream
          const sortedClients = [...clients].filter(client => client !== streamSource)
            .sort((a, b) => {
              // Prioritize clients with lower latency and fewer dropped frames
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
    
    if (ws === streamSource) {
      console.log('Stream source disconnected');
      streamSource = null;
      
      // Notify all clients that the source has disconnected
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'info',
            message: 'Stream source disconnected'
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
    if (ws === streamSource) {
      streamSource = null;
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
