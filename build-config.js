const fs = require('fs');

const key = process.env.LUXSYNC_API_KEY || '';
fs.writeFileSync('config.js', `window.LUXSYNC_API_KEY = ${JSON.stringify(key)};\n`);
