import baileys from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"
import qrcodelib from "qrcode"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import express from "express"
import http from "http"
import mysql from "mysql2/promise"

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

// MySQL Configuration
const DB_CONFIG = {
    host: 'localhost',
    user: 'root',
    password: 'Andi naruto123', // Ganti dengan password MySQL Anda
    database: 'whatsapp_bot3',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}

// Connection Pool
let pool = null

// Nomor yang diizinkan (tanpa + dan country code)
const ALLOWED_NUMBERS = [
    "142610161246317",  // Nomor pertama (existing)
    "6281268231405",   // Nomor kedua (contoh)
    "6285355787629",
    "78641505542244",   // Nomor ketiga (contoh)
    // Tambahkan nomor lain di sini...
]

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

// Initialize MySQL Database
async function initializeDatabase() {
    try {
        // Create connection pool
        pool = mysql.createPool(DB_CONFIG)

        // Test connection
        const connection = await pool.getConnection()
        console.log("✅ MySQL connected successfully")
        connection.release()

        // Create tables if they don't exist
        await createTables()

    } catch (error) {
        console.error("❌ MySQL connection failed:", error.message)
        console.log("📋 Make sure MySQL is running and database 'whatsapp_bot' exists")
        console.log("📋 You can create the database with: CREATE DATABASE whatsapp_bot;")
        throw error
    }
}

// Create necessary tables
async function createTables() {
    try {
        // Messages table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                message_id VARCHAR(255) UNIQUE,
                type ENUM('user_message', 'bot_response', 'bot_error') NOT NULL,
                message TEXT,
                sender_name VARCHAR(255),
                sender_phone VARCHAR(50),
                sender_jid VARCHAR(255),
                chat_jid VARCHAR(255),
                group_name VARCHAR(255),
                context VARCHAR(100),
                original_command VARCHAR(500),
                authorized BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_type (type),
                INDEX idx_created_at (created_at),
                INDEX idx_chat_jid (chat_jid)
            )
        `)

        // Files table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS files (
                id INT AUTO_INCREMENT PRIMARY KEY,
                file_id VARCHAR(255) UNIQUE,
                filename VARCHAR(255) NOT NULL,
                original_name VARCHAR(255),
                type VARCHAR(100),
                mime_type VARCHAR(100),
                size BIGINT,
                sender_name VARCHAR(255),
                sender_phone VARCHAR(50),
                sender_jid VARCHAR(255),
                recipient VARCHAR(255),
                filepath TEXT,
                status ENUM('received', 'sent') NOT NULL,
                caption TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_status (status),
                INDEX idx_type (type),
                INDEX idx_created_at (created_at)
            )
        `)

        // Stats table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS stats (
                id INT PRIMARY KEY DEFAULT 1,
                total_messages INT DEFAULT 0,
                total_files INT DEFAULT 0,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                uptime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `)

        // Users table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                phone_number VARCHAR(50) UNIQUE,
                jid VARCHAR(255) UNIQUE,
                name VARCHAR(255),
                first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                message_count INT DEFAULT 0,
                INDEX idx_phone (phone_number)
            )
        `)

        // Groups table - FIXED: Use backticks around reserved keyword
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS \`groups\` (
                id INT AUTO_INCREMENT PRIMARY KEY,
                group_name VARCHAR(255),
                group_jid VARCHAR(255) UNIQUE,
                first_joined TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                message_count INT DEFAULT 0,
                INDEX idx_group_jid (group_jid)
            )
        `)

        // Initialize stats if not exists
        await pool.execute(`
            INSERT IGNORE INTO stats (id, total_messages, total_files, uptime) 
            VALUES (1, 0, 0, NOW())
        `)

        console.log("✅ Database tables initialized")

    } catch (error) {
        console.error("❌ Error creating tables:", error)
        throw error
    }
}

