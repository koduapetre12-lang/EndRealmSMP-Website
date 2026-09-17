const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const JWT_SECRET = 'endrealm_secret_key_2026';
let db;
const ADMIN_USERNAMES = ['petriko__', 'პეტრე', 'petre'];

(async () => {
    try {
        db = await open({
            filename: path.join(__dirname, 'database.sqlite'),
            driver: sqlite3.Database
        });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                role TEXT DEFAULT 'user',
                last_spin TEXT
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                item_name TEXT,
                item_icon TEXT,
                status TEXT DEFAULT 'available',
                claimed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        `);

        try { await db.exec(`ALTER TABLE inventory ADD COLUMN status TEXT DEFAULT 'available'`); } catch (e) {}
        try { await db.exec(`ALTER TABLE inventory ADD COLUMN claimed_at DATETIME`); } catch (e) {}

        await db.run(`
            DELETE FROM inventory 
            WHERE status = 'claimed' 
            AND datetime(claimed_at, '+3 days') <= datetime('now')
        `);

        await db.run(`UPDATE users SET role = 'admin' WHERE LOWER(username) IN ('petriko__', 'პეტრე', 'petre')`);
        console.log('ბაზა მზადაა!');
    } catch (err) {
        console.error('ბაზის შეცდომა:', err);
    }
})();

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'ავტორიზაცია აუცილებელია' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'არავალიდური ტოკენი' });
        req.user = user;
        next();
    });
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'შეავსეთ ყველა ველი' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const role = ADMIN_USERNAMES.includes(username.trim().toLowerCase()) ? 'admin' : 'user';
        await db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username.trim(), hashedPassword, role]);
        res.json({ message: 'რეგისტრაცია წარმატებულია!' });
    } catch (err) {
        res.status(400).json({ error: 'მომხმარებელი უკვე არსებობს' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username.trim()]);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: 'არასწორი მონაცემები' });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
    res.json({ token, username: user.username, role: user.role });
});

const prizes = [
    { name: "Iron Tools", icon: "fa-hammer" },
    { name: "Diamond Tools", icon: "fa-wand-magic-sparkles" },
    { name: "Diamond Set", icon: "fa-shield-halved" },
    { name: "Netherite (2)", icon: "fa-cubes" },
    { name: "Iron Set", icon: "fa-shirt" },
    { name: "1000$", icon: "fa-sack-dollar" },
    { name: "64x G-Apples", icon: "fa-apple-whole" }
];

app.post('/api/spin', authenticateToken, async (req, res) => {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'მომხმარებელი ვერ მოიძებნა' });

    const now = new Date();
    if (user.last_spin) {
        const hoursPassed = (now - new Date(user.last_spin)) / (1000 * 60 * 60);
        if (hoursPassed < 24) {
            return res.status(400).json({ error: `სპინი ხელმისაწვდომი იქნება ${Math.ceil(24 - hoursPassed)} საათში!` });
        }
    }

    const wonPrize = prizes[Math.floor(Math.random() * prizes.length)];
    await db.run('INSERT INTO inventory (user_id, item_name, item_icon, status) VALUES (?, ?, ?, "available")', [user.id, wonPrize.name, wonPrize.icon]);
    await db.run('UPDATE users SET last_spin = ? WHERE id = ?', [now.toISOString(), user.id]);
    res.json({ prizeIndex: prizes.indexOf(wonPrize), prize: wonPrize });
});

app.get('/api/inventory', authenticateToken, async (req, res) => {
    await db.run(`DELETE FROM inventory WHERE status = 'claimed' AND datetime(claimed_at, '+3 days') <= datetime('now')`);
    const items = await db.all('SELECT * FROM inventory WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json(items);
});

app.post('/api/inventory/claim/:id', authenticateToken, async (req, res) => {
    const now = new Date().toISOString();
    await db.run('UPDATE inventory SET status = "claimed", claimed_at = ? WHERE id = ? AND user_id = ?', [now, req.params.id, req.user.id]);
    res.json({ message: 'გადატანილია' });
});

app.delete('/api/inventory/delete/:id', authenticateToken, async (req, res) => {
    await db.run('DELETE FROM inventory WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'წაიშალა' });
});

app.get('/api/admin/users', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'უარყოფილია' });
    const users = await db.all('SELECT id, username, role FROM users');
    for (let u of users) {
        u.inventory = await db.all('SELECT * FROM inventory WHERE user_id = ?', [u.id]);
    }
    res.json(users);
});

app.delete('/api/admin/item/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'უარყოფილია' });
    await db.run('DELETE FROM inventory WHERE id = ?', [req.params.id]);
    res.json({ message: 'წაიშალა' });
});

app.listen(5000, () => console.log('http://localhost:5000 გაშვეულია'));
