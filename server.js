const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// التأكد من وجود مجلد uploads لحفظ الملفات
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// الاتصال بقاعدة البيانات وإنشاء الجداول تلقائياً
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    // جدول الحسابات (المديرية + المخازن)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT
    )`);

    // جدول المهام والملفات
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        message TEXT,
        file_path TEXT,
        file_name TEXT,
        target_email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // إنشاء حساب المديرية الافتراضي (الإيميل: admin@admin.com / كلمة السر: 123456)
    db.get(`SELECT * FROM users WHERE role = 'admin'`, async (err, row) => {
        if (!row) {
            const hashedPassword = await bcrypt.hash('123456', 10);
            db.run(
                `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
                ['مقر المديرية', 'admin@admin.com', hashedPassword, 'admin']
            );
        }
    });
});

// إعدادات Express والجلسات
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// قراءة الملفات مباشرة من مجلد المشروع (الجذر) حيث توجد ملفات الـ HTML والصور
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));

app.use(session({
    secret: 'algeria_directorate_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // صالح لمدة 24 ساعة
}));

// إعداد رفع الملفات (يدعم الصور، PDF، Word، Excel...)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// حماية المسارات
function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.redirect('/login.html');
}

function isWarehouse(req, res, next) {
    if (req.session.user && req.session.user.role === 'warehouse') return next();
    res.redirect('/login.html');
}

// الصفحة الرئيسية توجه مباشرة لصفحة الدخول
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// تسجيل الدخول
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email.trim().toLowerCase()], async (err, user) => {
        if (err || !user) {
            return res.send('<script>alert("البريد الإلكتروني غير مسجل!"); window.location="/login.html";</script>');
        }
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
            if (user.role === 'admin') res.redirect('/admin.html');
            else res.redirect('/warehouse.html');
        } else {
            res.send('<script>alert("كلمة المرور غير صحيحة!"); window.location="/login.html";</script>');
        }
    });
});

// تسجيل الخروج
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login.html'));
});

// [المديرية] إضافة مخزن جديد
app.post('/admin/add-warehouse', isAdmin, async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'warehouse')`,
            [name, email.trim().toLowerCase(), hashedPassword],
            (err) => {
                if (err) {
                    return res.send('<script>alert("هذا البريد مستخدم لمخزن آخر!"); window.location="/admin.html";</script>');
                }
                res.redirect('/admin.html');
            }
        );
    } catch (e) {
        res.status(500).send('حدث خطأ في السيرفر');
    }
});

// [المديرية] حذف مخزن
app.post('/admin/delete-warehouse/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM users WHERE id = ? AND role = 'warehouse'`, [req.params.id], () => {
        res.redirect('/admin.html');
    });
});

// [المديرية] إرسال ملف أو عمل (للجميع أو لمخزن محدد)
app.post('/admin/send-task', isAdmin, upload.single('file'), (req, res) => {
    const { title, message, target_email } = req.body;
    const file_path = req.file ? `/uploads/${req.file.filename}` : null;
    const file_name = req.file ? Buffer.from(req.file.originalname, 'latin1').toString('utf8') : null;

    db.run(
        `INSERT INTO tasks (title, message, file_path, file_name, target_email) VALUES (?, ?, ?, ?, ?)`,
        [title, message, file_path, file_name, target_email],
        () => res.redirect('/admin.html')
    );
});

// [المديرية] حذف مهمة مرسلة
app.post('/admin/delete-task/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM tasks WHERE id = ?`, [req.params.id], () => {
        res.redirect('/admin.html');
    });
});

// [المديرية] جلب البيانات للوحة التحكم
app.get('/admin/data', isAdmin, (req, res) => {
    db.all(`SELECT id, name, email FROM users WHERE role = 'warehouse'`, [], (err, warehouses) => {
        db.all(`SELECT * FROM tasks ORDER BY created_at DESC`, [], (err, tasks) => {
            res.json({ warehouses, tasks });
        });
    });
});

// [المخزن] إرسال ملف أو تقرير إلى المديرية أو مخزن آخر أو الجميع
app.post('/warehouse/send-task', isWarehouse, upload.single('file'), (req, res) => {
    const { title, message, target_email } = req.body;
    const senderName = req.session.user.name;
    const fullTitle = `[من مخزن: ${senderName}] ${title}`;
    const file_path = req.file ? `/uploads/${req.file.filename}` : null;
    const file_name = req.file ? Buffer.from(req.file.originalname, 'latin1').toString('utf8') : null;

    db.run(
        `INSERT INTO tasks (title, message, file_path, file_name, target_email) VALUES (?, ?, ?, ?, ?)`,
        [fullTitle, message, file_path, file_name, target_email],
        () => res.redirect('/warehouse.html')
    );
});

// [المخزن] جلب الملفات والجهات المتاحة للمخزن
app.get('/warehouse/data', isWarehouse, (req, res) => {
    const userEmail = req.session.user.email;
    const userName = req.session.user.name;

    db.all(`SELECT name, email, role FROM users WHERE email != ?`, [userEmail], (err, recipients) => {
        db.all(
            `SELECT * FROM tasks WHERE target_email = 'all' OR target_email = ? ORDER BY created_at DESC`,
            [userEmail],
            (err, tasks) => {
                res.json({ name: userName, email: userEmail, recipients, tasks });
            }
        );
    });
});

app.listen(PORT, () => {
    console.log(`الموقع يعمل الآن على: http://localhost:${PORT}`);
});