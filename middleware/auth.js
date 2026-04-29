// middleware/auth.js
const jwt = require('jsonwebtoken')

function authenticate(req, res, next) {
  // Accept token from cookie (web) or Authorization header (CLI)
  let token = req.cookies?.access_token

  if (!token) {
    const authHeader = req.headers['authorization']
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7)
    }
  }

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' })
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = payload
    next()
  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'Invalid or expired token' })
  }
}

module.exports = { authenticate }