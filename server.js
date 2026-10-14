const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Vercel & GitHub API Integration settings
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || !!process.env.VERCEL;
const SEED_DB_PATH = path.join(__dirname, 'whitelist.json');
const DB_PATH = isVercel ? path.join('/tmp', 'whitelist.json') : SEED_DB_PATH;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'artaokai';
const GITHUB_REPO = process.env.GITHUB_REPO || 'ArtFlow-Backend';
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH || 'whitelist.json';

let githubCache = {
    data: null,
    sha: null,
    lastFetched: 0
};

// Universal HTTP fetch helper (supports Node 18+ fetch or fallback https module)
function httpFetch(urlStr, options = {}) {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch(urlStr, options);
    }
    return new Promise((resolve, reject) => {
        const https = require('https');
        const url = new URL(urlStr);
        const reqOptions = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };
        const req = https.request(reqOptions, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: async () => JSON.parse(body),
                    text: async () => body
                });
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// CORS Middleware for Android App & Web client access
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static frontend dashboard from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Helper function to read whitelist database (GitHub API or Local FS)
async function readWhitelistDb() {
    // If GITHUB_TOKEN is available, try fetching directly from GitHub API
    if (GITHUB_TOKEN) {
        try {
            // Cache for 10s to minimize API requests during bursts
            if (githubCache.data && (Date.now() - githubCache.lastFetched < 10000)) {
                return githubCache.data;
            }

            const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
            const response = await httpFetch(apiUrl, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'ArtFlow-Backend-Server'
                }
            });

            if (response.ok) {
                const json = await response.json();
                githubCache.sha = json.sha;
                const contentStr = Buffer.from(json.content, 'base64').toString('utf8');
                githubCache.data = JSON.parse(contentStr);
                githubCache.lastFetched = Date.now();
                return githubCache.data;
            } else {
                console.warn(`[GitHub API] GET /contents failed with status ${response.status}`);
            }
        } catch (err) {
            console.error('[GitHub API] Error reading whitelist from GitHub:', err.message);
        }
    }

    // Fallback to local file system or in-memory cache
    if (githubCache.data) {
        return githubCache.data;
    }

    try {
        if (!fs.existsSync(DB_PATH)) {
            let initialData = { devices: [] };
            if (fs.existsSync(SEED_DB_PATH)) {
                try {
                    const seedData = fs.readFileSync(SEED_DB_PATH, 'utf8');
                    initialData = JSON.parse(seedData);
                } catch (_e) {}
            }
            try {
                fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2), 'utf8');
            } catch (_e) {}
            return initialData;
        }
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading local whitelist database:', err);
        return { devices: [] };
    }
}

