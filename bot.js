import baileys from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"
import qrcodelib from "qrcode"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import express from "express"
import http from "http"

const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = baileys

// Setup untuk ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Setup Express server - MOVED OUTSIDE OF FUNCTION
const app = express()
const server = http.createServer(app)
let qrDataUrl = null
const loggedInGroups = new Set()
const loggedInUsers = new Set()
let isServerStarted = false

// Nomor yang diizinkan (tanpa + dan country code)
const ALLOWED_NUMBER = "142610161246317"

// Buat folder untuk menyimpan file yang diterima dan dikirim
const RECEIVED_FILES_DIR = path.join(__dirname, "received_files")
const SENT_FILES_DIR = path.join(__dirname, "sent_files")

// Buat folder jika belum ada
if (!fs.existsSync(RECEIVED_FILES_DIR)) {
    fs.mkdirSync(RECEIVED_FILES_DIR, { recursive: true })
}
if (!fs.existsSync(SENT_FILES_DIR)) {
    fs.mkdirSync(SENT_FILES_DIR, { recursive: true })
}

// Initialize server routes ONCE
function initializeServer() {
    if (isServerStarted) return

    // Serve the QR code page
    app.get("/", (req, res) => {
        if (qrDataUrl) {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsApp Bot QR Code</title>
                    <style>
                        body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: Arial, sans-serif; }
                        h1 { color: #333; }
                        img { max-width: 300px; margin: 20px 0; }
                        p { color: #555; }
                        .info { background: #f0f8ff; padding: 15px; border-radius: 8px; margin: 20px; max-width: 400px; }
                    </style>
                </head>
                <body>
                    <h1>🤖 WhatsApp Bot dengan Restriksi</h1>
                    <p>Scan QR code dengan WhatsApp untuk menghubungkan bot.</p>
                    <img src="${qrDataUrl}" alt="QR Code" />
                    <div class="info">
                        <h3>ℹ️ Info Restriksi:</h3>
                        <p>• Bot hanya aktif untuk nomor tertentu</p>
                        <p>• Hanya admin tertentu yang bisa mengakses</p>
                        <p>• Sistem keamanan aktif</p>
                    </div>
                </body>
                </html>
            `);
        } else {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsApp Bot</title>
                    <style>
                        body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: Arial, sans-serif; }
                        h1 { color: #333; }
                        p { color: #555; }
                        .status { background: #e8f5e8; padding: 15px; border-radius: 8px; margin: 20px; }
                    </style>
                </head>
                <body>
                    <h1>🤖 WhatsApp Bot dengan Restriksi</h1>
                    <div class="status">
                        <p>✅ Bot sudah terhubung</p>
                        <p>🔒 Sistem keamanan aktif</p>
                        <p>📊 Sessions: ${loggedInGroups.size} grup, ${loggedInUsers.size} user</p>
                        <p>🔐 Authorized for: +${ALLOWED_NUMBER}</p>
                    </div>
                </body>
                </html>
            `);
        }
    });

    // Start the web server ONLY ONCE
    const PORT = 3000;
    server.listen(PORT, (err) => {
        if (err) {
            console.error(`❌ Error starting server: ${err.message}`);
            return;
        }
        console.log(`🌐 Web server running at http://localhost:${PORT}`);
        isServerStarted = true;
    });

    // Handle server errors
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`⚠️ Port ${PORT} is already in use. Server may already be running.`);
        } else {
            console.error(`❌ Server error: ${err.message}`);
        }
    });
}

