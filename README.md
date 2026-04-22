# HNG Stage 2 - Intelligence Query Engine

A demographic intelligence REST API with advanced filtering, sorting, pagination, and natural language search.

## Endpoints

- GET /api/profiles — Get all profiles with filtering, sorting, pagination
- GET /api/profiles/search?q= — Natural language search
- GET /api/profiles/:id — Get single profile

## Filtering Parameters

gender, age_group, country_id, min_age, max_age, min_gender_probability, min_country_probability, sort_by, order, page, limit

## Natural Language Parsing Approach

The parser uses regex and keyword matching to convert plain English into filters.

Supported keywords:
- Gender: "male", "males", "female", "females"
- Age ranges: "young" (16-24), "old" (60+), "above N", "below N", "over N", "under N", "older than N", "younger than N"
- Age groups: "child", "children", "teenager", "adult", "senior"
- Countries: full country names e.g. "nigeria" → NG, "kenya" → KE, "ghana" → GH (37 countries supported)

Examples:
- "young males from nigeria" → gender=male, min_age=16, max_age=24, country_id=NG
- "females above 30" → gender=female, min_age=30
- "adult males from kenya" → gender=male, age_group=adult, country_id=KE
- "seniors from ghana" → age_group=senior, country_id=GH

## Limitations

- Country matching is name-based only, not by demonym (e.g. "Nigerian" won't work, use "nigeria")
- "young" is a parsing keyword only, not a stored age group
- Queries with no recognizable keywords return "Unable to interpret query"
- Does not support complex boolean logic like "males from nigeria or ghana"
- Country list covers 37 African/common countries only