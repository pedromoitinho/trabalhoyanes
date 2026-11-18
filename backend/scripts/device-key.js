import { deviceKey } from '../src/auth.js';

const id = process.argv[2];
const secret = process.env.DEVICE_SHARED_SECRET ?? '';
if (!id || secret.length < 32) {
  console.error('Uso: npm run device-key -- <device_id>   (requer DEVICE_SHARED_SECRET no .env)');
  process.exit(1);
}
console.log(deviceKey(secret, id));
