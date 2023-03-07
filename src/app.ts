const express = require('express');
const compression = require('compression');
const app = express();
const path = require('node:path');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const session = require("cookie-session")
const http = require('node:http');
const cluster = require('node:cluster');
const numCPUs = require('node:os').availableParallelism();
const rateLimit = require('express-rate-limit');
const vhost = require('vhost');
const hpp = require('hpp');

// View Engine Setup
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({extended: false}));
app.use(cookieParser());
app.use(compression());
app.disable('x-powered-by');
app.use(hpp());

// Timestamps for Logging
const timestamp = () => { return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''); }

// Logging Setup
const log = {
    info: (message: string) => console.log(`${timestamp()} \x1b[32m${message}\x1b[0m`),
    error: (message: string) => console.error(`${timestamp()} \x1b[31m${message}\x1b[0m`),
    warn: (message: string) => console.warn(`${timestamp()} \x1b[33m${message}\x1b[0m`)
};

// Session Setup
app.use(session({
    secret: 'secret', // !! Change this !!
    cookie : {
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        path: '/',
        domain: '.lillious.com'
    },
    resave: true,
    saveUninitialized: true
}));

app.set('trust proxy', 1);

// Sub Domain Setup and Static Files Setup
app.set('subdomain offset', 1);

// Rate Limiting Setup
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(limiter);

// Server Setup
const port = '80';
app.set('port', port);
const server = http.createServer(app);

// Cluster Setup
if (cluster.isPrimary) {
    // Test Database Connection
    const db = require('./utils/database');
    db.query('SELECT 1 + 1 AS solution', (err: any, rows: any) => {
        if (err) {
            log.error(err);
        }
    }).then(() => {
        log.info(`Database Connection Successful`);
    }).catch((err: any) => {
        log.error(`Database Connection Failed\n${err}`);
    });
    // Fork workers
    log.info(`Primary ${process.pid} is running on port ${port}`);
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }
    // If a worker dies, create a new one to replace it
    cluster.on('exit', (worker: any, code: any, signal: any) => {
        log.error(`worker ${worker.process.pid} died`);
        cluster.fork();
    });
} else {
    server.listen(port, () => {
        log.info(`Worker ${process.pid} started`);
    }).on('error', (error: any) => {
        if (error.syscall !== 'listen') {
            throw error;
        }
        const bind = typeof port === 'string' ?
            'Pipe ' + port :
            'Port ' + port;

        switch (error.code) {
            case 'EACCES':
                log.error(`${bind} requires elevated privileges`);
                process.exit(1);
                break;
            case 'EADDRINUSE':
                log.error(`${bind} is already in use`);
                process.exit(1);
                break;
            default:
                throw error;
        }
    });
}

// Check if the url has repeating slashes at the end of the domain
app.use(function(req: any, res: any, next: any) {
    let url = req.url;
    if (url.match(/\/{2,}$/)) {
        // Remove repeating slashes at the end of the domain
        url = url.replace(/\/{2,}$/g, '/');
        // Redirect to the new url
        res.redirect(`${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}${url}`);
    } else {
        next();
    }
});

/* Start Unsecure Routing */
/* Routes that do not require authentication */

// Login Page
app.use('/login', express.static(path.join(__dirname, '/login'), { maxAge: 31557600 }));

// Home Page
app.use(vhost('*.*', express.static(path.join(__dirname, '/root'), { maxAge: 31557600 })));

// Localhost
app.use(vhost('localhost', express.static(path.join(__dirname, '/root'), { maxAge: 31557600 })));

