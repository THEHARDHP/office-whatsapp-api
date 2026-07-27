const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());

let sock;
let qrCodeData = null;
let isConnected = false;

// સિંગલ સેશન માટેનું ફંક્શન
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // નવો QR કોડ આવે ત્યારે તેને સેવ કરો
        if (qr) {
            qrCodeData = qr;
            console.log('✅ નવો QR કોડ તૈયાર છે! બ્રાઉઝરમાં લિંક ઓપન કરો.');
        }

        if (connection === 'close') {
            isConnected = false;
            
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('🔄 5 સેકન્ડ પછી ફરીથી કનેક્ટ થઈ રહ્યું છે...');
                // અહીં 5 સેકન્ડનો બ્રેક આપ્યો છે જેથી લૂપ ન બને
                setTimeout(() => {
                    connectToWhatsApp();
                }, 5000);
            } else {
                console.log('❌ ડિવાઇસ લોગઆઉટ થઈ ગયું છે. જૂનો ડેટા ડિલીટ થાય છે.');
                qrCodeData = null;
                if (fs.existsSync('auth_info')) {
                    fs.rmSync('auth_info', { recursive: true, force: true });
                }
                // ડેટા ડિલીટ કર્યા પછી નવો QR જનરેટ કરવા માટે ફરી ચાલુ કરો
                setTimeout(() => {
                    connectToWhatsApp();
                }, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeData = null; // કનેક્ટ થયા પછી QR ની જરૂર નથી
            console.log('✅ WhatsApp સફળતાપૂર્વક કનેક્ટ થઈ ગયું છે!');
        }
    });
}

// સર્વર ચાલુ થાય ત્યારે સીધું WhatsApp કનેક્શન ચાલુ કરો
connectToWhatsApp();

// ---- API ROUTES ----

// ૧. QR કોડ જોવા માટેની લિંક
app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="text-align: center; margin-top: 50px; font-family: Arial;">
                <h1 style="color: green;">✅ સક્સેસ!</h1>
                <h2>તમારું WhatsApp પહેલેથી જ કનેક્ટેડ છે! હવે આ પેજ બંધ કરી શકો છો.</h2>
            </div>
        `);
    }

    if (!qrCodeData) {
        return res.send(`
            <div style="text-align: center; margin-top: 50px; font-family: Arial;">
                <h2 style="color: orange;">⏳ QR કોડ બની રહ્યો છે... થોડીવાર રાહ જુઓ.</h2>
                <p>કૃપા કરીને 5 થી 10 સેકન્ડ પછી આ પેજ <b>રિફ્રેશ</b> કરો.</p>
            </div>
        `);
    }

    try {
        const qrImage = await qrcode.toDataURL(qrCodeData);
        res.send(`
            <div style="text-align: center; margin-top: 50px; font-family: Arial;">
                <h2 style="color: #2c3e50;">📱 HARDI MESSAGING</h2>
                <p><b>તમારા WhatsApp માંથી આ QR કોડ સ્કેન કરો</b></p>
                <img src="${qrImage}" alt="QR Code" style="border: 2px solid #000; border-radius: 10px; padding: 15px; box-shadow: 0px 4px 10px rgba(0,0,0,0.2);">
                <p style="color: red; margin-top: 20px;">(નોંધ: જો સ્કેન કરવામાં એરર આવે, તો પેજ રિફ્રેશ કરીને નવો કોડ સ્કેન કરો)</p>
            </div>
        `);
    } catch (err) {
        res.send("❌ QR કોડ બનાવવામાં ભૂલ આવી.");
    }
});

// ૨. લોગઆઉટ અથવા બધું રીસેટ કરવા માટેની લિંક
app.get('/reset', (req, res) => {
    if (fs.existsSync('auth_info')) {
        fs.rmSync('auth_info', { recursive: true, force: true });
    }
    res.send('<h2 style="color: green; text-align: center; margin-top: 50px;">✅ ડેટા સાફ થઈ ગયો છે. સર્વર રિસ્ટાર્ટ થઈ રહ્યું છે...</h2>');
    setTimeout(() => {
        process.exit(1); // Render સર્વરને રિસ્ટાર્ટ કરવા માટે
    }, 2000);
});

// ૩. મેસેજ મોકલવા માટેની લિંક (API)
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected || !sock) {
        return res.status(400).json({ success: false, msg: '❌ WhatsApp હજુ કનેક્ટ નથી થયું. પહેલા /qr વાળી લિંક પર જઈને સ્કેન કરો.' });
    }

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, msg: '✅ મેસેજ મોકલાયો!' });
    } catch (error) {
        res.status(500).json({ success: false, msg: error.message });
    }
});

// ૪. પિંગ (સર્વર ચાલુ છે કે નહીં તે ચેક કરવા)
app.get('/ping', (req, res) => res.send('pong'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 HARDI સિંગલ-PC સર્વર પોર્ટ ${PORT} પર ચાલુ છે...`);
});
