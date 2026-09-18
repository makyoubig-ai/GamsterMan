const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// --- STORAGE ---
const activeBots = new Map();       // id -> botData
const proxyDownBots = new Map();    // id -> botConfig + uptime
const successAfkBots = new Map();   // id -> botConfig + uptime
const bannedBots = [];              // [{ username, password, reason, time, uptime, server }]

let staffList = [
  'henriks9', 'maria_int', 'nayskutzu', 'fredy_9', 'crackernut',
  'synchitss', 'gamsterevent', 'ionutz547', 'ld007', 'bombita_01',
  'osmiumredox', 'gr_veteran', 'snackks', 'andreibeni', 'urswu',
  'lupu_xx_x', 'x5speed10', 'doritostar', 'deepinangels', 'godkissed',
  'athul', '_pixelwarrioryt_', 'henzh'
];

const TARGET_UPTIME_MS = (20 * 3600 + 10 * 60) * 1000; // 20 hours 10 minutes
const HOURLY_RECONNECT_MS = 60 * 60 * 1000;             // 1 hour auto-reconnect loop

// --- PROXY PARSER ---
function parseAnyProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  proxyStr = proxyStr.trim();
  let host, port, userId, password, type = 5;

  if (proxyStr.includes('@')) {
    const parts = proxyStr.split('@');
    if (parts.length === 2) {
      const left = parts[0];
      const right = parts[1];
      if (right.includes(':')) {
        userId = left.split(':')[0];
        password = left.split(':').slice(1).join(':');
        const hp = right.split(':');
        host = hp[0];
        port = parseInt(hp[1], 10);
      } else if (left.includes(':')) {
        const hp = left.split(':');
        host = hp[0];
        port = parseInt(hp[1], 10);
        userId = right.split(':')[0];
        password = right.split(':').slice(1).join(':');
      }
    }
  } else {
    const parts = proxyStr.split(':');
    if (parts.length === 2) {
      host = parts[0];
      port = parseInt(parts[1], 10);
    } else if (parts.length >= 4) {
      host = parts[0];
      port = parseInt(parts[1], 10);
      userId = parts[2];
      password = parts.slice(3).join(':');
    }
  }
  if (!host || isNaN(port)) return null;
  return { host, port, userId, password, type };
}

