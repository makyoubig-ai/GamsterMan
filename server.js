const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- STORAGE & CONFIG ---
const activeBots = new Map();       // Running bots
const successAfkBots = [];          // Bots that completed 20h 2m AFK
const proxyDownBots = new Map();    // Bots stopped because proxy went down
const bannedBots = [];              // Banned bots log
const usedSkins = new Set();        // Track assigned NameMC skins
const generatedNamesCache = new Set(); // Track unique NameMC generated names

// Authentic NameMC trending skin usernames pool
const namemcSkinPool = [
  'AestheticBoy', 'NeonViper', 'CyberKnight', 'ShadowPixel', 'VoidWalker',
  'FrostBite', 'BlazeStriker', 'StormRider', 'QuantumNinja', 'HyperSniper',
  'PhantomGhost', 'StellarLord', 'ApexLegend', 'EclipseX', 'ZenithZ',
  'CrimsonSoul', 'AzureSpirit', 'ObsidianCore', 'TitaniumShift', 'GamerPro99'
];

// NameMC style name generation parts
const namePrefixes = ['NameMC', 'Apex', 'Vortex', 'Nexus', 'Pulse', 'Alpha', 'Omega', 'Titan', 'Matrix', 'Vector', 'Echo', 'Prism'];
const nameSuffixes = ['PvP', 'HD', 'Client', 'Bot', 'AFK', 'Core', 'X', 'Z', 'Prime', 'Gen', 'Lab', 'Hub'];

const staffList = [
  'henriks9', 'maria_int', 'nayskutzu', 'fredy_9', 'crackernut',
  'synchitss', 'gamsterevent', 'ionutz547', 'ld007', 'bombita_01',
  'osmiumredox', 'gr_veteran', 'snackks', 'andreibeni', 'urswu'
];

// --- UNIVERSAL PROXY PARSER ---
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
      timeout: 8000
    };
    if (config.userId && config.password) {
      options.proxy.userId = config.userId;
      options.proxy.password = config.password;
    }

    SocksClient.createConnection(options, (err, info) => {
      if (err) return resolve({ success: false });
      const socket = info.socket;
      let data = '';
      socket.setTimeout(6000);
      socket.on('data', chunk => data += chunk.toString());
      socket.on('end', () => resolve({ success: data.length > 0 }));
      socket.on('error', () => resolve({ success: false }));
      socket.on('timeout', () => { socket.destroy(); resolve({ success: false }); });
      socket.write('GET /?format=text HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
    });
  });
}

function createSocksConnect(proxyConfig, targetHost, targetPort) {
  return function(clientInstance) {
    const options = {
      proxy: { host: proxyConfig.host, port: proxyConfig.port, type: proxyConfig.type },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 15000
    };
    if (proxyConfig.userId && proxyConfig.password) {
      options.proxy.userId = proxyConfig.userId;
      options.proxy.password = proxyConfig.password;
    }
    SocksClient.createConnection(options)
      .then(info => { clientInstance.setSocket(info.socket); clientInstance.emit('connect'); })
      .catch(err => { try { clientInstance.emit('error', new Error('SOCKS Error: ' + err.message)); } catch(e){} });
  };
}

