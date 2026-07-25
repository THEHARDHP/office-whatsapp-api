const express = require('express');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs'); 

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const sessions = new Map();
const pairingCodes = new Map(); // લિંક કોડ સેવ કરવા માટે

async function startSession(userId, phone) {
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Windows", "Chrome", "120.0.0.0"] // અહી ફેરફાર કર્યો છે (WhatsApp ને બાયપાસ કરવા)
    });

    // જો નવું કનેક્શન હોય અને મોબાઈલ નંબર આપ્યો હોય તો લિંક કોડ મંગાવો
    if (phone && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let formattedPhone = phone.toString().replace(/[^0-9]/g, '');
                if (!formattedPhone.startsWith("91")) formattedPhone = "91" + formattedPhone;
                
                const code = await sock.requestPairingCode(formattedPhone);
                pairingCodes.set(userId, code);
                console.log(`Pairing code for ${userId}: ${code}`);
            } catch (err) {
                console.log("Error getting code:", err.message);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
            if (shouldReconnect) {
                startSession(userId); 
            } else {
                sessions.delete(userId);
                pairingCodes.delete(userId);
            }
        } else if (connection === 'open') {
            sessions.set(userId, sock);
            pairingCodes.delete(userId); 
            console.log(`✅ User: ${userId} - Connected!`);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

app.get('/ping', (req, res) => {
    res.send('Server is Awake 24/7');
});

// નવું API - હવે QR ની જગ્યાએ 8 આંકડાનો કોડ આપશે
app.get('/api/session/start', async (req, res) => {
    const userId = req.query.userid;
    const phone = req.query.phone; // કયો નંબર લિંક કરવો છે
    
    if (!userId) return res.status(400).json({ error: "userid is required" });

    if (!sessions.has(userId)) {
        startSession(userId, phone);
    }
    
    setTimeout(() => {
        const isConnected = sessions.has(userId) && sessions.get(userId).user;
        const pCode = pairingCodes.get(userId) || null;
        res.json({ userid: userId, connected: !!isConnected, pairingCode: pCode });
    }, 6000); // 6 સેકન્ડમાં કોડ આવી જશે
});

app.get('/api/session/status', (req, res) => {
    const userId = req.query.userid;
    const isConnected = sessions.has(userId) && sessions.get(userId).user;
    res.json({ userid: userId, connected: !!isConnected });
});

app.get('/api/session/logout', (req, res) => {
    const userId = req.query.userid;
    if (sessions.has(userId)) {
        sessions.get(userId).logout();
        sessions.delete(userId);
    }
    pairingCodes.delete(userId);
    const folderPath = `./auth_info_${userId}`;
    if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
    }
    res.json({ success: true, message: `User ${userId} logged out successfully.` });
});

app.post('/api/send', async (req, res) => {
    const userId = req.query.userid;
    const { number, message } = req.body;

    if (!userId || !sessions.has(userId)) return res.status(401).json({ success: false, msg: `User not connected` });

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

app.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log(`Server Running`));
