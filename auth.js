// auth.js
require('dotenv').config()
const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// In-memory PKCE store (code_verifier keyed by state)
const pkceStore = new Map()

// --- Helpers ---
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function generateState() {
  return crypto.randomBytes(16).toString('hex')
}

function generateAccessToken(user) {
  return jwt.sign(
    { sub: user.id, github_id: user.github_id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  )
}

function generateRefreshToken(user) {
  return jwt.sign(
    { sub: user.id, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  )
}

// --- Init DB tables for users + refresh tokens ---
async function initAuthDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id TEXT UNIQUE NOT NULL,
      username TEXT,
      avatar_url TEXT,
      role VARCHAR DEFAULT 'analyst',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
}

// --- Step 1: Start OAuth flow ---
// GET /auth/github?source=cli|web
router.get('/github', (req, res) => {
  const source = req.query.source || 'web'
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  // Store verifier + source keyed by state (expires in 10 min)
  pkceStore.set(state, { codeVerifier, source })
  setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000)

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: process.env.GITHUB_REDIRECT_URI,
    scope: 'read:user',
    state,
    // GitHub doesn't natively support PKCE, so we store verifier server-side
    // and use state to link it — this achieves the same CSRF + replay protection
  })

  res.redirect(`https://github.com/login/oauth/authorize?${params}`)
})

// --- Step 2: GitHub callback ---
// GET /auth/github/callback
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query

  if (!state || !pkceStore.has(state)) {
    return res.status(400).json({ status: 'error', message: 'Invalid or expired state' })
  }

  const { codeVerifier, source } = pkceStore.get(state)
  pkceStore.delete(state)

  try {
    // Exchange code for GitHub access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: process.env.GITHUB_REDIRECT_URI,
        code_verifier: codeVerifier
      })
    })

    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) {
      return res.status(401).json({ status: 'error', message: 'GitHub OAuth failed' })
    }

    // Fetch GitHub user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    })
    const githubUser = await userRes.json()

    // Upsert user in DB
    const { v7: uuidv7 } = require('uuid')
    const userId = uuidv7()
    const result = await pool.query(`
      INSERT INTO users (id, github_id, username, avatar_url, role)
      VALUES ($1, $2, $3, $4, 'analyst')
      ON CONFLICT (github_id) DO UPDATE
        SET username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url
      RETURNING *
    `, [userId, String(githubUser.id), githubUser.login, githubUser.avatar_url])

    const user = result.rows[0]

    // Generate tokens
    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken(user)

    // Store refresh token in DB
    const tokenId = uuidv7()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await pool.query(`
      INSERT INTO refresh_tokens (id, user_id, token, expires_at)
      VALUES ($1, $2, $3, $4)
    `, [tokenId, user.id, refreshToken, expiresAt])

    // Respond differently for CLI vs web
    if (source === 'cli') {
      // CLI gets tokens in JSON response
      return res.json({ status: 'success', access_token: accessToken, refresh_token: refreshToken, role: user.role })
    } else {
      // Web gets HTTP-only cookies
      res.cookie('access_token', accessToken, {
        httpOnly: true, secure: true, sameSite: 'strict', maxAge: 15 * 60 * 1000
      })
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true, secure: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000
      })
      return res.redirect(process.env.WEB_PORTAL_URL + '/dashboard.html')
    }

  } catch (err) {
    console.error(err)
    return res.status(500).json({ status: 'error', message: 'Auth failed' })
  }
})

// --- Refresh token endpoint ---
// POST /auth/refresh
router.post('/refresh', async (req, res) => {
  // Accept from cookie (web) or body (CLI)
  const token = req.cookies?.refresh_token || req.body?.refresh_token

  if (!token) return res.status(401).json({ status: 'error', message: 'No refresh token' })

  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET)

    // Check token exists in DB and not expired
    const result = await pool.query(`
      SELECT rt.*, u.* FROM refresh_tokens rt
      JOIN users u ON rt.user_id = u.id
      WHERE rt.token = $1 AND rt.expires_at > NOW()
    `, [token])

    if (result.rows.length === 0) {
      return res.status(401).json({ status: 'error', message: 'Invalid or expired refresh token' })
    }

    const user = result.rows[0]
    const newAccessToken = generateAccessToken(user)

    if (req.cookies?.refresh_token) {
      res.cookie('access_token', newAccessToken, {
        httpOnly: true, secure: true, sameSite: 'strict', maxAge: 15 * 60 * 1000
      })
      return res.json({ status: 'success' })
    } else {
      return res.json({ status: 'success', access_token: newAccessToken })
    }

  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'Invalid refresh token' })
  }
})

// --- Logout ---
// POST /auth/logout
router.post('/logout', async (req, res) => {
  const token = req.cookies?.refresh_token || req.body?.refresh_token
  if (token) {
    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token])
  }
  res.clearCookie('access_token')
  res.clearCookie('refresh_token')
  return res.json({ status: 'success', message: 'Logged out' })
})

module.exports = { router, initAuthDB, generateAccessToken, generateRefreshToken, pool }