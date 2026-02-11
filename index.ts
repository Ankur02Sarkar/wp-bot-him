import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

// Receiver numbers array
const receivers = ["919902025067"];

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const { version, isLatest } = await fetchLatestBaileysVersion()

    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }) as any,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" }))
        },
        generateHighQualityLinkPreview: true,
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            // Helper to check if error is a Boom error
            const isBoom = (err: any): err is Boom => err?.output !== undefined;
            const error = lastDisconnect?.error as Boom | undefined;
            const statusCode = error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (statusCode === DisconnectReason.restartRequired) {
                console.log('Session needs restart, auto-restarting...');
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.log('Logged out. Please delete auth_info_baileys and scan QR code again.');
            } else {
                console.log('Connection closed. Status:', statusCode, 'Reconnecting:', shouldReconnect);
                // Only log full error if it's not a common reconnection code
                if (error && statusCode !== DisconnectReason.restartRequired) {
                    console.error('Error details:', error.message);
                }
            }

            if (shouldReconnect) {
                connectToWhatsApp()
            }
        } else if (connection === 'open') {
            console.log('opened connection')
        }
    })

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0]
        if (!msg || !msg.message || m.type !== 'notify') return

        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text
        const sender = msg.key.remoteJid

        if (!messageContent || !sender) return

        console.log('Received message:', messageContent, 'from', sender)

        if (messageContent.startsWith('/sendbatch ')) {
            const messageToSend = messageContent.slice(11).trim(); // Remove "/sendbatch "

            if (!messageToSend) {
                await sock.sendMessage(sender, { text: 'Please provide a message to send. Usage: /sendbatch <message>' })
                return
            }

            console.log(`Starting batch send: "${messageToSend}" to ${receivers.length} receivers`)

            let successCount = 0;
            for (const number of receivers) {
                // Ensure number is just digits
                const cleanNumber = number.replace(/\D/g, '');
                const jid = `${cleanNumber}@s.whatsapp.net`;
                try {
                    await sock.sendMessage(jid, { text: messageToSend });
                    console.log(`Sent to ${jid}`);
                    successCount++;
                } catch (error) {
                    console.error(`Failed to send to ${jid}:`, error);
                }
            }

            console.log(`Batch send completed. Sent to ${successCount}/${receivers.length} receivers.`);
        } else {
            // Explicitly ignore other messages as per user request
            console.log("Ignoring message not starting with /sendbatch");
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

connectToWhatsApp()