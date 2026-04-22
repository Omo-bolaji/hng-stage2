
require('dotenv').config()
const { Pool } = require('pg')
const { v7: uuidv7 } = require('uuid')
const fs = require('fs')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function seed() {
  const raw = fs.readFileSync('./seed_profiles.json', 'utf8')
  const { profiles } = JSON.parse(raw)

  console.log(`Seeding ${profiles.length} profiles...`)

  const values = profiles.map(p => [
    uuidv7(), p.name, p.gender, p.gender_probability,
    p.age, p.age_group, p.country_id, p.country_name, p.country_probability
  ])

  const placeholders = values.map((_, i) => {
    const base = i * 9
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`
  }).join(',')

  const flat = values.flat()

  await pool.query(
    `INSERT INTO profiles (id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability)
     VALUES ${placeholders}
     ON CONFLICT (name) DO NOTHING`,
    flat
  )

  console.log('Seeding complete!')
  await pool.end()
}

seed().catch(console.error)