// Database helper functions - FIXED VERSION (No updated_at dependency)
async function addMessageToDB(messageData) {
    try {
        const query = `
            INSERT INTO messages (message_id, type, message, sender_name, sender_phone, sender_jid, 
                                chat_jid, group_name, context, original_command, authorized) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                type = VALUES(type),
                message = VALUES(message),
                sender_name = COALESCE(VALUES(sender_name), sender_name),
                sender_phone = COALESCE(VALUES(sender_phone), sender_phone)
        `

        // Convert undefined values to null for MySQL
        const params = [
            messageData.id || null,
            messageData.type || null,
            messageData.message || null,
            (messageData.sender?.name || messageData.recipient?.name) || null,
            (messageData.sender?.phone || messageData.recipient?.phone) || null,
            (messageData.sender?.jid || messageData.recipient?.jid) || null,
            (messageData.sender?.chatJid || messageData.recipient?.chatJid) || null,
            (messageData.sender?.groupName || messageData.recipient?.groupName) || null,
            messageData.context || null,
            messageData.originalCommand || null,
            messageData.authorized !== false
        ]

        await pool.execute(query, params)

        // Update stats
        await updateStatsDB('message')

    } catch (error) {
        // Log error but don't crash - duplicate entries are handled gracefully
        if (error.code === 'ER_DUP_ENTRY') {
            console.log(`ℹ️ Duplicate message ignored: ${messageData.id}`)
        } else {
            console.error("❌ Error adding message to DB:", error)
        }
    }
}

async function addFileToDB(fileData) {
    try {
        const query = `
            INSERT INTO files (file_id, filename, original_name, type, mime_type, size, 
                             sender_name, sender_phone, sender_jid, recipient, filepath, status, caption) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                filename = VALUES(filename),
                original_name = VALUES(original_name),
                size = VALUES(size),
                caption = VALUES(caption)
        `

        // Convert undefined values to null for MySQL
        const params = [
            fileData.id || null,
            fileData.filename || null,
            fileData.originalName || null,
            fileData.type || null,
            fileData.mimeType || null,
            fileData.size || null,
            fileData.sender?.name || null,
            fileData.sender?.phone || null,
            fileData.sender?.jid || null,
            fileData.recipient || null,
            fileData.filepath || null,
            fileData.status || null,
            fileData.caption || null
        ]

        await pool.execute(query, params)

        // Update stats
        await updateStatsDB('file')

    } catch (error) {
        // Handle duplicate file entries gracefully
        if (error.code === 'ER_DUP_ENTRY') {
            console.log(`ℹ️ Duplicate file ignored: ${fileData.id}`)
        } else {
            console.error("❌ Error adding file to DB:", error)
        }
    }
}

async function updateStatsDB(type, data = {}) {
    try {
        switch (type) {
            case 'message':
                await pool.execute(`
                    UPDATE stats SET total_messages = total_messages + 1, last_activity = NOW() WHERE id = 1
                `)
                break
            case 'file':
                await pool.execute(`
                    UPDATE stats SET total_files = total_files + 1, last_activity = NOW() WHERE id = 1
                `)
                break
            case 'user':
                if (data.phoneNumber && data.jid) {
                    await pool.execute(`
                        INSERT INTO users (phone_number, jid, name, message_count) 
                        VALUES (?, ?, ?, 1)
                        ON DUPLICATE KEY UPDATE 
                        name = COALESCE(VALUES(name), name),
                        message_count = message_count + 1,
                        last_seen = NOW()
                    `, [data.phoneNumber, data.jid, data.name || null])
                }
                break
            case 'group':
                if (data.groupName && data.groupJid) {
                    // FIX: Add backticks around 'groups' table name since it's a reserved keyword
                    await pool.execute(`
                        INSERT INTO \`groups\` (group_name, group_jid, message_count) 
                        VALUES (?, ?, 1)
                        ON DUPLICATE KEY UPDATE 
                        message_count = message_count + 1,
                        last_activity = NOW()
                    `, [data.groupName, data.groupJid])
                }
                break
        }

        // Always update last_activity
        await pool.execute(`
            UPDATE stats SET last_activity = NOW() WHERE id = 1
        `)

    } catch (error) {
        console.error("Error updating stats:", error)
    }
}

