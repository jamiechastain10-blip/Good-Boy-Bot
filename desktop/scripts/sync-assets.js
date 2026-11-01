/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 * Copies the logo from the dashboard into the desktop window, so both always show the same one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, '..', '..', 'src', 'dashboard', 'public', 'good-boy-logo.png');
if (!fs.existsSync(from)) { console.error(`Missing ${from}. Run this from inside the full Good Boy project.`); process.exit(1); }
fs.copyFileSync(from, path.resolve(here, '..', 'renderer', 'good-boy-logo.png'));
console.log('Logo copied into desktop/renderer.');
