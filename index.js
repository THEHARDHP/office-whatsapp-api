const express = require('express');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs'); 

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const sessions = new Map();
const qrCodes = new Map();

async function startSession(userId) {
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodes.set(userId, qr); 
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
            if (shouldReconnect) {
                startSession(userId); 
            } else {
                sessions.delete(userId);
                qrCodes.delete(userId);
            }
        } else if (connection === 'open') {
            sessions.set(userId, sock);
            qrCodes.delete(userId); 
            console.log(`✅ User: ${userId} - Connected!`);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// સર્વરને ૨૪ કલાક જાગતું રાખવા (Ping)
app.get('/ping', (req, res) => {
    res.send('Server is Awake & Running 24/7');
});

// નવું કનેક્શન અને QR કોડ
app.get('/api/session/start', async (req, res) => {
    const userId = req.query.userid;
    if (!userId) return res.status(400).json({ error: "userid is required" });

    if (!sessions.has(userId)) {
        startSession(userId);
    }
    
    setTimeout(() => {
        const isConnected = sessions.has(userId);
        const qr = qrCodes.get(userId) || null;
        res.json({ userid: userId, connected: isConnected, qr: qr });
    }, 3000);
});

// સ્ટેટસ ચેક કરવા
app.get('/api/session/status', (req, res) => {
    const userId = req.query.userid;
    if (!userId) return res.status(400).json({ error: "userid is required" });

    const isConnected = sessions.has(userId);
    const qr = qrCodes.get(userId) || null;
    res.json({ userid: userId, connected: isConnected, qr: qr });
});

// નંબર ડિલીટ/લોગઆઉટ કરવા
app.get('/api/session/logout', (req, res) => {
    const userId = req.query.userid;
    if (!userId) return res.status(400).json({ error: "userid is required" });

    if (sessions.has(userId)) {
        sessions.get(userId).logout();
        sessions.delete(userId);
    }
    qrCodes.delete(userId);
    
    const folderPath = `./auth_info_${userId}`;
    if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
    }
    
    res.json({ success: true, message: `User ${userId} logged out successfully.` });
});

// મેસેજ મોકલવા
app.post('/api/send', async (req, res) => {
    const userId = req.query.userid;
    const { number, message } = req.body;

    if (!userId) return res.status(400).json({ success: false, msg: "userid is required" });
    if (!sessions.has(userId)) return res.status(401).json({ success: false, msg: `User ${userId} is not connected` });

    try {
        let formattedNumber = number.toString().trim().replace(/[^0-9]/g, '');
        if (!formattedNumber.startsWith("91")) formattedNumber = "91" + formattedNumber;
        const jid = formattedNumber + "@s.whatsapp.net"; 
        
        const sock = sessions.get(userId);
        await sock.sendMessage(jid, { text: message || "" });
        
        res.json({ success: true, msg: "Message Sent!" });
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Office API Server Running on port ${PORT}`);
});
