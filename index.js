require('dotenv').config()

const express = require('express')
const { Pool } = require('pg')
const { v7: uuidv7 } = require('uuid')
const cookieParser = require('cookie-parser')
const rateLimit = require('express-rate-limit')
const { router: authRouter, initAuthDB } = require('./auth')
const { authenticate } = require('./middleware/auth')
const { requireRole } = require('./middleware/rbac')

const app = express()
app.use(express.json())
app.use(cookieParser())

// --- CORS ---
app.use((req, res, next) => {
  const allowedOrigins = [process.env.WEB_PORTAL_URL, 'http://localhost:3001']
  const origin = req.headers.origin
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// --- Request Logger ---
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms ${req.user?.sub || 'unauthenticated'}`)
  })
  next()
})

// --- Rate Limiting ---
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests, please try again later' }
})
app.use('/api/', limiter)

// --- CSRF Protection (web only) ---
function csrfProtect(req, res, next) {
  // Skip CSRF for CLI requests (they use Bearer tokens, not cookies)
  if (req.headers['authorization']) return next()
  
  const csrfToken = req.headers['x-csrf-token']
  const cookieToken = req.cookies['csrf_token']
  
  if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
    return res.status(403).json({ status: 'error', message: 'Invalid CSRF token' })
  }
  next()
}

// Generate CSRF token endpoint (web calls this on load)
app.get('/api/csrf-token', (req, res) => {
  const token = require('crypto').randomBytes(32).toString('hex')
  res.cookie('csrf_token', token, {
    httpOnly: false, // JS needs to read this
    secure: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 1000
  })
  return res.json({ csrf_token: token })
})

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name VARCHAR UNIQUE NOT NULL,
      gender VARCHAR,
      gender_probability FLOAT,
      age INT,
      age_group VARCHAR,
      country_id VARCHAR(2),
      country_name VARCHAR,
      country_probability FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
}

function parseNaturalQuery(q) {
  const query = q.toLowerCase()
  const filters = {}

  if (/\bmales?\b/.test(query) && !/females?/.test(query)) filters.gender = 'male'
  if (/\bfemales?\b/.test(query) && !/\bmales?\b/.test(query)) filters.gender = 'female'

  if (/\byoung\b/.test(query)) { filters.min_age = 16; filters.max_age = 24 }
  if (/\bold\b/.test(query)) filters.min_age = 60
  if (/above (\d+)/.test(query)) filters.min_age = parseInt(query.match(/above (\d+)/)[1])
  if (/below (\d+)/.test(query)) filters.max_age = parseInt(query.match(/below (\d+)/)[1])
  if (/older than (\d+)/.test(query)) filters.min_age = parseInt(query.match(/older than (\d+)/)[1])
  if (/younger than (\d+)/.test(query)) filters.max_age = parseInt(query.match(/younger than (\d+)/)[1])
  if (/over (\d+)/.test(query)) filters.min_age = parseInt(query.match(/over (\d+)/)[1])
  if (/under (\d+)/.test(query)) filters.max_age = parseInt(query.match(/under (\d+)/)[1])

  if (/\bchildren\b|\bchild\b/.test(query)) filters.age_group = 'child'
  if (/\bteenagers?\b/.test(query)) filters.age_group = 'teenager'
  if (/\badults?\b/.test(query)) filters.age_group = 'adult'
  if (/\bseniors?\b/.test(query)) filters.age_group = 'senior'

  const countryMap = {
    'nigeria': 'NG', 'ghana': 'GH', 'kenya': 'KE', 'tanzania': 'TZ',
    'ethiopia': 'ET', 'uganda': 'UG', 'angola': 'AO', 'cameroon': 'CM',
    'senegal': 'SN', 'mali': 'ML', 'zambia': 'ZM', 'mozambique': 'MZ',
    'madagascar': 'MG', 'ivory coast': 'CI', 'burkina faso': 'BF',
    'niger': 'NE', 'malawi': 'MW', 'somalia': 'SO', 'zimbabwe': 'ZW',
    'south africa': 'ZA', 'egypt': 'EG', 'morocco': 'MA', 'algeria': 'DZ',
    'tunisia': 'TN', 'libya': 'LY', 'sudan': 'SD', 'benin': 'BJ',
    'togo': 'TG', 'rwanda': 'RW', 'burundi': 'BI', 'congo': 'CG',
    'drc': 'CD', 'chad': 'TD', 'guinea': 'GN', 'sierra leone': 'SL',
    'liberia': 'LR', 'gambia': 'GM', 'mauritania': 'MR'
  }

  for (const [countryName, code] of Object.entries(countryMap)) {
    if (query.includes(countryName)) { filters.country_id = code; break }
  }

  if (Object.keys(filters).length === 0) return null
  return filters
}

// --- Auth routes ---
app.use('/auth', authRouter)

// --- API v1 Routes ---
const v1 = express.Router()

// All v1 routes require authentication
v1.use(authenticate)

// GET /api/v1/profiles — analysts + admins
v1.get('/profiles', requireRole('admin', 'analyst'), async (req, res) => {
  try {
    const validParams = ['gender', 'age_group', 'country_id', 'min_age', 'max_age',
      'min_gender_probability', 'min_country_probability', 'sort_by', 'order', 'page', 'limit']

    const invalidParams = Object.keys(req.query).filter(k => !validParams.includes(k))
    if (invalidParams.length > 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid query parameters' })
    }

    const conditions = []
    const params = []

    if (req.query.gender) { params.push(req.query.gender.toLowerCase()); conditions.push(`LOWER(gender) = $${params.length}`) }
    if (req.query.age_group) { params.push(req.query.age_group.toLowerCase()); conditions.push(`LOWER(age_group) = $${params.length}`) }
    if (req.query.country_id) { params.push(req.query.country_id.toUpperCase()); conditions.push(`UPPER(country_id) = $${params.length}`) }
    if (req.query.min_age) { params.push(parseInt(req.query.min_age)); conditions.push(`age >= $${params.length}`) }
    if (req.query.max_age) { params.push(parseInt(req.query.max_age)); conditions.push(`age <= $${params.length}`) }
    if (req.query.min_gender_probability) { params.push(parseFloat(req.query.min_gender_probability)); conditions.push(`gender_probability >= $${params.length}`) }
    if (req.query.min_country_probability) { params.push(parseFloat(req.query.min_country_probability)); conditions.push(`country_probability >= $${params.length}`) }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const allowedSortFields = ['age', 'created_at', 'gender_probability']
    const sortBy = allowedSortFields.includes(req.query.sort_by) ? req.query.sort_by : 'created_at'
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC'

    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10))
    const offset = (page - 1) * limit

    const countResult = await pool.query(`SELECT COUNT(*) FROM profiles ${whereClause}`, params)
    const total = parseInt(countResult.rows[0].count)
    const total_pages = Math.ceil(total / limit)

    params.push(limit)
    params.push(offset)
    const dataResult = await pool.query(
      `SELECT * FROM profiles ${whereClause} ORDER BY ${sortBy} ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    return res.status(200).json({
      status: 'success',
      pagination: {
        page,
        limit,
        total,
        total_pages,
        has_next: page < total_pages,
        has_prev: page > 1
      },
      data: dataResult.rows
    })

  } catch (error) {
    console.error(error)
    return res.status(500).json({ status: 'error', message: 'Internal server error' })
  }
})

