const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());

let sock;
let qrCodeData = null;
let isConnected = false;

// ----------------------------------------------------
// 🛡️ ANTI-CRASH SYSTEM (સર્વરને બંધ થતું અટકાવવા)
// ----------------------------------------------------
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

// સિંગલ સેશન માટેનું ફંક્શન
async function connectToWhatsApp() {
    // 🎯 અહીં મેં જૂના 'auth_info' ફોલ્ડરની જગ્યાએ નવું 'baps_session' ફોલ્ડર બનાવી દીધું છે!
    const { state, saveCreds } = await useMultiFileAuthState('baps_session');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr;
            console.log('✅ નવો QR કોડ તૈયાર છે! બ્રાઉઝરમાં લિંક ઓપન કરો.');
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('🔄 5 સેકન્ડ પછી ફરીથી કનેક્ટ થઈ રહ્યું છે...');
                setTimeout(() => { connectToWhatsApp(); }, 5000);
            } else {
                console.log('❌ ડિવાઇસ લોગઆઉટ થઈ ગયું છે. જૂનો ડેટા ડિલીટ થાય છે.');
                qrCodeData = null;
                // નવા ફોલ્ડરને ડિલીટ કરવાનું લોજીક
                if (fs.existsSync('baps_session')) {
                    fs.rmSync('baps_session', { recursive: true, force: true });
                }
                setTimeout(() => { connectToWhatsApp(); }, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeData = null; 
            console.log('✅ WhatsApp સફળતાપૂર્વક કનેક્ટ થઈ ગયું છે!');
        }
    });
}

connectToWhatsApp();


// ---- API ROUTES ----

app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="text-align: center; margin-top: 50px; font-family: Arial;">
                <h1 style="color: green;">✅ સક્સેસ!</h1>
                <h2>તમારું WhatsApp પહેલેથી જ કનેક્ટેડ છે!</h2>
            </div>
        `);
    }

    if (!qrCodeData) {
        return res.send(`
            <div style="text-align: center; margin-top: 50px; font-family: Arial;">
                <h2 style="color: orange;">⏳ QR કોડ બની રહ્યો છે... 5 સેકન્ડ પછી પેજ રિફ્રેશ કરો.</h2>
            </div>
        `);
    }

    try {
        const qrImage = await qrcode.toDataURL(qrCodeData);
        res.send(`
            <div style="text-align: center; margin-top: 50px; font-family: Arial;">
                <h2 style="color: #2c3e50;">📱 HARDI MESSAGING</h2>
                <p><b>તમારા WhatsApp માંથી આ QR કોડ સ્કેન કરો</b></p>
                <img src="${qrImage}" style="border: 2px solid #000; border-radius: 10px; padding: 15px; box-shadow: 0px 4px 10px rgba(0,0,0,0.2);">
            </div>
        `);
    } catch (err) {
        res.send("❌ QR કોડ બનાવવામાં ભૂલ આવી.");
    }
});

app.get('/reset', (req, res) => {
    if (fs.existsSync('baps_session')) {
        fs.rmSync('baps_session', { recursive: true, force: true });
    }
    res.send('<h2 style="color: green; text-align: center; margin-top: 50px;">✅ નવો ડેટા પણ સાફ થઈ ગયો છે. સર્વર રિસ્ટાર્ટ થઈ રહ્યું છે...</h2>');
    setTimeout(() => { process.exit(1); }, 2000);
});

app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected || !sock) {
        return res.status(400).json({ success: false, msg: '❌ WhatsApp હજુ કનેક્ટ નથી થયું.' });
    }

    try {
        let jid = number.toString().replace(/\D/g, '');
        if (jid.length === 10) jid = "91" + jid;
        if (!jid.includes('@s.whatsapp.net')) jid = jid + '@s.whatsapp.net';

        const [result] = await sock.onWhatsApp(jid);
        if (!result || !result.exists) {
            console.log(`❌ ${jid} પર WhatsApp ચાલુ નથી.`);
            return res.status(400).json({ success: false, msg: '❌ આ નંબર પર WhatsApp ચાલુ નથી.' });
        }

        await sock.sendMessage(jid, { text: message });
        console.log(`✅ ${jid} ને મેસેજ સફળતાપૂર્વક મોકલાયો.`);
        res.json({ success: true, msg: '✅ મેસેજ મોકલાયો!' });

    } catch (error) {
        console.error("❌ Send Error:", error.message);
        res.status(500).json({ success: false, msg: error.message });
    }
});

app.get('/ping', (req, res) => {
    console.log('🏓 Google Sheet માંથી Ping આવ્યું! (સર્વર જાગી રહ્યું છે)');
    res.send('pong');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 HARDI સિંગલ-PC સર્વર પોર્ટ ${PORT} પર ચાલુ છે...`);
});