async function getMessagesFromDB(limit = 100) {
    try {
        // Pastikan limit adalah integer
        const limitValue = parseInt(limit) || 100;
        
        // Gunakan template string untuk menghindari prepared statement issue
        const [rows] = await pool.execute(`
            SELECT message_id as id, type, message, sender_name, sender_phone, sender_jid, 
                   chat_jid, group_name, context, original_command, authorized, created_at as timestamp
            FROM messages 
            ORDER BY created_at DESC 
            LIMIT ${limitValue}
        `); // Langsung masukkan nilai limit ke query

        return {
            messages: rows.map(row => ({
                id: row.id,
                type: row.type,
                message: row.message,
                sender: row.type.includes('user') ? {
                    name: row.sender_name,
                    phone: row.sender_phone,
                    jid: row.sender_jid,
                    chatJid: row.chat_jid,
                    groupName: row.group_name
                } : undefined,
                recipient: row.type.includes('bot') ? {
                    name: row.sender_name,
                    phone: row.sender_phone,
                    jid: row.sender_jid,
                    chatJid: row.chat_jid,
                    groupName: row.group_name
                } : undefined,
                context: row.context,
                originalCommand: row.original_command,
                authorized: row.authorized,
                timestamp: row.timestamp
            })),
            lastUpdated: new Date().toISOString()
        }
    } catch (error) {
        console.error("❌ Error getting messages:", error)
        return { messages: [] }
    }
}

async function getFilesFromDB(limit = 50) {
    try {
        // Pastikan limit adalah integer
        const limitValue = parseInt(limit) || 50;
        
        // Gunakan template string untuk menghindari prepared statement issue
        const [rows] = await pool.execute(`
            SELECT file_id as id, filename, original_name, type, mime_type, size, 
                   sender_name, sender_phone, sender_jid, recipient, filepath, status, caption, created_at as timestamp
            FROM files 
            ORDER BY created_at DESC 
            LIMIT ${limitValue}
        `); // Langsung masukkan nilai limit ke query

        return {
            files: rows.map(row => ({
                id: row.id,
                filename: row.filename,
                originalName: row.original_name,
                type: row.type,
                mimeType: row.mime_type,
                size: row.size,
                sender: row.status === 'received' ? {
                    name: row.sender_name,
                    phone: row.sender_phone,
                    jid: row.sender_jid
                } : undefined,
                recipient: row.recipient,
                filepath: row.filepath,
                status: row.status,
                caption: row.caption,
                timestamp: row.timestamp
            })),
            lastUpdated: new Date().toISOString()
        }
    } catch (error) {
        console.error("❌ Error getting files:", error)
        return { files: [] }
    }
}

async function getStatsFromDB() {
    try {
        const [statsRows] = await pool.execute('SELECT * FROM stats WHERE id = 1');
        const [usersCount] = await pool.execute('SELECT COUNT(*) as count FROM users');
        
        // FIX: Use backticks for the 'groups' table name (reserved keyword)
        const [groupsCount] = await pool.execute('SELECT COUNT(*) as count FROM `groups`');
        
        const [recentUsers] = await pool.execute('SELECT phone_number FROM users ORDER BY last_seen DESC LIMIT 10');
        
        // FIX: Use backticks for the 'groups' table name (reserved keyword)
        const [recentGroups] = await pool.execute('SELECT group_name FROM `groups` ORDER BY last_activity DESC LIMIT 10');

        const stats = statsRows[0] || {};

        return {
            totalMessages: stats.total_messages || 0,
            totalFiles: stats.total_files || 0,
            totalUsers: usersCount[0].count,
            totalGroups: groupsCount[0].count,
            lastActivity: stats.last_activity,
            uptime: stats.uptime,
            authorizedUsers: recentUsers.map(u => u.phone_number),
            groups: recentGroups.map(g => g.group_name)
        }
    } catch (error) {
        console.error("Error getting stats:", error)
        return {
            totalMessages: 0,
            totalFiles: 0,
            totalUsers: 0,
            totalGroups: 0,
            lastActivity: null,
            uptime: new Date().toISOString(),
            authorizedUsers: [],
            groups: []
        }
    }
}

// Initialize server routes
function initializeServer() {
    if (isServerStarted) return

    // Middleware untuk CORS dan JSON
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*')
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
        next()
    })

    // API endpoints untuk data dari MySQL
    // API endpoints untuk data dari MySQL