async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState("./auth_info")

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // Disable terminal QR to avoid conflicts
        })

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                console.log("📱 Generating QR code...");
                qrcode.generate(qr, { small: true })
                try {
                    qrDataUrl = await qrcodelib.toDataURL(qr);
                    console.log(`🌐 Open http://localhost:3000 to scan the QR code`);
                } catch (error) {
                    console.error("Error generating QR data URL:", error)
                }
            }
            
            if (connection === "open") {
                console.log("✅ Bot berhasil tersambung!")
                qrDataUrl = null // Clear QR code when connected
            } else if (connection === "close") {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
                console.log("❌ Koneksi terputus:", lastDisconnect?.error?.message || lastDisconnect?.error, ", reconnecting:", shouldReconnect)
                
                if (shouldReconnect) {
                    console.log("🔄 Reconnecting in 5 seconds...")
                    setTimeout(() => {
                        startBot().catch(console.error)
                    }, 5000)
                } else {
                    console.log("🔐 Bot was logged out. Please restart the application.")
                    qrDataUrl = null
                }
            }
        })

        async function getContactName(jid) {
            try {
                const contact = await sock.onWhatsApp(jid.split('@')[0])
                if (contact && contact.length > 0) {
                    return contact[0].name || null
                }
            } catch (error) {
                console.log("Could not fetch contact info:", error.message)
            }
            return null
        }

        function formatPhoneNumber(jid) {
            if (jid.includes('@g.us')) {
                return null
            }
            
            const phoneNumber = jid.split('@')[0]
            if (phoneNumber.startsWith('62')) {
                return `+${phoneNumber}`
            }
            return `+${phoneNumber}`
        }

        // Fungsi untuk mengecek apakah nomor diizinkan
        function isAllowedNumber(jid) {
            const phoneNumber = jid.split('@')[0]
            return phoneNumber === ALLOWED_NUMBER
        }

        // Fungsi untuk menyimpan file yang diterima
        async function saveReceivedFile(msg, mediaType) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {})
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
                const senderJid = msg.key.participant || msg.key.remoteJid
                const senderPhone = formatPhoneNumber(senderJid) || senderJid.split('@')[0]
                
                // Tentukan ekstensi file berdasarkan media type
                let extension = ''
                switch (mediaType) {
                    case 'imageMessage':
                        extension = '.jpg'
                        break
                    case 'videoMessage':
                        extension = '.mp4'
                        break
                    case 'audioMessage':
                        extension = '.ogg'
                        break
                    case 'documentMessage':
                        extension = path.extname(msg.message.documentMessage.fileName || '') || '.bin'
                        break
                    case 'stickerMessage':
                        extension = '.webp'
                        break
                    default:
                        extension = '.bin'
                }
                
                const filename = `${timestamp}_${senderPhone}${extension}`
                const filepath = path.join(RECEIVED_FILES_DIR, filename)
                
                fs.writeFileSync(filepath, buffer)
                
                console.log(`📁 File disimpan: ${filename} (${buffer.length} bytes)`)
                return { filename, filepath, size: buffer.length }
            } catch (error) {
                console.error("❌ Error saat menyimpan file:", error)
                return null
            }
        }

        // Fungsi untuk mengirim file
        async function sendFile(chatJid, filePath, caption = '') {
            try {
                if (!fs.existsSync(filePath)) {
                    return { success: false, error: 'File tidak ditemukan' }
                }

                const fileBuffer = fs.readFileSync(filePath)
                const fileExtension = path.extname(filePath).toLowerCase()
                const filename = path.basename(filePath)
                
                let messageOptions = {}
                
                // Tentukan jenis pesan berdasarkan ekstensi file
                if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExtension)) {
                    messageOptions = {
                        image: fileBuffer,
                        caption: caption
                    }
                } else if (['.mp4', '.avi', '.mov', '.mkv'].includes(fileExtension)) {
                    messageOptions = {
                        video: fileBuffer,
                        caption: caption
                    }
                } else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(fileExtension)) {
                    messageOptions = {
                        audio: fileBuffer,
                        mimetype: 'audio/mpeg'
                    }
                } else {
                    // Untuk file dokumen
                    messageOptions = {
                        document: fileBuffer,
                        fileName: filename,
                        caption: caption
                    }
                }
                
                await sock.sendMessage(chatJid, messageOptions)
                
                // Salin file ke folder sent_files untuk tracking
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
                const sentFileName = `${timestamp}_${filename}`
                const sentFilePath = path.join(SENT_FILES_DIR, sentFileName)
                fs.copyFileSync(filePath, sentFilePath)
                
                console.log(`📤 File dikirim: ${filename} (${fileBuffer.length} bytes)`)
                return { success: true, filename, size: fileBuffer.length }
            } catch (error) {
                console.error("❌ Error saat mengirim file:", error)
                return { success: false, error: error.message }
            }
        }

        // Fungsi untuk mendaftar file yang tersedia
        function listAvailableFiles() {
            try {
                const files = fs.readdirSync(RECEIVED_FILES_DIR)
                return files.filter(file => !file.startsWith('.')).slice(0, 10) // Batasi 10 file terbaru
            } catch (error) {
                console.error("❌ Error saat membaca folder:", error)
                return []
            }
        }

        sock.ev.on("messages.upsert", async (m) => {
            const msg = m.messages[0]
            if (!msg.message) return
            if (msg.key.fromMe) return

            const pesan = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || ""
            
            const senderJid = msg.key.participant || msg.key.remoteJid
            const chatJid = msg.key.remoteJid
            const senderName = msg.pushName || "Unknown"
            const phoneNumber = formatPhoneNumber(senderJid)
            
            // RESTRIKSI NOMOR - Hanya nomor tertentu yang dapat menggunakan bot
            if (!isAllowedNumber(senderJid)) {
                // Log untuk monitoring tapi tidak ada balasan
                console.log(`🚫 Akses ditolak dari: ${senderName} (${phoneNumber || senderJid})`)
                console.log(`📩 Pesan: ${pesan}`)
                console.log(`🕒 Waktu: ${new Date().toLocaleString('id-ID')}`)
                console.log("=" + "=".repeat(50))
                return // Tidak ada balasan, bot akan diam
            }

            let groupInfo = ""
            if (chatJid.includes('@g.us')) {
                try {
                    const groupMetadata = await sock.groupMetadata(chatJid)
                    groupInfo = `\n🏷️ Grup: ${groupMetadata.subject}`
                    loggedInGroups.add(groupMetadata.subject)
                } catch (error) {
                    groupInfo = "\n🏷️ Grup: [Tidak dapat mengambil info grup]"
                }
            } else {
                loggedInUsers.add(phoneNumber || senderJid)
            }
            
            // Cek apakah ada media attachment
            const mediaType = Object.keys(msg.message).find(key => 
                ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(key)
            )
            
            if (mediaType) {
                console.log("=" + "=".repeat(50))
                console.log("📎 File diterima:", mediaType)
                console.log("👤 Dari:", senderName, "(AUTHORIZED)")
                if (phoneNumber) {
                    console.log("📞 Nomor:", phoneNumber)
                }
                if (groupInfo) {
                    console.log(groupInfo.substring(1))
                }
                console.log("🕒 Waktu:", new Date().toLocaleString('id-ID'))
                console.log("=" + "=".repeat(50))
                
                // Simpan file yang diterima
                const savedFile = await saveReceivedFile(msg, mediaType)
                if (savedFile) {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: `✅ File berhasil diterima dan disimpan!\n📁 Nama: ${savedFile.filename}\n📊 Ukuran: ${(savedFile.size / 1024).toFixed(2)} KB`
                    })
                } else {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: "❌ Gagal menyimpan file yang diterima."
                    })
                }
                return
            }
            
            console.log("=" + "=".repeat(50))
            console.log("📩 Pesan masuk:", pesan)
            console.log("👤 Dari:", senderName, "(AUTHORIZED)")
            if (phoneNumber) {
                console.log("📞 Nomor:", phoneNumber)
            }
            if (groupInfo) {
                console.log(groupInfo.substring(1))
            }
            console.log("🕒 Waktu:", new Date().toLocaleString('id-ID'))
            console.log("🆔 Chat ID:", chatJid)
            if (chatJid.includes('@g.us')) {
                console.log("👥 Sender ID:", senderJid)
            }
            console.log("=" + "=".repeat(50))

            const command = pesan.toLowerCase().trim()
            
            try {
                if (command === "halo" || command === "hai") {
                    await sock.sendMessage(msg.key.remoteJid, { 
                        text: `Hai juga ${senderName}! 👋 Selamat datang di bot WhatsApp yang aman!` 
                    })
                } else if (command === "ping") {
                    await sock.sendMessage(msg.key.remoteJid, { 
                        text: "🏓 Pong! Bot aktif dan berjalan dengan baik.\n🔒 Akses terotorisasi untuk nomor ini." 
                    })
                } else if (command === "help" || command === "bantuan") {
                    const helpText = `🤖 *Bot WhatsApp Commands (Restricted):*

📝 *Perintah yang tersedia:*
• halo/hai - Sapa bot
• ping - Cek status bot  
• help/bantuan - Tampilkan pesan ini
• info - Info tentang bot
• myinfo - Info tentang Anda

📁 *Perintah File:*
• listfiles - Lihat file yang tersedia
• sendfile [nama_file] - Kirim file (contoh: sendfile gambar.jpg)
• filecount - Lihat jumlah file yang tersimpan

🔒 *Security Info:*
• Bot hanya aktif untuk nomor terotorisasi
• Semua aktivitas dilog dan dimonitor
• Akses terbatas untuk keamanan

💡 *Tips:*
• Kirim file apa saja ke bot untuk disimpan otomatis
• Bot akan memberitahu saat file berhasil disimpan

Kirim pesan untuk mencoba! 😊`
                    
                    await sock.sendMessage(msg.key.remoteJid, { 
                        text: helpText 
                    })
                } else if (command === "info") {
                    let botInfo = "ℹ️ *Bot Info:*\n\n🔹 Dibuat dengan Baileys\n🔹 Running di Node.js\n🔹 Status: Aktif ✅\n🔹 Fitur: File Upload/Download ✅\n🔹 Security: Restricted Access 🔒\n🔹 Web Interface: http://localhost:3000"
                    
                    if (chatJid.includes('@g.us')) {
                        try {
                            const groupMetadata = await sock.groupMetadata(chatJid)
                            botInfo += `\n🔹 Grup saat ini: ${groupMetadata.subject}`
                            botInfo += `\n🔹 Jumlah member: ${groupMetadata.participants.length}`
                        } catch (error) {
                            botInfo += "\n🔹 Info grup tidak tersedia"
                        }
                    }
                    
                    await sock.sendMessage(msg.key.remoteJid, { 
                        text: botInfo 
                    })
                } else if (command === "myinfo") {
                    let userInfo = `👤 *Info Anda:*\n\n🏷️ Nama: ${senderName}\n🔒 Status: AUTHORIZED`
                    
                    if (phoneNumber) {
                        userInfo += `\n📞 Nomor: ${phoneNumber}`
                    }
                    
                    if (chatJid.includes('@g.us')) {
                        try {
                            const groupMetadata = await sock.groupMetadata(chatJid)
                            userInfo += `\n🏷️ Grup: ${groupMetadata.subject}`
                        } catch (error) {
                            userInfo += "\n🏷️ Grup: [Info tidak tersedia]"
                        }
                    } else {
                        userInfo += "\n💬 Chat: Personal"
                    }
                    
                    await sock.sendMessage(msg.key.remoteJid, { 
                        text: userInfo 
                    })
                } else if (command === "listfiles") {
                    const files = listAvailableFiles()
                    if (files.length === 0) {
                        await sock.sendMessage(msg.key.remoteJid, { 
                            text: "📁 Tidak ada file yang tersimpan saat ini." 
                        })
                    } else {
                        let fileList = "📁 *File yang tersedia:*\n\n"
                        files.forEach((file, index) => {
                            fileList += `${index + 1}. ${file}\n`
                        })
                        fileList += `\n💡 Gunakan: *sendfile [nama_file]* untuk mengirim file`
                        
                        await sock.sendMessage(msg.key.remoteJid, { 
                            text: fileList 
                        })
                    }
                } else if (command === "filecount") {
                    const receivedFiles = fs.readdirSync(RECEIVED_FILES_DIR).length
                    const sentFiles = fs.readdirSync(SENT_FILES_DIR).length
                    
                    await sock.sendMessage(msg.key.remoteJid, { 
                        text: `📊 *Statistik File:*\n\n📥 File diterima: ${receivedFiles}\n📤 File dikirim: ${sentFiles}\n📁 Total file: ${receivedFiles + sentFiles}\n🔒 Access: Restricted` 
                    })
                } else if (pesan.toLowerCase().startsWith("sendfile ")) {
                    const fileName = pesan.substring(9).trim()
                    if (!fileName) {
                        await sock.sendMessage(msg.key.remoteJid, { 
                            text: "❌ Harap sertakan nama file. Contoh: sendfile gambar.jpg" 
                        })
                        return
                    }
                    
                    const filePath = path.join(RECEIVED_FILES_DIR, fileName)
                    const result = await sendFile(chatJid, filePath, `📎 File dari bot: ${fileName}`)
                    
                    if (result.success) {
                        await sock.sendMessage(msg.key.remoteJid, { 
                            text: `✅ File "${fileName}" berhasil dikirim!\n📊 Ukuran: ${(result.size / 1024).toFixed(2)} KB` 
                        })
                    } else {
                        await sock.sendMessage(msg.key.remoteJid, { 
                            text: `❌ Gagal mengirim file: ${result.error}` 
                        })
                    }
                } else if (pesan.startsWith("/")) {
                    await sock.sendMessage(msg.key.remoteJid, { 
                        text: "❓ Perintah tidak dikenal. Ketik 'help' untuk melihat daftar perintah." 
                    })
                }
            } catch (error) {
                console.error("❌ Error saat mengirim pesan:", error)
            }
        })

        // sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
        //     if (action === "add") {
        //         try {
        //             const groupMetadata = await sock.groupMetadata(id)
        //             console.log(`🎉 Member baru bergabung ke grup: ${groupMetadata.subject}`)
                    
        //             for (const participant of participants) {
        //                 const phoneNumber = formatPhoneNumber(participant)
        //                 console.log(`👋 Member baru: ${participant}${phoneNumber ? ` (${phoneNumber})` : ''}`)
                        
        //                 // Hanya kirim pesan selamat datang jika ada member yang terotorisasi di grup
        //                 const groupMembers = await sock.groupMetadata(id)
        //                 const hasAuthorizedMember = groupMembers.participants.some(member => 
        //                     isAllowedNumber(member.id)
        //                 )
                        
        //                 if (hasAuthorizedMember) {
        //                     await sock.sendMessage(id, {
        //                         text: `👋 Selamat datang di grup *${groupMetadata.subject}*!\n\n🔒 Bot ini memiliki sistem keamanan aktif.\nHanya admin tertentu yang dapat menggunakan perintah bot.`
        //                     })
        //                 }
        //             }
        //         } catch (error) {
        //             console.error("❌ Error saat menangani member baru:", error)
        //         }
        //     } else if (action === "remove") {
        //         try {
        //             const groupMetadata = await sock.groupMetadata(id)
        //             console.log(`👋 Member keluar dari grup: ${groupMetadata.subject}`)
                    
        //             for (const participant of participants) {
        //                 const phoneNumber = formatPhoneNumber(participant)
        //                 console.log(`📤 Member keluar: ${participant}${phoneNumber ? ` (${phoneNumber})` : ''}`)
        //             }
        //         } catch (error) {
        //             console.error("❌ Error saat menangani member keluar:", error)
        //         }
        //     }
        // })

        return sock
    } catch (error) {
        console.error("❌ Error in startBot:", error)
        throw error
    }
}

async function main() {
    try {
        console.log("🚀 Memulai WhatsApp Bot dengan fitur keamanan...")
        console.log(`🔒 Bot hanya aktif untuk nomor: +${ALLOWED_NUMBER}`)
        
        // Initialize server first (only once)
        initializeServer()
        
        // Then start the bot
        await startBot()
    } catch (error) {
        console.error("❌ Error starting bot:", error)
        console.log("🔄 Mencoba restart dalam 10 detik...")
        setTimeout(main, 10000)
    }
}

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down bot...');
    if (isServerStarted) {
        server.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

process.on('SIGTERM', () => {
    console.log('\n🔄 Received SIGTERM, shutting down gracefully...');
    if (isServerStarted) {
        server.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

main()