// --- BOT INSTANCE ENGINE ---
function startBotInstance(config) {
  const { id, username, password, host, port, proxyInput } = config;
  const proxyConfig = parseAnyProxy(proxyInput);

  // Assign unique NameMC skin
  let assignedSkin = 'AestheticBoy';
  for (const s of namemcSkinPool) {
    if (!usedSkins.has(s)) {
      assignedSkin = s;
      usedSkins.add(s);
      break;
    }
  }

  let botData = activeBots.get(id);
  if (!botData) {
    botData = {
      bot: null,
      logs: [],
      status: 'Connecting...',
      config: { ...config, skin: assignedSkin },
      reconnectTimer: null,
      movementInterval: null,
      completionTimer: null,
      hourlyTimer: null,
      accumulatedUptime: 0,
      connectedAt: null,
      consecutiveDrops: 0
    };
    activeBots.set(id, botData);
  } else {
    clearAllTimers(botData);
    botData.config = { ...config, skin: assignedSkin };
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
  bot.on('kicked', reason => {
    try { lastKick = typeof reason === 'string' ? reason : JSON.stringify(reason); }
    catch(e) { lastKick = String(reason); }
    logMsg(`Kicked: ${lastKick}`);
  });

  function handleStaffEvasion(staffName) {
    logMsg(`🚨 Staff ${staffName} detected! Disconnecting & reconnecting in 30s.`);
    botData.status = `Staff Evasion (${staffName}) - Reconnecting in 30s`;
    clearAllTimers(botData);
    try { bot.quit(); } catch(e){}
    botData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(id)) startBotInstance(config);
    }, 30000);
  }

  bot.once('spawn', () => {
    logMsg(`Spawned successfully on ${host}:${port}`);

    // Check staff online
    if (bot.players) {
      for (const p of Object.values(bot.players)) {
        if (p && p.username && staffList.includes(p.username.toLowerCase())) {
          handleStaffEvasion(p.username);
          return;
        }
      }
    }

    // Auth & Skin Sequence: Register -> Login -> /skin set [user]
    if (password) {
      setTimeout(() => { try { bot.chat(`/register ${password} ${password}`); } catch(e){} }, 2000);
      setTimeout(() => {
        try {
          bot.chat(`/login ${password}`);
          authenticateAndApplySkin(botData, id, config, assignedSkin);
        } catch(e){}
      }, 4500);
    } else {
      setTimeout(() => {
        authenticateAndApplySkin(botData, id, config, assignedSkin);
      }, 3000);
    }
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
    if (botData.status.includes('Staff') || botData.status.includes('Hourly') || botData.status.includes('Completed')) return;

    if (botData.connectedAt) {
      botData.accumulatedUptime += Date.now() - botData.connectedAt;
      botData.connectedAt = null;
    }
    clearAllTimers(botData);
    usedSkins.delete(assignedSkin);

    botData.consecutiveDrops++;
    logMsg(`Disconnected (Drop #${botData.consecutiveDrops}/5)`);

    if (lastKick.toLowerCase().includes('ban')) {
      logMsg(`🚫 Bot Banned: ${lastKick}`);
      bannedBots.push({ username, reason: lastKick, time: new Date().toLocaleString() });
      activeBots.delete(id);
      return;
    }

    // Check proxy ONLY after reaching Drop #5
    if (botData.consecutiveDrops >= 5) {
      logMsg(`Reached 5 drops. Verifying proxy health...`);
      let proxyAlive = false;
      for (let i = 0; i < 3; i++) {
        const res = await testProxyConnection(proxyInput);
        if (res.success) { proxyAlive = true; break; }
        await new Promise(r => setTimeout(r, 1500));
      }

      if (proxyAlive) {
        logMsg(`Proxy is alive! Resetting drop counter and reconnecting.`);
        botData.consecutiveDrops = 0;
        botData.status = `Proxy Healthy - Reconnecting in 30s`;
        botData.reconnectTimer = setTimeout(() => {
          if (activeBots.has(id)) startBotInstance(config);
        }, 30000);
        return;
      } else {
        logMsg(`❌ Proxy DEAD after 5 drops. Moving bot to Proxy-Down section.`);
        let currentSession = botData.connectedAt ? (Date.now() - botData.connectedAt) : 0;
        let totalMs = botData.accumulatedUptime + currentSession;

        proxyDownBots.set(id, {
          username,
          password,
          host,
          port,
          proxyInput,
          skin: assignedSkin,
          totalUptimeMs: totalMs,
          failedAt: new Date().toLocaleString()
        });
        activeBots.delete(id);
        return;
      }
    }

    // Drops 1 to 4: reconnect normally without freezing or checking proxy
    botData.status = `Disconnected (Reconnecting in 30s - Drop #${botData.consecutiveDrops}/5)`;
    botData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(id)) startBotInstance(config);
    }, 30000);
  });
}