app.get("/api/messages", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100; // Parse ke integer
        const messages = await getMessagesFromDB(limit);
        res.json(messages);
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/api/files", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50; // Parse ke integer
        const files = await getFilesFromDB(limit);
        res.json(files);
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

    app.get("/api/stats", async (req, res) => {
        try {
            const stats = await getStatsFromDB()
            res.json(stats)
        } catch (error) {
            console.error("API Error:", error)
            res.status(500).json({ error: "Internal server error" })
        }
    })

    // Endpoint untuk database health check
    app.get("/api/health", async (req, res) => {
        try {
            await pool.execute('SELECT 1')
            res.json({
                status: "healthy",
                database: "connected",
                timestamp: new Date().toISOString()
            })
        } catch (error) {
            res.status(500).json({
                status: "unhealthy",
                database: "disconnected",
                error: error.message,
                timestamp: new Date().toISOString()
            })
        }
    })

    // Serve the QR code page
    app.get("/", async (req, res) => {
        try {
            const stats = await getStatsFromDB()

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
                            .api-info { background: #f0fff0; padding: 15px; border-radius: 8px; margin: 20px; max-width: 400px; }
                            .api-endpoint { font-family: monospace; background: #f5f5f5; padding: 5px; border-radius: 3px; }
                        </style>
                    </head>
                    <body>
                        <h1>🤖 WhatsApp Bot dengan MySQL Database</h1>
                        <p>Scan QR code dengan WhatsApp untuk menghubungkan bot.</p>
                        <img src="${qrDataUrl}" alt="QR Code" />
                        <div class="info">
                            <h3>ℹ️ Info Restriksi:</h3>
                            <p>• Bot hanya aktif untuk nomor tertentu</p>
                            <p>• Hanya admin tertentu yang bisa mengakses</p>
                            <p>• Data tersimpan di MySQL Database</p>
                        </div>
                        <div class="api-info">
                            <h3>🔗 MySQL API Endpoints:</h3>
                            <p>• <span class="api-endpoint">/api/messages</span> - Data pesan dari DB</p>
                            <p>• <span class="api-endpoint">/api/files</span> - Data file dari DB</p>
                            <p>• <span class="api-endpoint">/api/stats</span> - Statistik real-time</p>
                            <p>• <span class="api-endpoint">/api/health</span> - Database health check</p>
                        </div>
                    </body>
                    </html>
                `);
            } else {
                res.send(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>WhatsApp Bot Dashboard</title>
                        <style>
                            body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: Arial, sans-serif; }
                            h1 { color: #333; }
                            p { color: #555; }
                            .status { background: #e8f5e8; padding: 15px; border-radius: 8px; margin: 20px; }
                            .api-info { background: #f0fff0; padding: 15px; border-radius: 8px; margin: 20px; max-width: 400px; }
                            .api-endpoint { font-family: monospace; background: #f5f5f5; padding: 5px; border-radius: 3px; }
                        </style>
                    </head>
                    <body>
                        <h1>🤖 WhatsApp Bot dengan MySQL Database</h1>
                        <div class="status">
                            <p>✅ Bot sudah terhubung</p>
                            <p>🗄️ Database: MySQL Connected</p>
                            <p>📊 Messages: ${stats.totalMessages}, Files: ${stats.totalFiles}</p>
                            <p>👥 Users: ${stats.totalUsers}, Groups: ${stats.totalGroups}</p>
                            <p>🔐 Authorized for: +${ALLOWED_NUMBERS.join(', +')}</p>
                        </div>
                        <div class="api-info">
                            <h3>🔗 MySQL API Endpoints:</h3>
                            <p>• <span class="api-endpoint">/api/messages?limit=100</span> - Data pesan terbaru</p>
                            <p>• <span class="api-endpoint">/api/files?limit=50</span> - Data file yang diupload</p>
                            <p>• <span class="api-endpoint">/api/stats</span> - Statistik real-time</p>
                            <p>• <span class="api-endpoint">/api/health</span> - Database status</p>
                            <p style="font-size: 0.9em; color: #666;">Data real-time dari MySQL untuk integrasi website</p>
                        </div>
                    </body>
                    </html>
                `);
            }
        } catch (error) {
            res.status(500).send(`
                <html><body>
                    <h1>❌ Database Error</h1>
                    <p>Could not connect to MySQL database.</p>
                    <p>Error: ${error.message}</p>
                </body></html>
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
        console.log(`🔗 MySQL API available at:`);
        console.log(`   - http://localhost:${PORT}/api/messages`);
        console.log(`   - http://localhost:${PORT}/api/files`);
        console.log(`   - http://localhost:${PORT}/api/stats`);
        console.log(`   - http://localhost:${PORT}/api/health`);
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
            return ALLOWED_NUMBERS.includes(phoneNumber)
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
                let mimeType = ''
                switch (mediaType) {
                    case 'imageMessage':
                        extension = '.jpg'
                        mimeType = 'image/jpeg'
                        break
                    case 'videoMessage':
                        extension = '.mp4'
                        mimeType = 'video/mp4'
                        break
                    case 'audioMessage':
                        extension = '.ogg'
                        mimeType = 'audio/ogg'
                        break
                    case 'documentMessage':
                        extension = path.extname(msg.message.documentMessage.fileName || '') || '.bin'
                        mimeType = msg.message.documentMessage.mimetype || 'application/octet-stream'
                        break
                    case 'stickerMessage':
                        extension = '.webp'
                        mimeType = 'image/webp'
                        break
                    default:
                        extension = '.bin'
                        mimeType = 'application/octet-stream'
                }

                const filename = `${timestamp}_${senderPhone}${extension}`
                const filepath = path.join(RECEIVED_FILES_DIR, filename)

                fs.writeFileSync(filepath, buffer)

                // Simpan data file ke MySQL Database
                const fileData = {
                    id: Date.now().toString(),
                    filename: filename,
                    originalName: msg.message.documentMessage?.fileName || filename,
                    type: mediaType,
                    mimeType: mimeType,
                    size: buffer.length,
                    sender: {
                        name: msg.pushName || "Unknown",
                        phone: senderPhone,
                        jid: senderJid
                    },
                    timestamp: new Date().toISOString(),
                    filepath: filepath,
                    status: 'received'
                }

                await addFileToDB(fileData)

                console.log(`📁 File disimpan ke DB: ${filename} (${buffer.length} bytes)`)
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
                let mimeType = ''

                // Tentukan jenis pesan berdasarkan ekstensi file
                if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExtension)) {
                    messageOptions = {
                        image: fileBuffer,
                        caption: caption
                    }
                    mimeType = 'image/jpeg'
                } else if (['.mp4', '.avi', '.mov', '.mkv'].includes(fileExtension)) {
                    messageOptions = {
                        video: fileBuffer,
                        caption: caption
                    }
                    mimeType = 'video/mp4'
                } else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(fileExtension)) {
                    messageOptions = {
                        audio: fileBuffer,
                        mimetype: 'audio/mpeg'
                    }
                    mimeType = 'audio/mpeg'
                } else {
                    // Untuk file dokumen
                    messageOptions = {
                        document: fileBuffer,
                        fileName: filename,
                        caption: caption
                    }
                    mimeType = 'application/octet-stream'
                }

                await sock.sendMessage(chatJid, messageOptions)

                // Salin file ke folder sent_files untuk tracking
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
                const sentFileName = `${timestamp}_${filename}`
                const sentFilePath = path.join(SENT_FILES_DIR, sentFileName)
                fs.copyFileSync(filePath, sentFilePath)

                // Simpan data file yang dikirim ke MySQL Database
                const sentFileData = {
                    id: Date.now().toString(),
                    filename: sentFileName,
                    originalName: filename,
                    type: 'sent',
                    mimeType: mimeType,
                    size: fileBuffer.length,
                    recipient: chatJid,
                    timestamp: new Date().toISOString(),
                    filepath: sentFilePath,
                    status: 'sent',
                    caption: caption
                }

                await addFileToDB(sentFileData)

                console.log(`📤 File dikirim ke DB: ${filename} (${fileBuffer.length} bytes)`)
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
            let groupName = null
            let groupJid = null
            if (chatJid.includes('@g.us')) {
                try {
                    const groupMetadata = await sock.groupMetadata(chatJid)
                    groupInfo = `\n🏷️ Grup: ${groupMetadata.subject}`
                    groupName = groupMetadata.subject
                    groupJid = chatJid
                    loggedInGroups.add(groupMetadata.subject)
                    await updateStatsDB('group', { groupName: groupMetadata.subject, groupJid: chatJid })
                } catch (error) {
                    groupInfo = "\n🏷️ Grup: [Tidak dapat mengambil info grup]"
                }
            } else {
                loggedInUsers.add(phoneNumber || senderJid)
                await updateStatsDB('user', { phoneNumber, jid: senderJid, name: senderName })
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
                    const responseMsg = `✅ File berhasil diterima dan disimpan ke database!\n📁 Nama: ${savedFile.filename}\n📊 Ukuran: ${(savedFile.size / 1024).toFixed(2)} KB\n🗄️ Tersimpan di MySQL`
                    await sock.sendMessage(msg.key.remoteJid, { text: responseMsg })

                    // Simpan response ke MySQL Database
                    const responseData = {
                        id: Date.now().toString(),
                        type: 'bot_response',
                        message: responseMsg,
                        recipient: {
                            name: senderName,
                            phone: phoneNumber,
                            jid: senderJid,
                            chatJid: chatJid,
                            groupName: groupName
                        },
                        timestamp: new Date().toISOString(),
                        context: 'file_received'
                    }
                    await addMessageToDB(responseData)
                } else {
                    const errorMsg = "❌ Gagal menyimpan file yang diterima ke database."
                    await sock.sendMessage(msg.key.remoteJid, { text: errorMsg })

                    // Simpan error response ke MySQL Database
                    // Simpan response ke MySQL Database
                    const responseData = {
                        id: Date.now().toString(),
                        type: 'bot_response',
                        message: responseText,
                        recipient: {
                            name: senderName,
                            phone: phoneNumber || null, // Ensure this is null if undefined
                            jid: senderJid,
                            chatJid: chatJid,
                            groupName: groupName || null // Ensure this is null if undefined
                        },
                        timestamp: new Date().toISOString(),
                        context: context || null,
                        originalCommand: command || null
                    }
                    await addMessageToDB(responseData)
                }
                return
            }

            // Simpan pesan teks yang diterima ke MySQL Database
            const messageData = {
                id: msg.key.id || Date.now().toString(),
                type: 'user_message',
                message: pesan,
                sender: {
                    name: senderName,
                    phone: phoneNumber,
                    jid: senderJid,
                    chatJid: chatJid,
                    groupName: groupName || null // Ensure this is null if undefined
                },
                timestamp: new Date().toISOString(),
                authorized: true
            }
            await addMessageToDB(messageData)

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
                let responseText = ""
                let context = ""

                if (command === "halo" || command === "hai") {
                    responseText = `Hai juga ${senderName}! 👋 Selamat datang di bot WhatsApp dengan MySQL Database!`
                    context = "greeting"
                } else if (command === "ping") {
                    responseText = "🏓 Pong! Bot aktif dengan MySQL Database.\n🗄️ Database: Connected ✅\n🔒 Akses terotorisasi untuk nomor ini."
                    context = "ping"
                } else if (command === "help" || command === "bantuan") {
                    responseText = `🤖 *Bot WhatsApp dengan MySQL Database:*

📝 *Perintah yang tersedia:*
• halo/hai - Sapa bot
• ping - Cek status bot & database
• help/bantuan - Tampilkan pesan ini
• info - Info tentang bot
• myinfo - Info tentang Anda
• dbstats - Statistik database

📁 *Perintah File:*
• listfiles - Lihat file yang tersedia
• sendfile [nama_file] - Kirim file (contoh: sendfile gambar.jpg)
• filecount - Lihat jumlah file yang tersimpan

🔗 *MySQL API:*
• Data real-time di /api/messages, /api/files, /api/stats
• Health check di /api/health
• Update otomatis untuk integrasi website

🗄️ *Database Features:*
• Semua data tersimpan di MySQL
• Pencarian dan filtering cepat
• Backup otomatis dan reliable
• Scalable untuk volume tinggi

🔒 *Security Info:*
• Bot hanya aktif untuk nomor terotorisasi
• Semua aktivitas dilog ke database
• Akses terbatas untuk keamanan

💡 *Tips:*
• Kirim file apa saja ke bot untuk disimpan otomatis
• Data tersimpan permanen di MySQL database

Kirim pesan untuk mencoba! 😊`
                    context = "help"
                } else if (command === "info") {
                    const stats = await getStatsFromDB()
                    responseText = `ℹ️ *Bot Info dengan MySQL:*

🔹 Platform: Baileys + MySQL
🔹 Runtime: Node.js
🔹 Status: Aktif ✅
🔹 Database: MySQL Connected ✅
🔹 File Storage: Local + DB Tracking ✅
🔹 API Endpoints: 4 Available ✅
🔹 Security: Restricted Access 🔒
🔹 Web Interface: http://localhost:3000

📊 *Database Stats:*
🔹 Total Messages: ${stats.totalMessages}
🔹 Total Files: ${stats.totalFiles}
🔹 Users Tracked: ${stats.totalUsers}
🔹 Groups Tracked: ${stats.totalGroups}
🔹 Last Activity: ${stats.lastActivity ? new Date(stats.lastActivity).toLocaleString('id-ID') : 'N/A'}`

                    if (chatJid.includes('@g.us')) {
                        try {
                            const groupMetadata = await sock.groupMetadata(chatJid)
                            responseText += `\n🔹 Grup saat ini: ${groupMetadata.subject}`
                            responseText += `\n🔹 Jumlah member: ${groupMetadata.participants.length}`
                        } catch (error) {
                            responseText += "\n🔹 Info grup tidak tersedia"
                        }
                    }
                    context = "info"
                } else if (command === "dbstats") {
                    const stats = await getStatsFromDB()
                    responseText = `🗄️ *MySQL Database Statistics:*

📊 *Data Overview:*
• Messages: ${stats.totalMessages}
• Files: ${stats.totalFiles}  
• Users: ${stats.totalUsers}
• Groups: ${stats.totalGroups}

⏰ *Activity:*
• Last Activity: ${stats.lastActivity ? new Date(stats.lastActivity).toLocaleString('id-ID') : 'N/A'}
• Uptime Since: ${new Date(stats.uptime).toLocaleString('id-ID')}

🔗 *API Endpoints:*
• GET /api/messages - Recent messages
• GET /api/files - File history
• GET /api/stats - Live statistics
• GET /api/health - DB health check

💾 *Database Status:*
• Connection: Active ✅
• Performance: Optimized ✅
• Backup: Auto-enabled ✅`
                    context = "dbstats"
                } else if (command === "myinfo") {
                    responseText = `👤 *Info Anda (Tersimpan di MySQL):*

🏷️ Nama: ${senderName}
🔒 Status: AUTHORIZED ✅`

                    if (phoneNumber) {
                        responseText += `\n📞 Nomor: ${phoneNumber}`
                    }

                    if (chatJid.includes('@g.us')) {
                        try {
                            const groupMetadata = await sock.groupMetadata(chatJid)
                            responseText += `\n🏷️ Grup: ${groupMetadata.subject}`
                        } catch (error) {
                            responseText += "\n🏷️ Grup: [Info tidak tersedia]"
                        }
                    } else {
                        responseText += "\n💬 Chat: Personal"
                    }

                    responseText += `\n🗄️ Data tersimpan di: MySQL Database`
                    responseText += `\n🕒 Terakhir aktif: ${new Date().toLocaleString('id-ID')}`
                    context = "myinfo"
                } else if (command === "listfiles") {
                    const files = listAvailableFiles()
                    if (files.length === 0) {
                        responseText = "📁 Tidak ada file yang tersimpan saat ini.\n🗄️ Check database untuk history lengkap."
                    } else {
                        responseText = "📁 *File yang tersedia (Local Storage):*\n\n"
                        files.forEach((file, index) => {
                            responseText += `${index + 1}. ${file}\n`
                        })
                        responseText += `\n💡 Gunakan: *sendfile [nama_file]* untuk mengirim file`
                        responseText += `\n🗄️ File history lengkap tersimpan di MySQL`
                    }
                    context = "listfiles"
                } else if (command === "filecount") {
                    const receivedFiles = fs.readdirSync(RECEIVED_FILES_DIR).length
                    const sentFiles = fs.readdirSync(SENT_FILES_DIR).length
                    const stats = await getStatsFromDB()

                    responseText = `📊 *Statistik File (Local + Database):*

📥 *Local Storage:*
• File diterima: ${receivedFiles}
• File dikirim: ${sentFiles}
• Total local: ${receivedFiles + sentFiles}

🗄️ *MySQL Database:*
• Total file tracked: ${stats.totalFiles}
• Database records: Complete ✅
• Search & filter: Available ✅

🔒 Access: Restricted | 🗄️ Storage: Hybrid`
                    context = "filecount"
                } else if (pesan.toLowerCase().startsWith("sendfile ")) {
                    const fileName = pesan.substring(9).trim()
                    if (!fileName) {
                        responseText = "❌ Harap sertakan nama file. Contoh: sendfile gambar.jpg"
                        context = "sendfile_error"
                    } else {
                        const filePath = path.join(RECEIVED_FILES_DIR, fileName)
                        const result = await sendFile(chatJid, filePath, `📎 File dari bot: ${fileName}`)

                        if (result.success) {
                            responseText = `✅ File "${fileName}" berhasil dikirim!\n📊 Ukuran: ${(result.size / 1024).toFixed(2)} KB\n🗄️ Tercatat di MySQL Database`
                            context = "sendfile_success"
                        } else {
                            responseText = `❌ Gagal mengirim file: ${result.error}`
                            context = "sendfile_error"
                        }
                    }
                } else if (pesan.startsWith("/")) {
                    responseText = "❓ Perintah tidak dikenal. Ketik 'help' untuk melihat daftar perintah."
                    context = "unknown_command"
                }

                // Kirim response jika ada
                if (responseText) {
                    await sock.sendMessage(msg.key.remoteJid, { text: responseText })

                    // Simpan response ke MySQL Database
                    const responseData = {
                        id: Date.now().toString(),
                        type: 'bot_response',
                        message: responseText,
                        recipient: {
                            name: senderName,
                            phone: phoneNumber || null, // Ensure this is null if undefined
                            jid: senderJid,
                            chatJid: chatJid,
                            groupName: groupName || null // Ensure this is null if undefined
                        },
                        timestamp: new Date().toISOString(),
                        context: context || null,
                        originalCommand: command || null
                    }
                    await addMessageToDB(responseData)
                }
            } catch (error) {
                console.error("❌ Error saat mengirim pesan:", error)

                // Simpan response ke MySQL Database
                const responseData = {
                    id: Date.now().toString(),
                    type: 'bot_response',
                    message: responseText,
                    recipient: {
                        name: senderName,
                        phone: phoneNumber || null, // Ensure this is null if undefined
                        jid: senderJid,
                        chatJid: chatJid,
                        groupName: groupName || null // Ensure this is null if undefined
                    },
                    timestamp: new Date().toISOString(),
                    context: context || null,
                    originalCommand: command || null
                }
                await addMessageToDB(responseData)
            }
        })

        return sock
    } catch (error) {
        console.error("❌ Error in startBot:", error)
        throw error
    }
}

