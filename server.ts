import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { MatchState, PlayerState, SkinConfig } from './src/types';
import { updatePhysics, createPlayer, createInitialPuck, createInitialGoalie } from './src/gamePhysics';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  const PORT = 3000;

  // 1. MATCHMAKING & ACTIVE GAME ROOMS DATA
  interface QueuedPlayer {
    socketId: string;
    name: string;
    skinConfig: SkinConfig;
  }

  const matchmakingQueue: QueuedPlayer[] = [];
  const activeMatches: {
    [roomId: string]: {
      state: MatchState;
      inputs: {
        [id: string]: { dx: number; dy: number; angle: number; isSwinging: boolean; power: number };
      };
      playerSockets: { [id: string]: Socket };
      gameLoopInterval: NodeJS.Timeout | null;
    };
  } = {};

  // Clean helper to remove players from queue
  function removeFromQueue(socketId: string) {
    const idx = matchmakingQueue.findIndex(q => q.socketId === socketId);
    if (idx !== -1) {
      matchmakingQueue.splice(idx, 1);
    }
  }

  // 2. REAL-TIME SOCKET.IO HANDLERS
  io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Update customization options in real-time
    socket.on('join_queue', (data: { name: string; skinConfig: SkinConfig }) => {
      // Avoid duplicate entries
      removeFromQueue(socket.id);

      matchmakingQueue.push({
        socketId: socket.id,
        name: data.name || 'Steve',
        skinConfig: data.skinConfig,
      });

      console.log(`Player added to matchmaking queue. Queue size: ${matchmakingQueue.length}`);
      socket.emit('queue_status', { inQueue: true, queuePosition: matchmakingQueue.length });

      // Run matchmaking checker
      checkMatchmaking();
    });

    socket.on('leave_queue', () => {
      removeFromQueue(socket.id);
      socket.emit('queue_status', { inQueue: false });
      console.log(`Player left queue. Queue size: ${matchmakingQueue.length}`);
    });

    // Receive player inputs during live match
    socket.on('player_input', (input: { dx: number; dy: number; angle: number; isSwinging: boolean; power: number }) => {
      const roomId = (socket as any).roomId;
      if (roomId && activeMatches[roomId]) {
        const match = activeMatches[roomId];
        match.inputs[socket.id] = {
          dx: input.dx,
          dy: input.dy,
          angle: input.angle,
          isSwinging: input.isSwinging,
          power: input.power,
        };
      }
    });

    // Cleanup on disconnect
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
      removeFromQueue(socket.id);

      // If player was in a match, forfeit/end match
      const roomId = (socket as any).roomId;
      if (roomId && activeMatches[roomId]) {
        const match = activeMatches[roomId];
        const oppSocket = Object.values(match.playerSockets).find(s => s.id !== socket.id);
        
        if (oppSocket) {
          oppSocket.emit('opponent_disconnected', { message: 'Opponent disconnected. You win!' });
          // Force match to end
          match.state.status = 'ended';
          const winner = match.state.players[oppSocket.id];
          if (winner) {
            match.state.winnerId = winner.id;
          }
          oppSocket.emit('match_end', match.state);
        }

        // Clean up match
        if (match.gameLoopInterval) {
          clearInterval(match.gameLoopInterval);
        }
        delete activeMatches[roomId];
        console.log(`Cleaned up match in room: ${roomId}`);
      }
    });
  });

  // 3. MATCHMAKING MATCH CREATOR
  function checkMatchmaking() {
    while (matchmakingQueue.length >= 2) {
      const p1 = matchmakingQueue.shift()!;
      const p2 = matchmakingQueue.shift()!;

      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);

      if (!s1 || !s2) {
        // One of the players disconnected in-flight, re-queue the other if they are active
        if (s1) matchmakingQueue.unshift(p1);
        if (s2) matchmakingQueue.unshift(p2);
        continue;
      }

      // Create Match Room
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      s1.join(roomId);
      s2.join(roomId);

      (s1 as any).roomId = roomId;
      (s2 as any).roomId = roomId;

      // Define players states
      const player1State = createPlayer(p1.socketId, p1.name, 'left', p1.skinConfig, true);
      const player2State = createPlayer(p2.socketId, p2.name, 'right', p2.skinConfig, true);

      const matchState: MatchState = {
        roomId,
        players: {
          [p1.socketId]: player1State,
          [p2.socketId]: player2State,
        },
        puck: createInitialPuck(),
        goalies: {
          left: createInitialGoalie('left'),
          right: createInitialGoalie('right'),
        },
        score: { left: 0, right: 0 },
        timeLeft: 90, // 90 seconds of highly intense gameplay
        status: 'warmup',
        goalScoredTeam: null,
        resetTimer: 3.0, // warmupcountdown
        winnerId: null,
        gameMode: 'online',
      };

      activeMatches[roomId] = {
        state: matchState,
        inputs: {
          [p1.socketId]: { dx: 0, dy: 0, angle: 0, isSwinging: false, power: 1 },
          [p2.socketId]: { dx: 0, dy: 0, angle: Math.PI, isSwinging: false, power: 1 },
        },
        playerSockets: {
          [p1.socketId]: s1,
          [p2.socketId]: s2,
        },
        gameLoopInterval: null,
      };

      // Notify match started
      s1.emit('match_start', { side: 'left', opponentName: p2.name, state: matchState });
      s2.emit('match_start', { side: 'right', opponentName: p1.name, state: matchState });

      console.log(`Started online match ${roomId} between ${p1.name} and ${p2.name}`);

      // Start server physics tick loop (50 FPS -> 20ms)
      const currentMatch = activeMatches[roomId];
      currentMatch.gameLoopInterval = setInterval(() => {
        if (!activeMatches[roomId]) return;

        // Run server authoritative tick
        updatePhysics(currentMatch.state, currentMatch.inputs, (soundType) => {
          // Broadcast specific sound events to both clients to play locally
          io.to(roomId).emit('sound_trigger', { soundType });
        });

        // Broadcast game tick update
        io.to(roomId).emit('match_update', currentMatch.state);

        // Handle match termination on game end
        if (currentMatch.state.status === 'ended') {
          io.to(roomId).emit('match_end', currentMatch.state);
          console.log(`Match ${roomId} completed naturally. Winner: ${currentMatch.state.winnerId}`);
          
          if (currentMatch.gameLoopInterval) {
            clearInterval(currentMatch.gameLoopInterval);
          }
          delete activeMatches[roomId];
        }
      }, 20);
    }
  }

  // 4. SERVER HEALTH AND API ROUTES
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', onlinePlayers: io.engine.clientsCount, activeMatches: Object.keys(activeMatches).length });
  });

  // 5. VITE INTEGRATION FOR DEVELOPMENT / STATIC IN PRODUCTION
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('Mounted Vite developer mode middleware');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('Serving production static build from dist');
  }

  // Start the composite HTTP and WebSockets Server on single port 3000
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Blockey Hockey Full-Stack Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start full-stack server:', err);
});