// GET /api/v1/profiles/export — CSV export (admin only)
v1.get('/profiles/export', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM profiles ORDER BY created_at DESC')
    const rows = result.rows

    const headers = ['id', 'name', 'gender', 'gender_probability', 'age', 'age_group', 'country_id', 'country_name', 'country_probability', 'created_at']
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))
    ].join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="profiles.csv"')
    return res.send(csv)

  } catch (error) {
    console.error(error)
    return res.status(500).json({ status: 'error', message: 'Internal server error' })
  }
})

// GET /api/v1/profiles/search
v1.get('/profiles/search', requireRole('admin', 'analyst'), async (req, res) => {
  try {
    const q = req.query.q
    if (!q || q.trim() === '') {
      return res.status(400).json({ status: 'error', message: 'Missing or empty query' })
    }

    const filters = parseNaturalQuery(q)
    if (!filters) {
      return res.status(400).json({ status: 'error', message: 'Unable to interpret query' })
    }

    const conditions = []
    const params = []

    if (filters.gender) { params.push(filters.gender); conditions.push(`LOWER(gender) = $${params.length}`) }
    if (filters.age_group) { params.push(filters.age_group); conditions.push(`LOWER(age_group) = $${params.length}`) }
    if (filters.country_id) { params.push(filters.country_id); conditions.push(`UPPER(country_id) = $${params.length}`) }
    if (filters.min_age) { params.push(filters.min_age); conditions.push(`age >= $${params.length}`) }
    if (filters.max_age) { params.push(filters.max_age); conditions.push(`age <= $${params.length}`) }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10))
    const offset = (page - 1) * limit

    const countResult = await pool.query(`SELECT COUNT(*) FROM profiles ${whereClause}`, params)
    const total = parseInt(countResult.rows[0].count)
    const total_pages = Math.ceil(total / limit)

    params.push(limit)
    params.push(offset)
    const dataResult = await pool.query(
      `SELECT * FROM profiles ${whereClause} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    return res.status(200).json({
      status: 'success',
      pagination: {
        page,
        limit,
        total,
        total_pages,
        has_next: page < total_pages,
        has_prev: page > 1
      },
      data: dataResult.rows
    })

  } catch (error) {
    console.error(error)
    return res.status(500).json({ status: 'error', message: 'Internal server error' })
  }
})

// GET /api/v1/profiles/:id
v1.get('/profiles/:id', requireRole('admin', 'analyst'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM profiles WHERE id = $1', [req.params.id])
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Profile not found' })
    }
    return res.status(200).json({ status: 'success', data: result.rows[0] })
  } catch (error) {
    return res.status(500).json({ status: 'error', message: 'Internal server error' })
  }
})

// GET /api/v1/me — get current user info
v1.get('/me', async (req, res) => {
  return res.json({ status: 'success', data: { id: req.user.sub, role: req.user.role, github_id: req.user.github_id } })
})

app.use('/api/v1', v1)

// --- Health check (public) ---
app.get('/health', (req, res) => res.json({ status: 'ok' }))

const PORT = process.env.PORT || 3000
async function start() {
  await initDB()
  await initAuthDB()
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
}
start().catch(console.error)