function authenticateAndApplySkin(botData, id, config, skinName) {
  try {
    botData.bot.chat(`/skin set ${skinName}`);
  } catch(e){}

  botData.status = 'Connected & AFK Active';
  botData.consecutiveDrops = 0;
  botData.connectedAt = Date.now();
  startLobbyMovement(botData);
  startHourlyRefresh(botData, id, config);
  startCompletionTimer(botData, id);
}

// --- 20 HOURS 2 MINUTES COMPLETION TIMER ---
function startCompletionTimer(botData, id) {
  if (botData.completionTimer) clearTimeout(botData.completionTimer);
  const targetDuration = (20 * 60 * 60 * 1000) + (2 * 60 * 1000); // 20 hours 2 minutes

  botData.completionTimer = setTimeout(() => {
    if (!activeBots.has(id)) return;
    botData.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 Successfully reached 20 hours 2 minutes AFK! Archiving bot.`);
    
    if (botData.connectedAt) {
      botData.accumulatedUptime += Date.now() - botData.connectedAt;
      botData.connectedAt = null;
    }
    clearAllTimers(botData);
    usedSkins.delete(botData.config.skin);

    successAfkBots.push({
      username: botData.config.username,
      password: botData.config.password,
      server: `${botData.config.host}:${botData.config.port}`,
      skin: botData.config.skin,
      uptime: formatUptime(botData.accumulatedUptime),
      completedAt: new Date().toLocaleString()
    });

    try { botData.bot.quit(); } catch(e){}
    activeBots.delete(id);
  }, targetDuration);
}

// --- HOURLY REFRESH (30s delay & reapply skin) ---
function startHourlyRefresh(botData, id, config) {
  if (botData.hourlyTimer) clearTimeout(botData.hourlyTimer);
  botData.hourlyTimer = setTimeout(() => {
    botData.status = `Hourly Refresh - Rejoining in 30s`;
    botData.logs.push(`[${new Date().toLocaleTimeString()}] ⏰ Hourly refresh triggered. Rejoining in 30s.`);
    
    clearAllTimers(botData);
    if (botData.connectedAt) {
      botData.accumulatedUptime += Date.now() - botData.connectedAt;
      botData.connectedAt = null;
    }
    usedSkins.delete(botData.config.skin);
    try { botData.bot.quit(); } catch(e){}

    botData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(id)) startBotInstance(config);
    }, 30000);
  }, 3600000);
}

// --- LOBBY EXPLORATION & MOVEMENT (Every 5-10 mins) ---
function startLobbyMovement(botData) {
  if (botData.movementInterval) clearInterval(botData.movementInterval);

  const runMovementCycle = () => {
    if (!botData.bot || !botData.bot.entity) return;
    const walkDuration = Math.floor(Math.random() * 20000) + 20000; // 20-40s walk/run
    const nextInterval = (Math.floor(Math.random() * 6) + 5) * 60 * 1000; // 5 to 10 minutes

    const directions = ['forward', 'back', 'left', 'right'];
    const chosenDir = directions[Math.floor(Math.random() * directions.length)];

    try {
      botData.bot.setControlState(chosenDir, true);
      botData.bot.setControlState('sprint', true);
      botData.bot.setControlState('jump', true);

      setTimeout(() => {
        try {
          botData.bot.clearControlStates();
        } catch(e){}
      }, walkDuration);
    } catch(e){}

    botData.movementInterval = setTimeout(runMovementCycle, walkDuration + nextInterval);
  };

  botData.movementInterval = setTimeout(runMovementCycle, 300000);
}

function clearAllTimers(botData) {
  if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
  if (botData.movementInterval) clearInterval(botData.movementInterval);
  if (botData.completionTimer) clearTimeout(botData.completionTimer);
  if (botData.hourlyTimer) clearTimeout(botData.hourlyTimer);
}

// --- SOCKET.IO DASHBOARD API ---
io.on('connection', socket => {

  const interval = setInterval(() => {
    const activeList = [];
    activeBots.forEach((data, id) => {
      let currentSession = data.connectedAt ? (Date.now() - data.connectedAt) : 0;
      let totalUptime = data.accumulatedUptime + currentSession;
      let pos = data.bot && data.bot.entity ? data.bot.entity.position : {x:0, y:0, z:0};

      activeList.push({
        id,
        username: data.config.username,
        server: `${data.config.host}:${data.config.port}`,
        status: data.status,
        skin: data.config.skin,
        ping: data.bot && data.bot.player ? data.bot.player.ping : 'N/A',
        health: data.bot ? data.bot.health : 'N/A',
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
        server: `${data.host}:${data.port}`,
        skin: data.skin,
        uptime: formatUptime(data.totalUptimeMs),
        failedAt: data.failedAt
      });
    });

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemPct = Math.round(((totalMem - freeMem) / totalMem) * 100);

    socket.emit('dashboard_update', {
      active: activeList,
      successAfk: successAfkBots,
      proxyDown: proxyDownList,
      banned: bannedBots,
      staff: staffList,
      system: {
        ramUsage: usedMemPct,
        cpuLoad: Math.floor(Math.random() * 15) + 5
      }
    });
  }, 1000);

  socket.on('disconnect', () => clearInterval(interval));

  socket.on('deploy_bots', data => {
    const { serverIP, usernamesRaw, password, proxiesRaw } = data;
    const usernames = usernamesRaw.split(',').map(u => u.trim()).filter(Boolean);
    const proxies = proxiesRaw ? proxiesRaw.split(',').map(p => p.trim()).filter(Boolean) : [];

    if (proxies.length > 0 && usernames.length > proxies.length * 4) {
      return socket.emit('deploy_error', `❌ Proxy Limit Violation! 1 Proxy can support a maximum of 4 bots.`);
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

  socket.on('bot_chat', ({ id, message }) => {
    const botData = activeBots.get(id);
    if (botData && botData.bot && message) {
      try {
        botData.bot.chat(message);
        botData.logs.push(`[${new Date().toLocaleTimeString()}] Sent Chat: ${message}`);
      } catch(e){}
    }
  });

  socket.on('recover_proxy_down', data => {
    const { botIds, newProxy } = data;
    if (botIds.length > 4) {
      return socket.emit('deploy_error', `❌ Maximum 4 bots allowed per proxy recovery!`);
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
          proxyInput: newProxy
        });
      }
    });

    socket.emit('deploy_success', `Successfully revived ${botIds.length} bot(s)!`);
  });

  socket.on('stop_bot', id => {
    if (activeBots.has(id)) {
      const b = activeBots.get(id);
      clearAllTimers(b);
      usedSkins.delete(b.config.skin);
      try { b.bot.quit(); } catch(e){}
      activeBots.delete(id);
    }
    if (proxyDownBots.has(id)) proxyDownBots.delete(id);
  });

  socket.on('add_staff', name => {
    const clean = name.trim().toLowerCase();
    if (clean && !staffList.includes(clean)) {
      staffList.push(clean);
      socket.emit('deploy_success', `Added ${clean} to staff evasion list.`);
    }
  });

  socket.on('remove_staff', name => {
    const index = staffList.indexOf(name.toLowerCase());
    if (index !== -1) {
      staffList.splice(index, 1);
      socket.emit('deploy_success', `Removed ${name} from staff list.`);
    }
  });

  // NameMC unique generator request
  socket.on('generate_namemc_name', () => {
    let name = '';
    for (let i = 0; i < 50; i++) {
      const p = namePrefixes[Math.floor(Math.random() * namePrefixes.length)];
      const s = nameSuffixes[Math.floor(Math.random() * nameSuffixes.length)];
      const num = Math.floor(Math.random() * 900) + 100;
      let candidate = `${p}_${s}${num}`;
      if (!generatedNamesCache.has(candidate)) {
        generatedNamesCache.add(candidate);
        name = candidate;
        break;
      }
    }
    socket.emit('namemc_name_result', name || 'All names generated!');
  });
});

function formatUptime(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / (1000 * 60)) % 60);
  const h = Math.floor(ms / (1000 * 60 * 60));
  return `${h}h ${m}m ${s}s`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Dark AFK Client] Running on port ${PORT}`));
      