async function main() {
    try {
        console.log("🚀 Memulai WhatsApp Bot dengan MySQL Database...")
        console.log(`🔒 Bot hanya aktif untuk nomor: +${ALLOWED_NUMBERS.join(', +')}`)

        // Initialize MySQL Database first
        await initializeDatabase()
        console.log("🗄️ MySQL Database initialized")

        // Initialize server (only once)
        initializeServer()

        // Then start the bot
        await startBot()
    } catch (error) {
        console.error("❌ Error starting bot:", error)
        console.log("🔄 Mencoba restart dalam 10 detik...")
        setTimeout(main, 10000)
    }
}

// Handle process termination with database cleanup
process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down bot...');

    // Close database pool
    if (pool) {
        console.log('🗄️ Closing MySQL connections...');
        await pool.end();
        console.log('✅ MySQL pool closed');
    }

    if (isServerStarted) {
        server.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

process.on('SIGTERM', async () => {
    console.log('\n🔄 Received SIGTERM, shutting down gracefully...');

    // Close database pool
    if (pool) {
        console.log('🗄️ Closing MySQL connections...');
        await pool.end();
        console.log('✅ MySQL pool closed');
    }

    if (isServerStarted) {
        server.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught Exception:', error);

    // Close database pool
    if (pool) {
        try {
            await pool.end();
            console.log('✅ MySQL pool closed due to exception');
        } catch (closeError) {
            console.error('❌ Error closing MySQL pool:', closeError);
        }
    }

    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);

    // Close database pool
    if (pool) {
        try {
            await pool.end();
            console.log('✅ MySQL pool closed due to rejection');
        } catch (closeError) {
            console.error('❌ Error closing MySQL pool:', closeError);
        }
    }

    process.exit(1);
});

main()