// Helper function to write whitelist database (GitHub API & Local FS)
async function writeWhitelistDb(data, commitMessage = "Update whitelist.json via Admin Dashboard") {
    // Update memory cache
    githubCache.data = data;
    githubCache.lastFetched = Date.now();

    // Write to local file system if possible
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (_e) {}

    // If GITHUB_TOKEN is available, commit and push to GitHub Repo
    if (GITHUB_TOKEN) {
        try {
            const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;

            // Fetch current SHA if missing
            if (!githubCache.sha) {
                const getRes = await httpFetch(apiUrl, {
                    headers: {
                        'Authorization': `token ${GITHUB_TOKEN}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'ArtFlow-Backend-Server'
                    }
                });
                if (getRes.ok) {
                    const getJson = await getRes.json();
                    githubCache.sha = getJson.sha;
                }
            }

            const contentBase64 = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
            const putBody = {
                message: commitMessage,
                content: contentBase64,
                branch: 'main'
            };
            if (githubCache.sha) {
                putBody.sha = githubCache.sha;
            }

            const putRes = await httpFetch(apiUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'ArtFlow-Backend-Server'
                },
                body: JSON.stringify(putBody)
            });

            if (putRes.ok) {
                const putJson = await putRes.json();
                if (putJson.content && putJson.content.sha) {
                    githubCache.sha = putJson.content.sha;
                }
                console.log(`[GitHub API] Committed to ${GITHUB_REPO}/whitelist.json: "${commitMessage}"`);
                return true;
            } else {
                const errText = await putRes.text();
                console.error(`[GitHub API] PUT failed (${putRes.status}):`, errText);
            }
        } catch (err) {
            console.error('[GitHub API] Error committing to GitHub:', err.message);
        }
    }

    return true;
}

// 1. Endpoint POST /api/check-whitelist
app.post('/api/check-whitelist', async (req, res) => {
    try {
        const { deviceId } = req.body;

        if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
            return res.status(400).json({
                status: 'error',
                code: 400,
                message: 'Parameter deviceId wajib diisi.'
            });
        }

        const db = await readWhitelistDb();
        const cleanDeviceId = deviceId.trim();
        const device = db.devices.find(d => d.deviceId.toLowerCase() === cleanDeviceId.toLowerCase());

        if (!device) {
            return res.status(200).json({
                status: 'success',
                whitelisted: false,
                message: 'Perangkat tidak terdaftar dalam whitelist.'
            });
        }

        if (device.status !== 'active') {
            return res.status(200).json({
                status: 'success',
                whitelisted: false,
                message: `Perangkat terdaftar tetapi status non-aktif (${device.status}).`
            });
        }

        if (device.expiresAt) {
            const expiryDate = new Date(device.expiresAt);
            if (new Date() > expiryDate) {
                return res.status(200).json({
                    status: 'success',
                    whitelisted: false,
                    message: 'Masa aktif whitelist perangkat telah kedaluwarsa.'
                });
            }
        }

        const activeBroadcast = db.broadcast && db.broadcast.active ? {
            id: db.broadcast.id,
            title: db.broadcast.title,
            message: db.broadcast.message
        } : null;

        return res.status(200).json({
            status: 'success',
            whitelisted: true,
            deviceName: device.deviceName || 'Unknown Device',
            expiresAt: device.expiresAt || null,
            broadcast: activeBroadcast,
            message: 'Perangkat valid dan ter-whitelist.'
        });

    } catch (error) {
        console.error('API /check-whitelist error:', error);
        return res.status(500).json({
            status: 'error',
            code: 500,
            message: 'Internal server error: ' + error.message
        });
    }
});

// 2. Endpoint POST /api/add-device
app.post('/api/add-device', async (req, res) => {
    try {
        const { deviceId, deviceName, status, expiresAt } = req.body;

        if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
            return res.status(400).json({
                status: 'error',
                code: 400,
                message: 'Parameter deviceId wajib diisi.'
            });
        }

        const db = await readWhitelistDb();
        const cleanDeviceId = deviceId.trim();
        const existingIndex = db.devices.findIndex(d => d.deviceId.toLowerCase() === cleanDeviceId.toLowerCase());

        const deviceRecord = {
            deviceId: cleanDeviceId,
            deviceName: deviceName ? deviceName.trim() : (existingIndex >= 0 ? db.devices[existingIndex].deviceName : 'Android Device'),
            status: status ? status.toLowerCase() : 'active',
            registeredAt: existingIndex >= 0 ? db.devices[existingIndex].registeredAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: expiresAt || null
        };

        if (existingIndex >= 0) {
            db.devices[existingIndex] = deviceRecord;
            console.log(`[WHITELIST] Updated device: ${cleanDeviceId}`);
        } else {
            db.devices.push(deviceRecord);
            console.log(`[WHITELIST] Added new device: ${cleanDeviceId}`);
        }

        await writeWhitelistDb(db, `Add/Update device: ${cleanDeviceId}`);

        return res.status(200).json({
            status: 'success',
            message: existingIndex >= 0 ? 'Perangkat berhasil diperbarui.' : 'Perangkat berhasil ditambahkan ke whitelist.',
            device: deviceRecord
        });

    } catch (error) {
        console.error('API /add-device error:', error);
        return res.status(500).json({
            status: 'error',
            code: 500,
            message: 'Internal server error: ' + error.message
        });
    }
});

// 3. Endpoint GET /api/devices
app.get('/api/devices', async (req, res) => {
    try {
        const db = await readWhitelistDb();
        return res.status(200).json({
            status: 'success',
            devices: db.devices || []
        });
    } catch (error) {
        console.error('API /devices error:', error);
        return res.status(500).json({
            status: 'error',
            code: 500,
            message: 'Internal server error: ' + error.message
        });
    }
});

// 4. Endpoint DELETE /api/devices/:deviceId
app.delete('/api/devices/:deviceId', async (req, res) => {
    try {
        const deviceId = req.params.deviceId;
        const db = await readWhitelistDb();
        const initialLen = db.devices.length;

        db.devices = db.devices.filter(d => d.deviceId.toLowerCase() !== deviceId.toLowerCase());

        if (db.devices.length === initialLen) {
            return res.status(404).json({
                status: 'error',
                code: 404,
                message: 'Perangkat tidak ditemukan.'
            });
        }

        await writeWhitelistDb(db, `Delete device: ${deviceId}`);
        console.log(`[WHITELIST] Deleted device: ${deviceId}`);

        return res.status(200).json({
            status: 'success',
            message: 'Perangkat berhasil dihapus dari whitelist.'
        });
    } catch (error) {
        console.error('API DELETE /devices error:', error);
        return res.status(500).json({
            status: 'error',
            code: 500,
            message: 'Internal server error: ' + error.message
        });
    }
});

// 5. Endpoint GET /api/version
app.get('/api/version', async (req, res) => {
    try {
        const db = await readWhitelistDb();
        const updateInfo = db.updateInfo || {
            latestVersionCode: 1,
            latestVersionName: "1.0.0",
            updateUrl: "",
            releaseNotes: "Pembaruan sistem tersedia.",
            mandatory: false
        };
        return res.status(200).json(updateInfo);
    } catch (error) {
        console.error('API GET /version error:', error);
        return res.status(500).json({
            status: 'error',
            code: 500,
            message: 'Internal server error: ' + error.message
        });
    }
});

// 6. Endpoint POST /api/version
app.post('/api/version', async (req, res) => {
    try {
        const { latestVersionCode, latestVersionName, updateUrl, releaseNotes, mandatory } = req.body;

        const db = await readWhitelistDb();
        db.updateInfo = {
            latestVersionCode: parseInt(latestVersionCode) || 1,
            latestVersionName: latestVersionName ? latestVersionName.trim() : "1.0.0",
            updateUrl: updateUrl ? updateUrl.trim() : "",
            releaseNotes: releaseNotes ? releaseNotes.trim() : "",
            mandatory: !!mandatory
        };

        await writeWhitelistDb(db, `Update app version config (v${db.updateInfo.latestVersionName})`);

        return res.status(200).json({
            status: 'success',
            message: 'Konfigurasi update berhasil diperbarui.',
            updateInfo: db.updateInfo
        });
    } catch (error) {
        console.error('API POST /version error:', error);
        return res.status(500).json({
            status: 'error',
            code: 500,
            message: 'Internal server error: ' + error.message
        });
    }
});

// 7. Endpoint GET /api/broadcast
app.get('/api/broadcast', async (req, res) => {
    try {
        const db = await readWhitelistDb();
        return res.status(200).json(db.broadcast || { active: false });
    } catch (error) {
        console.error('API GET /broadcast error:', error);
        return res.status(500).json({ status: 'error', message: error.message });
    }
});

// 8. Endpoint POST /api/broadcast
app.post('/api/broadcast', async (req, res) => {
    try {
        const { title, message, active } = req.body;
        const db = await readWhitelistDb();

        db.broadcast = {
            id: 'bc_' + Date.now(),
            title: title ? title.trim() : 'Pengumuman',
            message: message ? message.trim() : '',
            active: !!active,
            timestamp: new Date().toISOString()
        };

        await writeWhitelistDb(db, `Update broadcast: ${db.broadcast.title}`);

        return res.status(200).json({
            status: 'success',
            message: active ? 'Broadcast berhasil dikirim ke semua user.' : 'Broadcast dinonaktifkan.',
            broadcast: db.broadcast
        });
    } catch (error) {
        console.error('API POST /broadcast error:', error);
        return res.status(500).json({ status: 'error', message: error.message });
    }
});

// 9. Endpoint POST /api/request-whitelist
app.post('/api/request-whitelist', async (req, res) => {
    try {
        const { deviceId, deviceName } = req.body;
        if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
            return res.status(400).json({ status: 'error', message: 'Parameter deviceId wajib diisi.' });
        }

        const db = await readWhitelistDb();
        const cleanDeviceId = deviceId.trim();
        const existingIndex = db.devices.findIndex(d => d.deviceId.toLowerCase() === cleanDeviceId.toLowerCase());

        const existingDevice = existingIndex >= 0 ? db.devices[existingIndex] : null;
        const newStatus = (existingDevice && existingDevice.status === 'active') ? 'active' : 'pending';

        const deviceRecord = {
            deviceId: cleanDeviceId,
            deviceName: deviceName ? deviceName.trim() : (existingDevice ? existingDevice.deviceName : 'Android User'),
            status: newStatus,
            registeredAt: existingDevice ? existingDevice.registeredAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: existingDevice ? existingDevice.expiresAt : null
        };

        if (existingIndex >= 0) {
            db.devices[existingIndex] = deviceRecord;
        } else {
            db.devices.push(deviceRecord);
        }

        await writeWhitelistDb(db, `New whitelist request from ${cleanDeviceId} (${deviceRecord.deviceName})`);

        return res.status(200).json({
            status: 'success',
            message: newStatus === 'active'
                ? 'Perangkat Anda sudah aktif dan ter-whitelist.'
                : 'Permohonan whitelist berhasil dikirim. Menunggu persetujuan admin.'
        });
    } catch (error) {
        console.error('API /request-whitelist error:', error);
        return res.status(500).json({ status: 'error', message: error.message });
    }
});

// 10. Endpoint POST /api/approve-device
app.post('/api/approve-device', async (req, res) => {
    try {
        const { deviceId, status } = req.body;
        if (!deviceId) {
            return res.status(400).json({ status: 'error', message: 'Device ID wajib diisi.' });
        }

        const db = await readWhitelistDb();
        const dev = db.devices.find(d => d.deviceId.toLowerCase() === deviceId.trim().toLowerCase());
        if (!dev) {
            return res.status(404).json({ status: 'error', message: 'Perangkat tidak ditemukan.' });
        }

        dev.status = status || 'active';
        dev.updatedAt = new Date().toISOString();
        await writeWhitelistDb(db, `Approve device: ${dev.deviceId} -> ${dev.status}`);

        console.log(`[WHITELIST] Device ${dev.deviceId} status updated to: ${dev.status}`);
        return res.status(200).json({
            status: 'success',
            message: `Perangkat berhasil di-${dev.status === 'active' ? 'approve' : dev.status}.`
        });
    } catch (error) {
        console.error('API /approve-device error:', error);
        return res.status(500).json({ status: 'error', message: error.message });
    }
});

// Start Server (only when run directly, not when required as a serverless module)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`==================================================`);
        console.log(`🚀 ArtFlow Whitelist Backend & Dashboard running on port ${PORT}`);
        console.log(`🌐 Dashboard URL: http://localhost:${PORT}`);
        console.log(`📁 Database path: ${DB_PATH}`);
        console.log(`==================================================`);
    });
}

module.exports = app;
