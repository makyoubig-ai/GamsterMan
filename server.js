const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let activeBots = [];
let proxyDownBots = [];
let successAfkBots = [];
let bannedBots = [];
let staffList = ["Admin", "Mod", "Helper", "Owner", "Staff"];

// NameMC Community OG & Trending Pool
const trendingNamesPool = [
  "Scythe", "Vortex", "Aether", "Zephyr", "Kuro", "Solstice", "Eclipse", "Frost",
  "Apex", "Phantom", "Cipher", "Nova", "Rune", "Veno", "Myth", "Onyx",
  "Kairo", "Spectre", "Valkyrie", "Zenith", "Drift", "Pulse", "Nexus", "Mirage",
  "Havoc", "Veto", "Lethal", "Titan", "Ghost", "Venom"
];

io.on('connection', (socket) => {
  emitDashboardUpdate();

  // Dynamic NameMC / Skin Lookup
  socket.on('fetch_namemc_profile', (inputName) => {
    const targetName = (inputName && inputName.trim()) 
      ? inputName.trim() 
      : trendingNamesPool[Math.floor(Math.random() * trendingNamesPool.length)];

    const data = {
      name: targetName,
      url: `https://namemc.com/search?q=${encodeURIComponent(targetName)}`,
      render: `https://mc-heads.net/body/${encodeURIComponent(targetName)}/140`,
      head: `https://mc-heads.net/avatar/${encodeURIComponent(targetName)}/64`
    };
    socket.emit('namemc_profile_result', data);
  });

  socket.on('deploy_bots', (data) => {
    const { serverIP, usernamesRaw, password, proxiesRaw } = data;
    const usernames = usernamesRaw.split(',').map(u => u.trim()).filter(Boolean);
    const proxies = proxiesRaw.split('\n').map(p => p.trim()).filter(Boolean);

    if (usernames.length === 0) {
      socket.emit('deploy_error', 'No usernames provided!');
      return;
    }

    const [host, port] = serverIP.split(':');

    usernames.forEach((username, index) => {
      const proxy = proxies[index % proxies.length] || null;
      startBot({
        username,
        host: host || serverIP,
        port: parseInt(port) || 25565,
        password,
        proxy
      });
    });

    socket.emit('deploy_success', `Deployment launched for ${usernames.length} bot(s)!`);
    emitDashboardUpdate();
  });

  socket.on('bot_chat', ({ id, message }) => {
    const botObj = activeBots.find(b => b.id === id);
    if (botObj && botObj.bot) {
      botObj.bot.chat(message);
      botObj.logs.push(`> ${message}`);
      emitDashboardUpdate();
    }
  });

  socket.on('stop_bot', (id) => {
    const index = activeBots.findIndex(b => b.id === id);
    if (index !== -1) {
      if (activeBots[index].bot) activeBots[index].bot.quit();
      activeBots.splice(index, 1);
      emitDashboardUpdate();
    }
  });

  socket.on('add_staff', (name) => {
    const cleanName = name ? name.trim() : "";
    if (cleanName && !staffList.includes(cleanName)) {
      staffList.push(cleanName);
      emitDashboardUpdate();
    }
  });

  socket.on('remove_staff', (name) => {
    staffList = staffList.filter(s => s !== name);
    emitDashboardUpdate();
  });

  socket.on('recover_proxy_down', ({ botIds, newProxy }) => {
    botIds.forEach(id => {
      const idx = proxyDownBots.findIndex(b => b.id === id);
      if (idx !== -1) {
        const botData = proxyDownBots.splice(idx, 1)[0];
        startBot({
          username: botData.username,
          host: botData.host,
          port: botData.port,
          password: botData.password,
          proxy: newProxy,
          savedUptime: botData.uptimeSeconds || 0
        });
      }
    });
    emitDashboardUpdate();
  });
});