// --- PROXY CHECKER ---
function testProxyConnection(proxyStr) {
  return new Promise((resolve) => {
    const config = parseAnyProxy(proxyStr);
    if (!config) return resolve({ success: false });

    const options = {
      proxy: { host: config.host, port: config.port, type: config.type },
      command: 'connect',
      destination: { host: 'api.ipify.org', port: 80 },
      timeout: 6000
    };
    if (config.userId && config.password) {
      options.proxy.userId = config.userId;
      options.proxy.password = config.password;
    }

    try {
      SocksClient.createConnection(options, (err, info) => {
        if (err || !info || !info.socket) return resolve({ success: false });
        const socket = info.socket;
        let data = '';
        socket.setTimeout(5000);
        socket.on('data', chunk => data += chunk.toString());
        socket.on('end', () => resolve({ success: data.length > 0 }));
        socket.on('error', () => { try { socket.destroy(); } catch(e){} resolve({ success: false }); });
        socket.on('timeout', () => { try { socket.destroy(); } catch(e){} resolve({ success: false }); });
        socket.write('GET /?format=text HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
      });
    } catch(e) {
      resolve({ success: false });
    }
  });
}

function createSocksConnect(proxyConfig, targetHost, targetPort) {
  return function(clientInstance) {
    const options = {
      proxy: { host: proxyConfig.host, port: proxyConfig.port, type: proxyConfig.type },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 12000
    };
    if (proxyConfig.userId && proxyConfig.password) {
      options.proxy.userId = proxyConfig.userId;
      options.proxy.password = proxyConfig.password;
    }
    SocksClient.createConnection(options)
      .then(info => { clientInstance.setSocket(info.socket); clientInstance.emit('connect'); })
      .catch(err => {
        try { clientInstance.emit('error', new Error('SOCKS Error: ' + err.message)); } catch(e){}
      });
  };
}

// UPTIME LOGIC: Accumulates uptime ONLY when online
function getCurrentUptime(botData) {
  let currentSession = botData.connectedAt ? (Date.now() - botData.connectedAt) : 0;
  return botData.accumulatedUptime + currentSession;
}

// --- BOT ENGINE ---
function startBotInstance(config) {
  const { id, username, password, host, port, proxyInput } = config;
  const proxyConfig = parseAnyProxy(proxyInput);

  let botData = activeBots.get(id);
  if (!botData) {
    botData = {
      bot: null,
      logs: [],
      status: 'Connecting...',
      config: config,
      reconnectTimer: null,
      movementInterval: null,
      uptimeCheckInterval: null,
      hourlyReconnectTimer: null,
      accumulatedUptime: config.savedUptime || 0, // Restores saved uptime if revived
      connectedAt: null,
      consecutiveDrops: 0,
      isCleaningUp: false
    };
    activeBots.set(id, botData);
  } else {
    botData.config = config;
    botData.isCleaningUp = false;
  }

  const botOpts = { host, port, username, version: '1.8.9', viewDistance: 2 };
  if (proxyConfig) botOpts.connect = createSocksConnect(proxyConfig, host, port);

  let bot;
  try {
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    botData.status = 'Initialization Failed';
    return;
  }

  botData.bot = bot;
  botData.status = 'Connecting...';

  function logMsg(msg) {
    botData.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (botData.logs.length > 40) botData.logs.shift();
  }

  let lastKick = '';

  bot.on('error', err => {
    const errMsg = err ? (err.message || String(err)) : 'Unknown Error';
    logMsg(`Connection Error: ${errMsg}`);
  });

  bot.on('kicked', reason => {
    try { lastKick = typeof reason === 'string' ? reason : JSON.stringify(reason); }
    catch(e) { lastKick = String(reason); }
    logMsg(`Kicked: ${lastKick}`);
  });

  function handleStaffEvasion(staffName) {
    if (botData.isCleaningUp) return;
    botData.isCleaningUp = true;
    logMsg(`🚨 Staff ${staffName} detected! Disconnecting & reconnecting in 15s.`);
    botData.status = `Staff Evasion (${staffName}) - Reconnecting in 15s`;
    cleanupBot(botData);
    botData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(id)) startBotInstance(config);
    }, 15000);
  }

  bot.once('spawn', () => {
    logMsg(`Spawned successfully on ${host}:${port}`);
    botData.consecutiveDrops = 0;
    botData.connectedAt = Date.now(); // Uptime timer starts ticking HERE
    botData.status = 'Connected & AFK Active';

    // Staff check on spawn
    if (bot.players) {
      for (const p of Object.values(bot.players)) {
        if (p && p.username && staffList.includes(p.username.toLowerCase())) {
          handleStaffEvasion(p.username);
          return;
        }
      }
    }

    // AuthMe Login / Register sequence
    if (password) {
      setTimeout(() => { try { bot.chat(`/register ${password} ${password}`); } catch(e){} }, 2000);
      setTimeout(() => {
        try {
          bot.chat(`/login ${password}`);
          logMsg('Sent /login command.');
        } catch(e){}
      }, 4500);
    }

    startLobbyMovement(botData);

    // ROUTINE 1-HOUR AFK RECONNECT / REJOIN
    if (botData.hourlyReconnectTimer) clearTimeout(botData.hourlyReconnectTimer);
    botData.hourlyReconnectTimer = setTimeout(() => {
      if (botData.isCleaningUp) return;
      logMsg('⌛ Reached 1 hour continuous AFK. Performing routine auto-reconnect...');
      botData.status = '1-Hour Reconnect Cycle...';
      botData.isCleaningUp = true;
      cleanupBot(botData);
      botData.reconnectTimer = setTimeout(() => {
        if (activeBots.has(id)) startBotInstance(config);
      }, 5000);
    }, HOURLY_RECONNECT_MS);

    // Monitor 20h 10m target uptime completion
    if (botData.uptimeCheckInterval) clearInterval(botData.uptimeCheckInterval);
    botData.uptimeCheckInterval = setInterval(() => {
      const totalUptime = getCurrentUptime(botData);
      if (totalUptime >= TARGET_UPTIME_MS) {
        logMsg(`🎉 Reached 20h 10m target AFK time! Disconnecting and archiving.`);
        botData.isCleaningUp = true;
        cleanupBot(botData);

        successAfkBots.set(id, {
          id,
          username: config.username,
          password: config.password || 'N/A',
          server: `${config.host}:${config.port}`,
          totalUptimeMs: totalUptime,
          completedAt: new Date().toLocaleString()
        });
        activeBots.delete(id);
      }
    }, 5000);
  });

  bot.on('playerJoined', p => {
    if (p && p.username && staffList.includes(p.username.toLowerCase())) {
      handleStaffEvasion(p.username);
    }
  });

  bot.on('chat', (uname) => {
    if (uname && staffList.includes(uname.toLowerCase())) {
      handleStaffEvasion(uname);
    }
  });

  bot.on('end', async () => {
    if (botData.isCleaningUp) return;
    botData.isCleaningUp = true;

    // SAVE & PAUSE UPTIME: Transfer current session to accumulatedUptime and clear connectedAt
    if (botData.connectedAt) {
      botData.accumulatedUptime += Date.now() - botData.connectedAt;
      botData.connectedAt = null;
    }
    cleanupBot(botData);

    // Check for ban kick
    if (lastKick.toLowerCase().includes('ban')) {
      logMsg(`🚫 Bot Banned: ${lastKick}`);
      bannedBots.push({
        username,
        password: password || 'N/A',
        reason: lastKick,
        time: new Date().toLocaleString(),
        uptimeMs: botData.accumulatedUptime,
        server: `${host}:${port}`
      });
      activeBots.delete(id);
      return;
    }

    botData.consecutiveDrops++;
    logMsg(`Disconnected (Drop #${botData.consecutiveDrops})`);

    // Handle 25 drop proxy failure threshold
    if (botData.consecutiveDrops >= 25) {
      logMsg(`Reached 25 drops. Verifying proxy connection...`);
      botData.status = 'Testing Proxy Health...';
      let proxyAlive = false;

      if (proxyInput) {
        for (let i = 0; i < 3; i++) {
          const res = await testProxyConnection(proxyInput);
          if (res.success) { proxyAlive = true; break; }
          await new Promise(r => setTimeout(r, 1500));
        }
      } else {
        proxyAlive = true;
      }

      if (proxyAlive) {
        logMsg(`Proxy is alive. Resetting drop counter and reconnecting in 15s.`);
        botData.consecutiveDrops = 0;
        botData.reconnectTimer = setTimeout(() => {
          if (activeBots.has(id)) startBotInstance(config);
        }, 15000);
        return;
      } else {
        logMsg(`❌ Proxy DEAD after 25 drops. Moving bot to Proxy Down section.`);
        proxyDownBots.set(id, {
          id,
          username: config.username,
          password: config.password || 'N/A',
          host: config.host,
          port: config.port,
          totalUptimeMs: botData.accumulatedUptime, // Save exact uptime for revival
          failedAt: new Date().toLocaleString()
        });
        activeBots.delete(id);
        return;
      }
    }

    // Standard reconnect before 25 drops
    botData.status = `Disconnected (Reconnecting in 15s - Drop #${botData.consecutiveDrops})`;
    botData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(id)) startBotInstance(config);
    }, 15000);
  });
}

