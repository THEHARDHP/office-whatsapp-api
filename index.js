const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// અલગ-અલગ સેશન (Device) સાચવવા માટે
const sessions = {}; 

async function createSession(id, res = null) {
    const sessionPath = path.join(__dirname, 'sessions', id);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ૧. ડાયરેક્ટ બ્રાઉઝરમાં QR કોડ બતાવવા
        if (qr && res && !res.headersSent) {
            try {
                const qrImage = await qrcode.toDataURL(qr);
                res.send(`
                    <div style="text-align: center; margin-top: 50px; font-family: Arial;">
                        <h2 style="color: #2c3e50;">📱 HARDI MESSAGING</h2>
                        <h3 style="color: #e67e22;">Device ID: ${id.toUpperCase()}</h3>
                        <p><b>તમારા WhatsApp માંથી આ QR કોડ સ્કેન કરો</b></p>
                        <img src="${qrImage}" alt="QR Code" style="border: 2px solid #000; border-radius: 10px; padding: 15px; box-shadow: 0px 4px 10px rgba(0,0,0,0.2);">
                        <p style="color: red; margin-top: 20px;">(નોંધ: જો QR કોડ જતો રહે, તો પેજ જાતે રિફ્રેશ કરજો)</p>
                    </div>
                `);
            } catch (err) {
                res.send("QR કોડ બનાવવામાં ભૂલ આવી.");
            }
        }

        // ૨. કનેક્શન બંધ થાય ત્યારે
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                createSession(id); 
            } else {
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete sessions[id];
            }
        } 
        // ૩. કનેક્શન સફળ થઈ જાય ત્યારે
        else if (connection === 'open') {
            sessions[id] = sock;
            if (res && !res.headersSent) {
                res.send(`<h1 style="color: green; text-align: center; margin-top:50px;">✅ સક્સેસ! કનેક્શન થઈ ગયું! હવે આ પેજ બંધ કરી દો.</h1>`);
            }
        }
    });

    sessions[id] = sock;
}

// ---- API ROUTES ----

// ૧. QR કોડ જોવા માટે
app.get('/qr', (req, res) => {
    const id = req.query.id;
    if (!id) return res.send('<h2 style="color:red; text-align:center;">❌ ભૂલ: લિંકમાં id લખો.</h2>');
    
    // જો સેશન ફસાયેલું હોય તો લાલ બટન (Reset) આપો
    if (sessions[id]) {
        return res.send(`
            <div style="text-align:center; font-family:Arial; margin-top:50px;">
                <h2 style="color:orange;">⚠️ <b>${id}</b> સેશન ફસાયેલું છે અથવા પહેલેથી ચાલુ છે!</h2>
                <p>જો તમારે આને ફરીથી સ્કેન કરવું હોય તો નીચેનું બટન દબાવો:</p>
                <br>
                <a href="/reset?id=${id}" style="padding:10px 20px; background:red; color:white; text-decoration:none; border-radius:5px; font-size:18px;">🔄 સેશન રીસેટ કરો</a>
            </div>
        `);
    }
    createSession(id, res);
});

// ૨. ફસાયેલા ID ને રીસેટ કરવા માટે (Smart Tool)
app.get('/reset', (req, res) => {
    const id = req.query.id;
    if (!id) return res.send("ID આપો");

    if (sessions[id]) delete sessions[id];
    const sessionPath = path.join(__dirname, 'sessions', id);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    
    res.send(`
        <div style="text-align:center; font-family:Arial; margin-top:50px;">
            <h2 style="color:green;">✅ ${id} નું સેશન સાફ થઈ ગયું!</h2>
            <br>
            <a href="/qr?id=${id}" style="padding:10px 20px; background:blue; color:white; text-decoration:none; border-radius:5px; font-size:18px;">👉 નવો QR કોડ મંગાવો</a>
        </div>
    `);
});

// ૩. મેસેજ મોકલવા માટે
app.post('/api/send', async (req, res) => {
    const id = req.query.id || req.query.userid;
    const { number, message } = req.body;

    if (!id || !sessions[id]) {
        return res.status(400).json({ success: false, msg: `ID '${id}' કનેક્ટેડ નથી. પહેલા QR સ્કેન કરો.` });
    }

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        await sessions[id].sendMessage(jid, { text: message });
        res.json({ success: true, msg: `મેસેજ મોકલાયો!`, id: id });
    } catch (error) {
        res.status(500).json({ success: false, msg: error.message });
    }
});

// ૪. પિંગ 
app.get('/ping', (req, res) => res.send('pong'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 HARDI સર્વર પોર્ટ ${PORT} પર ચાલુ છે...`);
});
