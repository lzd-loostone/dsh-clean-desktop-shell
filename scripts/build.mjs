#!/usr/bin/env node
// Minimal zero-dependency build: copies src → lib and composes the client bundle.
// Real bundling (tsdown/vite) lands with the Electron shell work.
//
// The copy/inline mechanics live in build-lib.mjs so the package regression test
// exercises the exact same composition instead of a second implementation.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLib } from './build-lib.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { files, clientSha256 } = buildLib({ root })
console.log(`[dsh-clean-desktop-shell] built lib/ from src/ (${files.length} files, client sha256 ${clientSha256})`)