function cleanupBot(botData) {
  if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
  if (botData.movementInterval) clearInterval(botData.movementInterval);
  if (botData.uptimeCheckInterval) clearInterval(botData.uptimeCheckInterval);
  if (botData.hourlyReconnectTimer) clearTimeout(botData.hourlyReconnectTimer);
  if (botData.bot) {
    try { botData.bot.quit(); } catch(e){}
    botData.bot = null;
  }
}

// --- LOBBY MOVEMENT LOOP (5 - 10 Minutes Interval) ---
function startLobbyMovement(botData) {
  if (botData.movementInterval) clearInterval(botData.movementInterval);

  const runMovementCycle = () => {
    if (!botData.bot || !botData.bot.entity) return;
    const walkDuration = Math.floor(Math.random() * 30000) + 30000; // Walk for 30-60 sec
    const restDuration = (Math.floor(Math.random() * 6) + 5) * 60 * 1000; // Rest for 5 to 10 min

    const directions = ['forward', 'back', 'left', 'right'];
    const chosenDir = directions[Math.floor(Math.random() * directions.length)];

    try {
      botData.bot.setControlState(chosenDir, true);
      setTimeout(() => {
        try { botData.bot.clearControlStates(); } catch(e){}
      }, walkDuration);
    } catch(e){}

    botData.movementInterval = setTimeout(runMovementCycle, walkDuration + restDuration);
  };

  botData.movementInterval = setTimeout(runMovementCycle, 30000);
}