// Login Post Request
app.post('/login', (req: any, res: any) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const body = req.body;
    if (body.email && body.password) {
        const db = require('./utils/database');
        db.query('SELECT * FROM accounts WHERE email = ? AND password = ?', [body.email.toLowerCase(), hash(body.password)]).then((results: any) => {
            if (results.length > 0) {
                db.query('UPDATE accounts SET lastlogin = ? WHERE email = ?', [new Date(), body.email.toLowerCase()]).catch((err: any) => {
                    log.error(err);
                });
                db.query('DELETE FROM sessions WHERE email = ?', [body.email.toLowerCase()]).then(() => {
                    const session = cryptojs.randomBytes(64).toString('hex');
                    db.query('INSERT INTO sessions (session, email) VALUES (?, ?)', [session, body.email.toLowerCase()]).then(() => {
                        res.cookie('session', session, { maxAge: 86400000, httpOnly: true });
                        log.info(`[LOGIN] ${body.email.toLowerCase()}`);
                        res.redirect('/cpanel');
                    }).catch((err: any) => {
                        log.error(err); 
                    });
                }).catch((err: any) => {
                    log.error(err);
                });
            } else {
                res.redirect('/login');
            }
        }).catch((err: any) => {
            log.error(err);
            res.redirect('/login');
        });
    } else {
        res.redirect(`${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`);
    }
});

/* Start Secure Routing */
/* Routes that require authentication */

app.use(function(req: any, res: any, next: any) {
    const authentication = require('./utils/authentication');
    if (!req.cookies.session) return res.redirect('/login');
    authentication.checkSession(req.cookies.session).then((email: string) => {
        res.cookie('email', email, { maxAge: 86400000, httpOnly: true });
        next();
    }).catch((err: any) => {
        log.error(err);
        res.redirect('/login');
    });
});

app.post('/logout', (req: any, res: any, next: any) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.cookies.session) {
        const db = require('./utils/database');
        db.query('DELETE FROM sessions WHERE session = ?', [req.cookies.session]).then(() => {
            log.error(`[LOGOUT] ${req.cookies.email}`);
            res.clearCookie('session');
            res.clearCookie('email');
            res.redirect('/login');
        }).catch((err: any) => {
            log.error(err);
            res.redirect('/login');
        });
    } else {
        res.redirect('/login');
    }
});

app.use('/cpanel', express.static(path.join(__dirname, '/cpanel'), { maxAge: 31557600 }));

// API
app.get('/api', (req: any, res: any) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    console.log(req.cookies.session);
    res.status(200).send('OK');
});

app.get('/api/@me', (req: any, res: any) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const db = require('./utils/database');
    db.query('SELECT email FROM accounts WHERE email = ?', [req.cookies.email]).then((results: any) => {
        if (results.length > 0) {
            res.status(200).send(results[0]);
        } else {
            res.status(404).send('Not Found');
        }
    }).catch((err: any) => {
        log.error(err);
        res.status(500).send('Internal Server Error');
    });
});

// Redirect to root domain if route is not found
app.use(function(req: any, res: any, next: any) {
    // Check if it is a subdomain
    if (req.subdomains.length > 0) return next();
    res.redirect(`${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`);
});

// Crypto Setup
const cryptojs = require('node:crypto');
function hash(password: string) {
    const [hashedPassword, numberValue, sum] = getHash(password);
    const hash = cryptojs.createHash('sha512')
        .update(sum + hashedPassword)
        .digest('hex');
    const middle = Math.ceil(hash.length / 2);
    const prefix = hash.slice(0, middle);
    const suffix = hash.slice(middle);
    const salt = cryptojs.createHash('sha512')
        .update(prefix + numberValue)
        .digest('hex')
    const result = `L${salt}A${prefix}P${hashedPassword}Y${suffix}X`;
    return result;
}

function getHash(password: string) {
    const hash = cryptojs.createHash('sha512')
        .update(password)
        .digest('hex');
    let numberValue = hash.replace(/[a-z]/g, '');
    Array.from(numberValue);
    numberValue = Object.assign([], numberValue);
    const sum = numberValue.reduce((acc: string, curr: string, i: number)  => acc + i, 0  )
    return [hash, numberValue, sum];
}