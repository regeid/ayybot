const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { Boom } = require('@hapi/boom');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

let currentQR = null;
let logs = [];
const activeBots = {};

// Helper untuk mendapatkan waktu dengan timezone Asia/Jakarta
const getCurrentTime = () => {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
};

// Helper untuk sensor nomor
const maskPhoneNumber = (phoneNumber) => {
  return phoneNumber.slice(0, -5) + '*****';
};

app.get('/', (req, res) => {
  res.render('index', { logs });
});

app.post('/add_number', async (req, res) => {
  const phoneNumber = req.body.phoneNumber;
  if (phoneNumber) {
    const maskedNumber = maskPhoneNumber(phoneNumber);
    const credsFolder = `./auth_info/${phoneNumber}`;

    if (!fs.existsSync(credsFolder)) {
      fs.mkdirSync(credsFolder, { recursive: true });
    }

    logs.push(`[${getCurrentTime()}] Menambahkan nomor WhatsApp: ${maskedNumber}`);
    io.emit('log_update', logs);

    if (activeBots[phoneNumber]) {
      logs.push(`[${getCurrentTime()}] Bot untuk nomor ${maskedNumber} sudah aktif.`);
      io.emit('log_update', logs);
      return res.redirect(`/dash/${phoneNumber}`);
    }

    currentQR = null;
    await startBot(phoneNumber);
    res.redirect(`/dash/${phoneNumber}`);
  } else {
    res.send('Nomor tidak valid!');
  }
});

app.get('/dash/:phoneNumber', (req, res) => {
  const phoneNumber = req.params.phoneNumber;
  const credsFolder = `./auth_info/${phoneNumber}`;
  const connected = fs.existsSync(path.join(credsFolder, 'creds.json'));

  res.render('dash', {
    phoneNumber,
    qr: connected ? null : currentQR,
    connected,
    logs
  });
});

app.get('/logout', (req, res) => {
  try {
    fs.rmSync('./auth_info', { recursive: true, force: true });
    logs.push(`[${getCurrentTime()}] Folder auth_info dihapus. Silakan pindai ulang QR.`);
    currentQR = null;
    io.emit('log_update', logs);
  } catch (err) {
    console.error('Gagal menghapus auth_info:', err);
  }
  res.redirect('/');
});

io.on('connection', (socket) => {
  socket.emit('initial_data', { qr: currentQR, logs });
});

const checkAndStartBots = async () => {
  const authInfoFolder = './auth_info';
  if (fs.existsSync(authInfoFolder)) {
    const phoneNumbers = fs.readdirSync(authInfoFolder);

    for (const phoneNumber of phoneNumbers) {
      const credsFolder = path.join(authInfoFolder, phoneNumber);
      if (fs.existsSync(credsFolder)) {
        startBot(phoneNumber);
      }
    }
  }
};

const startBot = async (phoneNumber) => {
  if (activeBots[phoneNumber]) {
    logs.push(`[${getCurrentTime()}] Bot untuk nomor ${maskPhoneNumber(phoneNumber)} sudah berjalan.`);
    io.emit('log_update', logs);
    return;
  }

  const credsFolder = `auth_info/${phoneNumber}`;
  const { state, saveCreds } = await useMultiFileAuthState(credsFolder);
  const naze = makeWASocket({ auth: state });

  activeBots[phoneNumber] = naze;

  naze.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr && !fs.existsSync(path.join(credsFolder, 'creds.json'))) {
      currentQR = await QRCode.toDataURL(qr);
      logs.push(`[${getCurrentTime()}] QR Code diperbarui untuk nomor ${maskPhoneNumber(phoneNumber)}`);
      io.emit('qr_update', { phoneNumber, qr: currentQR });
      io.emit('log_update', logs);
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      delete activeBots[phoneNumber];
      if (reason === DisconnectReason.loggedOut) {
        logs.push(`[${getCurrentTime()}] Kredensial ${maskPhoneNumber(phoneNumber)} kadaluarsa atau logout.`);
      } else {
        logs.push(`[${getCurrentTime()}] Bot ${maskPhoneNumber(phoneNumber)} terputus. Memulai ulang...`);
        startBot(phoneNumber);
      }
      io.emit('log_update', logs);
    }

    if (connection === 'open') {
      logs.push(`[${getCurrentTime()}] Bot ${maskPhoneNumber(phoneNumber)} berhasil terhubung.`);
      io.emit('log_update', logs);
    }
  });

  naze.ev.on('creds.update', saveCreds);

  naze.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.key.fromMe && m.message) {
      const chatId = m.key.remoteJid;
      const messageContent = m.message.conversation || '';
      const prefix = '.';

      if (messageContent.startsWith(prefix + 'ayy')) {
        const text = messageContent.split(' ').slice(1).join(' ') || (m.quoted && m.quoted.text) || '';
        if (!text) {
          await naze.sendMessage(chatId, { text: `Kirim/reply pesan *${prefix + 'ayy'}* Teksnya` }, { quoted: m });
          return;
        }

        try {
          const response = await fetch(`https://brat.caliphdev.com/api/brat?text=${encodeURIComponent(text)}`);
          if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
          }

          const buffer = await response.arrayBuffer();
          const webpBuffer = await convertToWebp(Buffer.from(buffer));

          await naze.sendMessage(chatId, { sticker: webpBuffer }, { quoted: m });
          const logMessage = `[${getCurrentTime()}] Sticker berhasil dikirim ke ${chatId}`;
          logs.push(logMessage);
          io.emit('log_update', logs);
        } catch (e) {
          console.error('Error:', e);
          await naze.sendMessage(chatId, { text: 'Server Sedang Offline atau Gagal Mengambil Gambar!' }, { quoted: m });
        }
      }
    }
  });
};

const convertToWebp = async (buffer) => {
  const img = await loadImage(buffer);
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 512, 512);
  return canvas.toBuffer('image/webp');
};

checkAndStartBots();

server.listen(3000, () => {
  console.log('Server berjalan di http://localhost:3000');
});
