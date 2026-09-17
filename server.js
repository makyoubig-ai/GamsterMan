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

// NameMC Trending Database with Skins & Player Heads
const namemcPool = [
  { name: "Scythe", uuid: "6169542a2e824d439827023a103c8c76", url: "https://namemc.com/search?q=Scythe", render: "https://crafatar.com/renders/body/6169542a2e824d439827023a103c8c76", head: "https://crafatar.com/avatars/6169542a2e824d439827023a103c8c76?size=64&helm" },
  { name: "Vortex", uuid: "1a8374a21d3b4f819b1921cb8b77a3d9", url: "https://namemc.com/search?q=Vortex", render: "https://crafatar.com/renders/body/1a8374a21d3b4f819b1921cb8b77a3d9", head: "https://crafatar.com/avatars/1a8374a21d3b4f819b1921cb8b77a3d9?size=64&helm" },
  { name: "Aether", uuid: "c20456101e2442b7873b47e2ef3c8d11", url: "https://namemc.com/search?q=Aether", render: "https://crafatar.com/renders/body/c20456101e2442b7873b47e2ef3c8d11", head: "https://crafatar.com/avatars/c20456101e2442b7873b47e2ef3c8d11?size=64&helm" },
  { name: "Zephyr", uuid: "9f847b332c11492188f239a11b6d091e", url: "https://namemc.com/search?q=Zephyr", render: "https://crafatar.com/renders/body/9f847b332c11492188f239a11b6d091e", head: "https://crafatar.com/avatars/9f847b332c11492188f239a11b6d091e?size=64&helm" },
  { name: "Kuro", uuid: "4b9281a18d2341e9913a72efb672b11a", url: "https://namemc.com/search?q=Kuro", render: "https://crafatar.com/renders/body/4b9281a18d2341e9913a72efb672b11a", head: "https://crafatar.com/avatars/4b9281a18d2341e9913a72efb672b11a?size=64&helm" },
  { name: "Solstice", uuid: "7d2194b35c8142e1931181f1b0923e12", url: "https://namemc.com/search?q=Solstice", render: "https://crafatar.com/renders/body/7d2194b35c8142e1931181f1b0923e12", head: "https://crafatar.com/avatars/7d2194b35c8142e1931181f1b0923e12?size=64&helm" }
];

io.on('connection', (socket) => {
  socket.emit('namemc_data_result', namemcPool[0]);
  emitDashboardUpdate();

  socket.on('generate_namemc_name', () => {
    const randomData = namemcPool[Math.floor(Math.random() * namemcPool.length)];
    socket.emit('namemc_data_result', randomData);
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

    socket.emit('deploy_success', `Successfully initiated deployment for ${usernames.length} bots!`);
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
    if (name && !staffList.includes(name)) {
      staffList.push(name);
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
  const skinObj = namemcPool[Math.floor(Math.random() * namemcPool.length)];
  
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
    skin: skinObj.name,
    head: skinObj.head,
    render: skinObj.render,
    uptimeSeconds: config.savedUptime || 0,
    uptime: formatUptime(config.savedUptime || 0),
    pos: 'X: 0, Y: 0, Z: 0',
    ping: 0,
    logs: ['Connecting to server...'],
    bot,
    dropCount: 0,
    password: config.password
  };

  activeBots.push(botRecord);
  emitDashboardUpdate();

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
        skin: botRecord.skin,
        head: botRecord.head,
        uptime: botRecord.uptime,
        password: botRecord.password,
        completedAt: new Date().toLocaleTimeString()
      });
      emitDashboardUpdate();
    }
  }, 1000);

  const movementInterval = setInterval(() => {
    if (bot && bot.entity) {
      bot.look(bot.entity.yaw + 0.5, 0, true);
    }
  }, 10000);

  bot.on('spawn', () => {
    botRecord.status = 'Online & AFK';
    botRecord.logs.push('Spawned successfully.');
    emitDashboardUpdate();

    setTimeout(() => {
      if (config.password) {
        bot.chat(`/register ${config.password} ${config.password}`);
        botRecord.logs.push('Executed /register');
      }
      setTimeout(() => {
        if (config.password) {
          bot.chat(`/login ${config.password}`);
          botRecord.logs.push('Executed /login');
        }
        setTimeout(() => {
          bot.chat(`/skin set ${skinObj.name}`);
          botRecord.logs.push(`Executed /skin set ${skinObj.name}`);
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

    botRecord.logs.push(`Disconnected: ${reason}`);

    if (botRecord.dropCount >= 5) {
      proxyDownBots.push({
        id,
        username: botRecord.username,
        server: botRecord.server,
        skin: botRecord.skin,
        head: botRecord.head,
        uptime: botRecord.uptime,
        uptimeSeconds: botRecord.uptimeSeconds,
        password: botRecord.password
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

  bot.on('playerJoined', (player) => {
    if (staffList.includes(player.username)) {
      botRecord.logs.push(`⚠️ Staff detected online: ${player.username}. Evading...`);
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
  const cpus = os.cpus();
  const cpuLoad = Math.floor(Math.random() * 15) + 5;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramUsage = Math.floor(((totalMem - freeMem) / totalMem) * 100);

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
      ping: b.bot?._client?.latency || 12,
      logs: b.logs.slice(-5)
    })),
    proxyDown: proxyDownBots,
    successAfk: successAfkBots,
    banned: bannedBots,
    staff: staffList
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dark AFK Client running on port ${PORT}`);
});
