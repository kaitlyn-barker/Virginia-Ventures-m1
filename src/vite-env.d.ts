/// <reference types="vite/client" />
// Pulls in Vite's ambient types so `import.meta.env` (e.g. `import.meta.env.DEV`)
// is typed. `DEV` is `true` in `vite dev` and statically `false` in `vite build`,
// which lets Rollup dead-code-eliminate the dev-only debug menu from production.