function startBot(config) {
  const id = Math.random().toString(36).substring(2, 9);
  const skinName = trendingNamesPool[Math.floor(Math.random() * trendingNamesPool.length)];
  
  let bot;
  try {
    bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      version: false
    });
  } catch (e) {
    return;
  }

  const botRecord = {
    id,
    username: config.username,
    server: `${config.host}:${config.port}`,
    status: 'Connecting...',
    skin: skinName,
    head: `https://mc-heads.net/avatar/${encodeURIComponent(config.username)}/32`,
    uptimeSeconds: config.savedUptime || 0,
    uptime: formatUptime(config.savedUptime || 0),
    pos: 'X: 0, Y: 0, Z: 0',
    ping: 0,
    logs: ['[System] Bot initialized.'],
    bot,
    dropCount: 0,
    password: config.password,
    host: config.host,
    port: config.port
  };

  activeBots.push(botRecord);
  emitDashboardUpdate();

  // 20 Hours 2 Minutes Target (72,120 Seconds)
  const uptimeInterval = setInterval(() => {
    botRecord.uptimeSeconds++;
    botRecord.uptime = formatUptime(botRecord.uptimeSeconds);

    if (botRecord.uptimeSeconds >= 72120) {
      clearInterval(uptimeInterval);
      if (bot) bot.quit();
      activeBots = activeBots.filter(b => b.id !== id);
      successAfkBots.push({
        id,
        username: botRecord.username,
        server: botRecord.server,
        head: botRecord.head,
        skin: botRecord.skin,
        uptime: botRecord.uptime,
        password: botRecord.password,
        completedAt: new Date().toLocaleTimeString()
      });
      emitDashboardUpdate();
    }
  }, 1000);

  // Anti-AFK Yaw Movement Loop
  const movementInterval = setInterval(() => {
    if (bot && bot.entity) {
      bot.look(bot.entity.yaw + 0.3, 0, true);
    }
  }, 8000);

  bot.on('spawn', () => {
    botRecord.status = 'Online & AFK';
    botRecord.logs.push('[Spawn] Joined world.');
    emitDashboardUpdate();

    // Command Sequence: /register -> /login -> /skin set
    setTimeout(() => {
      if (config.password) {
        bot.chat(`/register ${config.password} ${config.password}`);
        botRecord.logs.push('[Auth] Sent /register');
      }
      setTimeout(() => {
        if (config.password) {
          bot.chat(`/login ${config.password}`);
          botRecord.logs.push('[Auth] Sent /login');
        }
        setTimeout(() => {
          bot.chat(`/skin set ${skinName}`);
          botRecord.logs.push(`[Skin] Set skin to ${skinName}`);
          emitDashboardUpdate();
        }, 2000);
      }, 2000);
    }, 2000);
  });

  bot.on('end', (reason) => {
    clearInterval(uptimeInterval);
    clearInterval(movementInterval);
    activeBots = activeBots.filter(b => b.id !== id);
    botRecord.dropCount = (botRecord.dropCount || 0) + 1;

    botRecord.logs.push(`[Disconnect] ${reason}`);

    if (botRecord.dropCount >= 5) {
      proxyDownBots.push({
        id,
        username: botRecord.username,
        server: botRecord.server,
        head: botRecord.head,
        skin: botRecord.skin,
        uptime: botRecord.uptime,
        uptimeSeconds: botRecord.uptimeSeconds,
        password: botRecord.password,
        host: config.host,
        port: config.port
      });
      emitDashboardUpdate();
    } else {
      setTimeout(() => {
        startBot({
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          proxy: config.proxy,
          savedUptime: botRecord.uptimeSeconds
        });
      }, 3000);
    }
  });

  // Staff Evasion Listener
  bot.on('playerJoined', (player) => {
    if (staffList.some(s => s.toLowerCase() === player.username.toLowerCase())) {
      botRecord.logs.push(`[EVADED] Staff detected: ${player.username}. Disconnecting...`);
      bot.quit();
    }
  });
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function emitDashboardUpdate() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramUsage = Math.floor(((totalMem - freeMem) / totalMem) * 100);
  const cpuLoad = Math.floor(Math.random() * 12) + 4;

  io.emit('dashboard_update', {
    system: { cpuLoad, ramUsage },
    active: activeBots.map(b => ({
      id: b.id,
      username: b.username,
      server: b.server,
      status: b.status,
      skin: b.skin,
      head: b.head,
      uptime: b.uptime,
      pos: b.pos,
      ping: b.bot?._client?.latency || 15,
      logs: b.logs.slice(-5)
    })),
    proxyDown: proxyDownBots,
    successAfk: successAfkBots,
    banned: bannedBots,
    staff: staffList.map(name => ({
      name,
      head: `https://mc-heads.net/avatar/${encodeURIComponent(name)}/28`
    }))
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Dark AFK Client Pro v2.5] Dashboard running at http://localhost:${PORT}`);
});
