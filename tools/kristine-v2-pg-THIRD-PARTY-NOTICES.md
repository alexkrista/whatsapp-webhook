# KRISTINE 2.0 isolated preview: bundled PostgreSQL driver

Test-only bundle, built on 2026-10-08 from npm pg@8.16.3 using esbuild@0.25.12, target node20 CJS. No production application modules import this file.
The bundle allows the existing Render preview build command to remain unchanged. The client is only loaded if KRISTINE_V2_TEST_DATABASE_URL is explicitly configured and its exact test identity is validated.

Bundled npm packages:
- pg 8.16.3 – MIT (license text included)
- pg-cloudflare 1.4.1 – MIT (license text included)
- pg-connection-string 2.14.1 – MIT (license text included)
- pg-int8 1.0.1 – ISC (license text included)
- pg-pool 3.14.0 – MIT (license text included)
- pg-protocol 1.16.1 – MIT (license text included)
- pg-types 2.2.0 – MIT (MIT as declared by package metadata)
- pgpass 1.0.5 – MIT (MIT as declared by package metadata)
- postgres-array 2.0.0 – MIT (license text included)
- postgres-bytea 1.0.1 – MIT (license text included)
- postgres-date 1.0.7 – MIT (license text included)
- postgres-interval 1.2.0 – MIT (license text included)
- split2 4.2.0 – ISC (license text included)
- xtend 4.0.2 – MIT (license text included)

No application data or credentials are present in the bundle. External optional pg-native is not bundled. This notice and the preserved package license files accompany the vendored build.