// --- SOCKET.IO DASHBOARD API ---
io.on('connection', socket => {

  const interval = setInterval(() => {
    const activeList = [];
    activeBots.forEach((data, id) => {
      let totalUptime = getCurrentUptime(data);
      let pos = data.bot && data.bot.entity ? data.bot.entity.position : {x:0, y:0, z:0};

      activeList.push({
        id,
        username: data.config.username,
        password: data.config.password || 'N/A',
        server: `${data.config.host}:${data.config.port}`,
        status: data.status,
        ping: data.bot && data.bot.player ? data.bot.player.ping : 'N/A',
        health: data.bot ? data.bot.health : 'N/A',
        drops: data.consecutiveDrops,
        uptime: formatUptime(totalUptime),
        pos: `X: ${Math.floor(pos.x)}, Y: ${Math.floor(pos.y)}, Z: ${Math.floor(pos.z)}`,
        logs: data.logs.slice(-5)
      });
    });

    const proxyDownList = [];
    proxyDownBots.forEach((data, id) => {
      proxyDownList.push({
        id,
        username: data.username,
        password: data.password,
        server: `${data.host}:${data.port}`,
        uptime: formatUptime(data.totalUptimeMs),
        failedAt: data.failedAt
      });
    });

    const successAfkList = [];
    successAfkBots.forEach((data, id) => {
      successAfkList.push({
        id,
        username: data.username,
        password: data.password,
        server: data.server,
        uptime: formatUptime(data.totalUptimeMs),
        completedAt: data.completedAt
      });
    });

    const formattedBanned = bannedBots.map(b => ({
      username: b.username,
      password: b.password,
      reason: b.reason,
      time: b.time,
      uptime: formatUptime(b.uptimeMs || 0),
      server: b.server
    }));

    const staffFormatted = staffList.map((name, index) => ({
      num: index + 1,
      name: name,
      headUrl: `https://mc-heads.net/avatar/${encodeURIComponent(name)}/28`
    }));

    socket.emit('dashboard_update', {
      active: activeList,
      proxyDown: proxyDownList,
      successAfk: successAfkList,
      banned: formattedBanned,
      staffList: staffFormatted
    });
  }, 1000);

  socket.on('disconnect', () => clearInterval(interval));

  socket.on('deploy_bots', data => {
    const { serverIP, usernamesRaw, password, proxiesRaw } = data;
    const usernames = usernamesRaw.split(',').map(u => u.trim()).filter(Boolean);
    const proxies = proxiesRaw ? proxiesRaw.split(',').map(p => p.trim()).filter(Boolean) : [];

    if (proxies.length > 0 && usernames.length > proxies.length * 4) {
      return socket.emit('deploy_error', `❌ Proxy Limit Violation! 1 Proxy supports max 4 bots. You provided ${proxies.length} proxy(ies) for ${usernames.length} bots.`);
    }

    const [host, portRaw] = serverIP.split(':');
    const port = parseInt(portRaw, 10) || 25565;

    usernames.forEach((username, index) => {
      let proxyInput = '';
      if (proxies.length > 0) {
        proxyInput = proxies[Math.floor(index / 4)];
      }

      const id = `bot_${username}_${Date.now()}_${index}`;
      startBotInstance({ id, username, password, host, port, proxyInput });
    });

    socket.emit('deploy_success', `Successfully deployed ${usernames.length} bot(s)!`);
  });

  socket.on('recover_proxy_down', data => {
    const { botIds, newProxy } = data;
    if (botIds.length > 4) {
      return socket.emit('deploy_error', `❌ Max 4 bots per new proxy allowed!`);
    }

    botIds.forEach(id => {
      const botConfig = proxyDownBots.get(id);
      if (botConfig) {
        proxyDownBots.delete(id);
        startBotInstance({
          id: `bot_${botConfig.username}_${Date.now()}`,
          username: botConfig.username,
          password: botConfig.password,
          host: botConfig.host,
          port: botConfig.port,
          proxyInput: newProxy,
          savedUptime: botConfig.totalUptimeMs // Preserves stored uptime
        });
      }
    });

    socket.emit('deploy_success', `Revived ${botIds.length} bot(s) with new proxy!`);
  });

  socket.on('bot_chat', ({ id, message }) => {
    const b = activeBots.get(id);
    if (b && b.bot && message) {
      try {
        b.bot.chat(message);
        b.logs.push(`[${new Date().toLocaleTimeString()}] > Sent: ${message}`);
        if (b.logs.length > 40) b.logs.shift();
      } catch(e){}
    }
  });

  socket.on('stop_bot', id => {
    if (activeBots.has(id)) {
      const b = activeBots.get(id);
      cleanupBot(b);
      activeBots.delete(id);
    }
    if (proxyDownBots.has(id)) proxyDownBots.delete(id);
    if (successAfkBots.has(id)) successAfkBots.delete(id);
  });

  socket.on('add_staff', username => {
    const name = username.trim().toLowerCase();
    if (name && !staffList.includes(name)) {
      staffList.push(name);
      socket.emit('deploy_success', `Added ${name} to staff evasion list.`);
    }
  });

  socket.on('remove_staff', username => {
    const name = username.trim().toLowerCase();
    staffList = staffList.filter(s => s.toLowerCase() !== name);
    socket.emit('deploy_success', `Removed ${name} from staff evasion list.`);
  });
});

function formatUptime(ms) {
  if (!ms || isNaN(ms)) return '0h 0m 0s';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Dark AFK Client Pro] Running on port ${PORT}`));
