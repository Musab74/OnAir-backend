


npm install --legacy-peer-deps
npm run build

# 4) Restart PM2 from the SAME folder so the app sees .env in its CWD
pm2 delete onair-backend
pm2 start dist/main.js --name onair-backend
pm2 save
